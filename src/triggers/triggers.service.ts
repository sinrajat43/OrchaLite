import {
  BadRequestException, BeforeApplicationShutdown, Inject, Injectable, NotFoundException, OnApplicationBootstrap, ServiceUnavailableException, UnauthorizedException,
} from '@nestjs/common';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { SECRET_KEY_ENV, SecretBox } from '../connections/secret-box';
import { DefinitionStore } from '../definitions/definition-store.service';
import { ENGINE_OPTIONS, EngineOptions } from '../engine/engine-options';
import { compileTemplate, resolveTemplate } from '../expressions/template';
import { LeaderState } from '../engine/leader-state';
import { AcceptedRun, WorkflowService } from '../workflows/workflow.service';
import { nextAfter, parseCron } from './cron';
import { Trigger, TriggerStore } from './trigger-store.service';

export interface PutTrigger {
  type: 'cron' | 'webhook';
  workflow: string;
  version?: number;
  input?: Record<string, unknown>;
  cron?: string;
  secret?: string;
  enabled?: boolean;
}

/** What the API shows: never the signing secret */
export type TriggerView = Omit<Trigger, 'secret'>;

export const SIGNATURE_HEADER = 'x-orchalite-signature';
export const TIMESTAMP_HEADER = 'x-orchalite-timestamp';
export const DELIVERY_HEADER = 'x-orchalite-delivery';

/** A captured delivery can only be replayed for this long */
const SIGNATURE_TOLERANCE_MS = 5 * 60_000;
const CRON_CHECK_MS = 250;

const view = ({ secret, ...trigger }: Trigger): TriggerView => trigger;
const secretContext = (name: string) => `trigger:${name}`;

/** The signature a sender computes over a delivery */
export function signDelivery(secret: string, timestamp: string, rawBody: Buffer | string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex')}`;
}

/**
 * Starts runs from outside: on a cron schedule, or from a signed webhook delivery.
 * Both pass an idempotency key, so a firing or delivery that happens twice is one run.
 */
