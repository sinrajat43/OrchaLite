import { Module } from '@nestjs/common';
import { ConnectionsModule } from './connections/connections.module';
import { DefinitionsModule } from './definitions/definitions.module';
import { InboxModule } from './inbox/inbox.module';
import { WorkflowModule } from './workflows/workflow.module';

/**
 * Every HTTP feature, without the database connection, so tests can supply their own
 */
@Module({
  imports: [WorkflowModule, DefinitionsModule, ConnectionsModule, InboxModule],
})
export class ApiModule {}
