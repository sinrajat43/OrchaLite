const FIELDS = [
  { name: 'second', min: 0, max: 59 },
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
];

export interface CronSchedule {
  seconds: Set<number>;
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** Standard cron: when both day fields are restricted, either one matching is enough */
  daysRestricted: boolean;
  weekdaysRestricted: boolean;
  everySecond: boolean;
}

function parseField(text: string, { name, min, max }: (typeof FIELDS)[number]): Set<number> {
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new Error(`Invalid ${name} "${part}"`);
    const [, range, stepText] = match;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (step < 1) throw new Error(`Invalid ${name} step in "${part}"`);
    let from = min;
    let to = max;
    if (range !== '*') {
      const [start, end] = range.split('-').map(Number);
      from = start;
      // "5/10" means from 5 to the end, stepping by 10
      to = end ?? (stepText === undefined ? start : max);
    }
    if (from < min || to > max || from > to) throw new Error(`${name} "${part}" is out of range ${min}-${max}`);
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
}

/**
 * Parses a cron expression, in UTC: "minute hour day month weekday", with an
 * optional seconds field in front. Supports *, lists, ranges and steps.
 * @throws Error saying what is wrong
 */
export function parseCron(expression: string): CronSchedule {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5 && parts.length !== 6) {
    throw new Error(`Expected 5 fields, or 6 with seconds, but got ${parts.length}`);
  }
  const hasSeconds = parts.length === 6;
  const [seconds, minutes, hours, days, months, weekdays] = (hasSeconds ? parts : ['0', ...parts]).map((text, i) => parseField(text, FIELDS[i]));
  if (weekdays.delete(7)) weekdays.add(0);
  const offset = hasSeconds ? 0 : 1;
  const schedule: CronSchedule = {
    seconds,
    minutes,
    hours,
    days,
    months,
    weekdays,
    daysRestricted: parts[3 - offset] !== '*',
    weekdaysRestricted: parts[5 - offset] !== '*',
    everySecond: hasSeconds,
  };
  if (!nextAfter(schedule, new Date(0))) throw new Error('This schedule never fires');
  return schedule;
}

const dayMatches = (s: CronSchedule, date: Date): boolean => {
  const day = s.days.has(date.getUTCDate());
  const weekday = s.weekdays.has(date.getUTCDay());
  return s.daysRestricted && s.weekdaysRestricted ? day || weekday : day && weekday;
};

/** The first time after the given one that the schedule fires, or null within 5 years */
export function nextAfter(s: CronSchedule, after: Date): Date | null {
  const t = new Date(after.getTime());
  t.setUTCMilliseconds(0);
  t.setUTCSeconds(t.getUTCSeconds() + 1);
  const limit = after.getTime() + 5 * 366 * 24 * 60 * 60 * 1000;

  // Jump to the start of the next unit whenever a larger field does not match
  while (t.getTime() <= limit) {
    if (!s.months.has(t.getUTCMonth() + 1)) {
      t.setUTCMonth(t.getUTCMonth() + 1, 1);
      t.setUTCHours(0, 0, 0, 0);
    } else if (!dayMatches(s, t)) {
      t.setUTCDate(t.getUTCDate() + 1);
      t.setUTCHours(0, 0, 0, 0);
    } else if (!s.hours.has(t.getUTCHours())) {
      t.setUTCHours(t.getUTCHours() + 1, 0, 0, 0);
    } else if (!s.minutes.has(t.getUTCMinutes())) {
      t.setUTCMinutes(t.getUTCMinutes() + 1, 0, 0);
    } else if (!s.seconds.has(t.getUTCSeconds())) {
      t.setUTCSeconds(t.getUTCSeconds() + 1, 0);
    } else {
      return t;
    }
  }
  return null;
}
