import { Attributes, Context, ROOT_CONTEXT, Span, SpanStatusCode, TraceFlags, trace, Tracer } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import {
  BasicTracerProvider, BatchSpanProcessor, ConsoleSpanExporter, IdGenerator, InMemorySpanExporter, RandomIdGenerator, ReadableSpan, SimpleSpanProcessor, SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { createHash } from 'crypto';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import { TaskLogger } from '../tasks/task.interface';

/** Nest injection token for Telemetry */
export const TELEMETRY = Symbol('TELEMETRY');

export type StepOutcome = 'succeeded' | 'failed' | 'dead_lettered' | 'retried' | 'waiting' | 'rate_limited' | 'cancelled' | 'requeued' | 'lease_lost';

export interface StepIdentity {
  runId: string;
  stepId: string;
  task: string;
  index?: number;
  attempt?: number;
  compensation?: boolean;
  workerId?: string;
}

/** Spans for one attempt at a step */
export interface StepSpan {
  end(outcome: StepOutcome, error?: string): void;
}

export interface RunEnding {
  runId: string;
  name: string;
  status: string;
  startedAt: Date;
  endedAt?: Date;
  failedStepId?: string;
  error?: string;
}

/**
 * What the engine reports about itself. Tests and embedded runs use noTelemetry.
 */
export interface Telemetry {
  logger(fields: Record<string, unknown>): TaskLogger;
  startStep(step: StepIdentity): StepSpan;
  runEnded(run: RunEnding): void;
  /** Prometheus text, for /metrics */
  metrics(): Promise<string>;
  /** Called at each scrape to read gauges from the database */
  onCollect(collect: () => Promise<GaugeValues>): void;
  shutdown(): Promise<void>;
}

export interface GaugeValues {
  queue: { ready: number; delayed: number; leased: number };
  activeRuns: number;
}

const quietLogger: TaskLogger = { log: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

export const noTelemetry: Telemetry = {
  logger: () => quietLogger,
  startStep: () => ({ end: () => undefined }),
  runEnded: () => undefined,
  metrics: async () => '',
  onCollect: () => undefined,
  shutdown: async () => undefined,
};

/**
 * A run's trace id comes from its id, so spans from any process, with nothing
 * passed between them, end up in the same trace
 */
export const traceIdOf = (runId: string): string => createHash('sha256').update(`trace:${runId}`).digest('hex').slice(0, 32);
const runSpanIdOf = (runId: string): string => createHash('sha256').update(`span:${runId}`).digest('hex').slice(0, 16);

/** Random ids, except for the one span that must have a chosen id: a run's own */
class RunIdGenerator implements IdGenerator {
  private readonly random = new RandomIdGenerator();
  next?: { traceId: string; spanId: string };

  generateTraceId = (): string => this.next?.traceId ?? this.random.generateTraceId();
  generateSpanId = (): string => this.next?.spanId ?? this.random.generateSpanId();
}

/** Spans kept in memory when ORCHALITE_TRACES=memory, for tests */
let memoryExporter: InMemorySpanExporter | undefined;
export const memorySpans = (): ReadableSpan[] => memoryExporter?.getFinishedSpans() ?? [];

function spanProcessor(mode: string | undefined): SpanProcessor | undefined {
  switch (mode) {
    case 'otlp':
      // The endpoint comes from the standard OTEL_EXPORTER_OTLP_ENDPOINT
      return new BatchSpanProcessor(new OTLPTraceExporter());
    case 'console':
      return new SimpleSpanProcessor(new ConsoleSpanExporter());
    case 'memory':
      memoryExporter ??= new InMemorySpanExporter();
      return new SimpleSpanProcessor(memoryExporter);
    case undefined:
    case '':
      return undefined;
    default:
      throw new Error(`ORCHALITE_TRACES: unknown exporter "${mode}"; use otlp, console or memory`);
  }
}

/**
 * Structured logs, OpenTelemetry traces and Prometheus metrics. Every log line
 * and span carries the run and step ids, and the same trace id, so one failed
 * run can be followed from any of them to the others.
 */
export class EngineTelemetry implements Telemetry {
  private readonly ids = new RunIdGenerator();
  private readonly provider?: BasicTracerProvider;
  private readonly tracer?: Tracer;
  private readonly registry = new Registry();
  private readonly stepDuration: Histogram<string>;
  private readonly stepAttempts: Counter<string>;
  private readonly runsEnded: Counter<string>;
  private collect?: () => Promise<GaugeValues>;

  constructor(tracesMode = process.env.ORCHALITE_TRACES) {
    const processor = spanProcessor(tracesMode);
    if (processor) {
      this.provider = new BasicTracerProvider({
        idGenerator: this.ids,
        resource: new Resource({ 'service.name': 'orchalite' }),
        spanProcessors: [processor],
      });
      this.tracer = this.provider.getTracer('orchalite');
    }

    const registers = [this.registry];
    this.stepDuration = new Histogram({
      name: 'orchalite_step_duration_seconds',
      help: 'How long one attempt at a step took',
      labelNames: ['task', 'outcome'],
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 15, 60, 300],
      registers,
    });
    this.stepAttempts = new Counter({
      name: 'orchalite_step_attempts_total',
      help: 'Attempts at a step by how they ended; the retry rate is outcome="retried" over the total',
      labelNames: ['task', 'outcome'],
      registers,
    });
    this.runsEnded = new Counter({ name: 'orchalite_runs_ended_total', help: 'Runs that ended, by status', labelNames: ['status'], registers });

    const read = async (set: (values: GaugeValues) => void) => {
      if (this.collect) set(await this.collect());
    };
    new Gauge({
      name: 'orchalite_queue_depth',
      help: 'Jobs in the step queue: ready to claim, delayed until later, or leased to a worker',
      labelNames: ['state'],
      registers,
      async collect() {
        await read(({ queue }) => Object.entries(queue).forEach(([state, depth]) => this.set({ state }, depth)));
      },
    });
    new Gauge({
      name: 'orchalite_runs_active',
      help: 'Runs that have not ended',
      registers,
      async collect() {
        await read(({ activeRuns }) => this.set(activeRuns));
      },
    });
  }

  onCollect(collect: () => Promise<GaugeValues>): void {
    this.collect = collect;
  }

  metrics(): Promise<string> {
    return this.registry.metrics();
  }

  async shutdown(): Promise<void> {
    await this.provider?.shutdown();
  }

  /** One JSON object per line, carrying the given fields */
  logger(fields: Record<string, unknown>): TaskLogger {
    const correlated = typeof fields.runId === 'string' ? { traceId: traceIdOf(fields.runId), ...fields } : fields;
    const write = (level: string, message: unknown, sink: (line: string) => void) =>
      sink(JSON.stringify({ time: new Date().toISOString(), level, message: String(message), ...correlated }));
    return {
      log: message => write('info', message, console.log),
      debug: message => write('debug', message, console.log),
      warn: message => write('warn', message, console.warn),
      error: message => write('error', message, console.error),
    };
  }

  startStep({ runId, stepId, task, index, attempt, compensation, workerId }: StepIdentity): StepSpan {
    const started = process.hrtime.bigint();
    const attributes: Attributes = {
      'run.id': runId,
      'step.id': stepId,
      'task.name': task,
      ...(index === undefined ? {} : { 'step.index': index }),
      ...(attempt === undefined ? {} : { 'step.attempt': attempt }),
      ...(compensation ? { 'step.compensation': true } : {}),
      ...(workerId ? { 'worker.id': workerId } : {}),
    };
    const name = `${compensation ? 'compensate' : 'step'} ${stepId}${index === undefined ? '' : `[${index}]`}`;
    const span: Span | undefined = this.tracer?.startSpan(name, { attributes }, this.runContext(runId));

    return {
      end: (outcome, error) => {
        const seconds = Number(process.hrtime.bigint() - started) / 1e9;
        this.stepDuration.observe({ task, outcome }, seconds);
        this.stepAttempts.inc({ task, outcome });
        if (!span) return;
        span.setAttribute('step.outcome', outcome);
        if (error) {
          span.setAttribute('error.message', error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: error });
        }
        span.end();
      },
    };
  }

  runEnded({ runId, name, status, startedAt, endedAt, failedStepId, error }: RunEnding): void {
    this.runsEnded.inc({ status });
    if (!this.tracer) return;
    // The id is chosen so that the run's step spans, already ended elsewhere, have this as their parent
    this.ids.next = { traceId: traceIdOf(runId), spanId: runSpanIdOf(runId) };
    const span = this.tracer.startSpan(
      `run ${name}`,
      {
        root: true,
        startTime: new Date(startedAt),
        attributes: { 'run.id': runId, 'run.status': status, ...(failedStepId ? { 'run.failed_step': failedStepId } : {}) },
      },
      ROOT_CONTEXT
    );
    this.ids.next = undefined;
    if (error) span.setStatus({ code: SpanStatusCode.ERROR, message: error });
    span.end(endedAt ? new Date(endedAt) : undefined);
  }

  /** A context whose parent is the run's span, whichever process ends up writing that */
  private runContext(runId: string): Context {
    return trace.setSpanContext(ROOT_CONTEXT, { traceId: traceIdOf(runId), spanId: runSpanIdOf(runId), traceFlags: TraceFlags.SAMPLED, isRemote: true });
  }
}
