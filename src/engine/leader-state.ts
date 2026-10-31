import { Injectable } from '@nestjs/common';
import { LeaderElection } from './leader-election';

/**
 * Whether this process leads, for anything that only the leader should do
 */
@Injectable()
export class LeaderState {
  private election?: LeaderElection;

  set source(election: LeaderElection) {
    this.election = election;
  }

  get isLeader(): boolean {
    return this.election?.isLeader ?? false;
  }
}
