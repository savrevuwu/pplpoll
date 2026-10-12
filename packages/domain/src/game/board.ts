/**
 * One competitor's guessing board ("side"): a solo player, a Head-to-Head or Free-for-All player,
 * or a whole team sharing one pool (spec §5, update §2).
 *
 * - Correct answer groups add their frozen-snapshot count to the side's score, once per side.
 * - Repeating an answer the side already guessed (correct or wrong) → "already_guessed":
 *   no points, no attempt used, no strike.
 * - Wrong guesses use an attempt and a strike; the 3rd strike ends the side's play.
 * - Accepted guesses (correct + wrong) are limited by the poll's guess cap.
 * Different sides are independent, so opponents can score the same answer.
 */
import { MAX_STRIKES } from './eligibility.js';
import { meetsTarget, share, type Share } from './share.js';

export interface BoardConfig {
  /** answer group id -> respondents in that group, from the frozen snapshot */
  distribution: ReadonlyMap<string, number>;
  respondents: number;
  guessCap: number;
  /** Solo: reaching 60% ends play. Multiplayer behaviour pending owner decision G4. */
  stopAtTarget: boolean;
}

export interface GuessInput {
  /** matched answer group, or null when the guess matched no group */
  groupId: string | null;
  /** normalized text key, used to detect a repeated wrong guess */
  key: string;
  /** user who submitted it (team credit) */
  by: string;
  /** authoritative server time, ms */
  at: number;
}

export type GuessResult =
  | { kind: 'correct'; groupId: string; groupShare: Share; score: Share }
  | { kind: 'incorrect'; strikes: number }
  | { kind: 'already_guessed' };

export type FinishReason = 'strikes' | 'cap' | 'target';

export interface Contribution {
  answers: number;
  count: number;
}

export class GuessBoard {
  private readonly seen = new Set<string>();
  private scoreCount = 0;
  private correct = 0;
  private wrong = 0;
  private lastScoreAt: number | null = null;
  private readonly credit = new Map<string, Contribution>();
  private finish: FinishReason | null = null;

  constructor(private readonly cfg: BoardConfig) {
    if (cfg.guessCap < 1) throw new RangeError('guessCap must be positive');
  }

  get finishedReason(): FinishReason | null {
    return this.finish;
  }
  get finished(): boolean {
    return this.finish !== null;
  }
  get strikes(): number {
    return this.wrong;
  }
  get accepted(): number {
    return this.correct + this.wrong;
  }
  get correctCount(): number {
    return this.correct;
  }
  get remaining(): number {
    return this.cfg.guessCap - this.accepted;
  }
  /** Server time the current score was reached (null while the score is 0). */
  get reachedScoreAt(): number | null {
    return this.lastScoreAt;
  }
  score(): Share {
    return share(this.scoreCount, this.cfg.respondents);
  }
  /** Per-teammate credit for unique correct answers. */
  contributions(): ReadonlyMap<string, Contribution> {
    return this.credit;
  }

  submit(guess: GuessInput): GuessResult {
    if (this.finish) throw new Error('board is finished');
    const dedupeKey = guess.groupId !== null ? `g:${guess.groupId}` : `w:${guess.key}`;
    if (this.seen.has(dedupeKey)) return { kind: 'already_guessed' };
    this.seen.add(dedupeKey);

    if (guess.groupId !== null) {
      const count = this.cfg.distribution.get(guess.groupId);
      if (count === undefined) throw new Error('unknown answer group');
      this.correct++;
      this.scoreCount += count;
      if (count > 0) this.lastScoreAt = guess.at;
      const c = this.credit.get(guess.by) ?? { answers: 0, count: 0 };
      this.credit.set(guess.by, { answers: c.answers + 1, count: c.count + count });
      this.updateFinish();
      return {
        kind: 'correct',
        groupId: guess.groupId,
        groupShare: share(count, this.cfg.respondents),
        score: this.score(),
      };
    }

    this.wrong++;
    this.updateFinish();
    return { kind: 'incorrect', strikes: this.wrong };
  }

  private updateFinish(): void {
    if (this.cfg.stopAtTarget && meetsTarget(this.score())) this.finish = 'target';
    else if (this.wrong >= MAX_STRIKES) this.finish = 'strikes';
    else if (this.accepted >= this.cfg.guessCap) this.finish = 'cap';
  }
}
