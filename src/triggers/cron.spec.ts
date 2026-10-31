import { nextAfter, parseCron } from './cron';

const next = (expression: string, after: string) => nextAfter(parseCron(expression), new Date(after))?.toISOString();

describe('cron', () => {
  it.each([
    ['* * * * *', '2026-01-01T10:00:30Z', '2026-01-01T10:01:00.000Z'],
    ['*/15 * * * *', '2026-01-01T10:01:00Z', '2026-01-01T10:15:00.000Z'],
    ['0 9 * * *', '2026-01-01T09:00:00Z', '2026-01-02T09:00:00.000Z'],
    ['0 9 * * 1-5', '2026-01-02T10:00:00Z', '2026-01-05T09:00:00.000Z'],
    ['0 0 1 * *', '2026-01-15T00:00:00Z', '2026-02-01T00:00:00.000Z'],
    ['0 0 29 2 *', '2026-03-01T00:00:00Z', '2028-02-29T00:00:00.000Z'],
    ['30 8,20 * * 7', '2026-01-01T00:00:00Z', '2026-01-04T08:30:00.000Z'],
    ['*/5 * * * * *', '2026-01-01T10:00:01Z', '2026-01-01T10:00:05.000Z'],
    ['5/20 * * * *', '2026-01-01T10:06:00Z', '2026-01-01T10:25:00.000Z'],
  ])('%s after %s is %s', (expression, after, expected) => {
    expect(next(expression, after)).toBe(expected);
  });

  it('fires on either day field when both are restricted, as cron does', () => {
    expect(next('0 0 13 * 5', '2026-01-02T00:00:00Z')).toBe('2026-01-09T00:00:00.000Z');
    expect(next('0 0 13 * 5', '2026-01-10T00:00:00Z')).toBe('2026-01-13T00:00:00.000Z');
  });

  it.each([
    ['* * *', 'Expected 5 fields'],
    ['60 * * * *', 'out of range'],
    ['* 24 * * *', 'out of range'],
    ['nope * * * *', 'Invalid minute'],
    ['*/0 * * * *', 'step'],
    ['5-1 * * * *', 'out of range'],
    ['0 0 31 2 *', 'never fires'],
  ])('rejects %s', (expression, message) => {
    expect(() => parseCron(expression)).toThrow(message);
  });
});
