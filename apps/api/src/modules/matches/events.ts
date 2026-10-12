import { EventEmitter } from 'node:events';

/**
 * Match update notifications. Payloads carry only ids and a version number; every client then
 * fetches its own view over HTTP, so privacy rules live in one place (the per-viewer projection).
 * In-process for now; a Redis pub/sub implementation plugs in here for multiple API instances.
 */
export class MatchEvents {
  private readonly bus = new EventEmitter().setMaxListeners(0);

  matchUpdated(matchId: string): void {
    this.bus.emit(`match:${matchId}`, { type: 'match.updated', matchId });
  }

  userEvent(userId: string, event: { type: string; matchId?: string }): void {
    this.bus.emit(`user:${userId}`, event);
  }

  onMatch(matchId: string, fn: (e: unknown) => void): () => void {
    this.bus.on(`match:${matchId}`, fn);
    return () => this.bus.off(`match:${matchId}`, fn);
  }

  onUser(userId: string, fn: (e: unknown) => void): () => void {
    this.bus.on(`user:${userId}`, fn);
    return () => this.bus.off(`user:${userId}`, fn);
  }
}
