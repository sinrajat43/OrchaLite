import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post } from '@nestjs/common';

export interface InboxMessage {
  channel: string;
  receivedAt: Date;
  payload: unknown;
  idempotencyKey?: string;
}

const MAX_MESSAGES = 100;

/**
 * A local webhook target for trying notifications without Slack or similar:
 * point notify.webhook at /inbox/<channel> and read what arrived here.
 * Messages live in memory only.
 */
@Controller('inbox')
export class InboxController {
  private readonly messages: InboxMessage[] = [];

  @Post(':channel')
  @HttpCode(200)
  receive(@Param('channel') channel: string, @Body() payload: unknown, @Headers('idempotency-key') idempotencyKey?: string): { received: true } {
    // A sender may repeat itself, so a good receiver recognises the same message by its key
    if (idempotencyKey && this.messages.some(message => message.idempotencyKey === idempotencyKey)) return { received: true };
    this.messages.unshift({ channel, receivedAt: new Date(), payload, ...(idempotencyKey ? { idempotencyKey } : {}) });
    this.messages.length = Math.min(this.messages.length, MAX_MESSAGES);
    return { received: true };
  }

  /** Newest first */
  @Get()
  list(): InboxMessage[] {
    return this.messages;
  }

  @Delete()
  @HttpCode(204)
  clear(): void {
    this.messages.length = 0;
  }
}