@Injectable()
export class TriggersService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private firing?: Promise<void>;
  private readonly box = SecretBox.fromEnv();

  constructor(
    private readonly store: TriggerStore,
    private readonly definitions: DefinitionStore,
    private readonly workflows: WorkflowService,
    private readonly leader: LeaderState,
    @Inject(ENGINE_OPTIONS) private readonly options: EngineOptions
  ) {}

  onApplicationBootstrap(): void {
    if (!this.options.roles.includes('scheduler')) return;
    this.timer = setInterval(() => {
      if (this.firing || !this.leader.isLeader) return;
      this.firing = this.fireDue().finally(() => (this.firing = undefined));
    }, CRON_CHECK_MS);
  }

  async beforeApplicationShutdown(): Promise<void> {
    clearInterval(this.timer);
    await this.firing;
  }

  /**
   * Creates or replaces a trigger
   * @returns it, plus the signing secret if one was generated, which is the only time it is shown
   */
  async put(name: string, request: PutTrigger): Promise<TriggerView & { secret?: string }> {
    if (!(await this.definitions.get(request.workflow, request.version))) {
      throw new BadRequestException(`Unknown workflow "${request.workflow}"${request.version ? ` version ${request.version}` : ''}`);
    }
    const trigger: Trigger = {
      name,
      type: request.type,
      workflow: request.workflow,
      ...(request.version ? { version: request.version } : {}),
      ...(request.input ? { input: request.input } : {}),
      enabled: request.enabled ?? true,
    };

    if (request.type === 'cron') {
      if (!request.cron) throw new BadRequestException('A cron trigger needs cron');
      try {
        trigger.nextRunAt = nextAfter(parseCron(request.cron), new Date());
      } catch (error) {
        throw new BadRequestException(`Invalid cron: ${(error as Error).message}`);
      }
      trigger.cron = request.cron;
      return view(await this.store.put(trigger));
    }

    const { issues } = compileTemplate(request.input ?? {}, 'input');
    if (issues.length) throw new BadRequestException({ message: 'Invalid input template', errors: issues });
    if (!this.box) throw new ServiceUnavailableException(`Webhook triggers need an encryption key: set ${SECRET_KEY_ENV}`);
    const secret = request.secret ?? randomBytes(32).toString('base64url');
    trigger.secret = this.box.seal(secret, secretContext(name));
    const stored = view(await this.store.put(trigger));
    return request.secret ? stored : { ...stored, secret };
  }

  async list(): Promise<TriggerView[]> {
    return (await this.store.list()).map(view);
  }

  async delete(name: string): Promise<boolean> {
    return this.store.delete(name);
  }

  /**
   * Starts a run from a webhook delivery
   * @throws UnauthorizedException unless the signature is right and recent
   */
  async deliver(name: string, rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<AcceptedRun> {
    const trigger = await this.store.get(name);
    if (!trigger || trigger.type !== 'webhook' || !trigger.enabled) throw new NotFoundException(`Unknown webhook "${name}"`);

    this.verify(trigger, rawBody, headers);

    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new BadRequestException('The body must be JSON');
    }

    let input: Record<string, unknown>;
    try {
      const template = compileTemplate(trigger.input ?? { body: '{{ body }}' }, 'input').template;
      input = (await resolveTemplate(template, { body }, 'input')) as Record<string, unknown>;
    } catch (error) {
      throw new BadRequestException(`Could not build the run's input: ${(error as Error).message}`);
    }

    const delivery = String(headers[DELIVERY_HEADER] ?? createHash('sha256').update(rawBody).update(String(headers[TIMESTAMP_HEADER])).digest('hex'));
    return this.startRun(trigger, input, `hook:${name}:${delivery}`);
  }

  private verify(trigger: Trigger, rawBody: Buffer, headers: Record<string, string | string[] | undefined>): void {
    const timestamp = String(headers[TIMESTAMP_HEADER] ?? '');
    const signature = String(headers[SIGNATURE_HEADER] ?? '');
    const sentAt = Number(timestamp) * 1000;
    if (!sentAt || Math.abs(Date.now() - sentAt) > SIGNATURE_TOLERANCE_MS) {
      throw new UnauthorizedException('Missing or stale timestamp');
    }
    if (!this.box) throw new ServiceUnavailableException(`Webhook triggers need an encryption key: set ${SECRET_KEY_ENV}`);
    const expected = Buffer.from(signDelivery(this.box.open<string>(trigger.secret, secretContext(trigger.name)), timestamp, rawBody));
    const given = Buffer.from(signature);
    // Comparing in constant time, so the response time reveals nothing about the signature
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new UnauthorizedException('Bad signature');
    }
  }

  private async startRun(trigger: Trigger, input: Record<string, unknown> | undefined, key: string): Promise<AcceptedRun> {
    const stored = await this.definitions.get(trigger.workflow, trigger.version);
    if (!stored) throw new NotFoundException(`Unknown workflow "${trigger.workflow}"`);
    const accepted = await this.workflows.start(stored.definition, input, { name: trigger.workflow, version: stored.version }, key);
    await this.store.record(trigger.name, { lastRunId: accepted.runId, lastFiredAt: new Date(), lastError: '' });
    return accepted;
  }

  /**
   * Fires every cron trigger that is due. The run's key names the scheduled
   * time, so a crash before moving the trigger on, or two leaders overlapping,
   * still makes one run. A trigger that was missed for a while fires once.
   */
  private async fireDue(): Promise<void> {
    try {
      const now = new Date();
      for (const trigger of await this.store.listDue(now)) {
        let lastError = '';
        try {
          await this.startRun(trigger, trigger.input, `cron:${trigger.name}:${new Date(trigger.nextRunAt).toISOString()}`);
        } catch (error) {
          const response = (error as any)?.getResponse?.();
          lastError = [(error as Error).message, ...(response?.errors ?? [])].join(': ');
          console.error(`Trigger ${trigger.name}: ${lastError}`);
        }
        await this.store.advance(trigger.name, new Date(trigger.nextRunAt), {
          nextRunAt: nextAfter(parseCron(trigger.cron), now),
          ...(lastError ? { lastError } : {}),
        });
      }
    } catch (error) {
      console.error('Triggers: could not fire due triggers:', error);
    }
  }
}
