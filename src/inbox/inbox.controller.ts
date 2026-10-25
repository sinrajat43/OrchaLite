import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';

export interface InboxMessage {
  channel: string;
  receivedAt: Date;
  payload: unknown;
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
  receive(@Param('channel') channel: string, @Body() payload: unknown): { received: true } {
    this.messages.unshift({ channel, receivedAt: new Date(), payload });
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
