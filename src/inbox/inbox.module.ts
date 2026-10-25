import { Module } from '@nestjs/common';
import { InboxController } from './inbox.controller';

@Module({ controllers: [InboxController] })
export class InboxModule {}
