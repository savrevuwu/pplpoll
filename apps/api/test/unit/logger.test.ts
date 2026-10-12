// M0-04: the log scrubber removes secrets, emails and survey/guess content.
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, REDACTED, scrub } from '../../src/logger.js';

describe('scrub', () => {
  it('redacts sensitive keys at any depth', () => {
    const out = scrub({
      user: { id: 'u1', email: 'a@b.com', password: 'hunter2' },
      req: { headers: { authorization: 'Bearer x', cookie: 'sid=1' } },
      payload: { text: 'Keys', guess: 'Wallet', answers: ['Keys'] },
      inviteCode: 'ABC123',
    });
    expect(out).toEqual({
      user: { id: 'u1', email: REDACTED, password: REDACTED },
      req: { headers: { authorization: REDACTED, cookie: REDACTED } },
      payload: { text: REDACTED, guess: REDACTED, answers: REDACTED },
      inviteCode: REDACTED,
    });
  });

  it('masks email addresses inside free strings and errors', () => {
    expect(scrub('login failed for jo@example.org')).toBe(`login failed for ${REDACTED}`);
    expect(scrub({ err: new Error('no user x.y@z.io') })).toEqual({
      err: { type: 'Error', message: `no user ${REDACTED}` },
    });
  });

  it('leaves safe values alone and bounds depth', () => {
    expect(scrub({ count: 3, ok: true, n: null })).toEqual({ count: 3, ok: true, n: null });
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 20; i++) deep = { next: deep };
    expect(JSON.stringify(scrub(deep))).toContain(REDACTED);
  });
});

describe('createLogger', () => {
  it('writes scrubbed JSON lines', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const testLogger = createLogger({ level: 'info' }, sink);
    testLogger.info({ email: 'me@x.com', answer: 'Keys', pollId: 'p1' }, 'submitted by me@x.com');
    const line = lines.join('');
    expect(line).toContain('"pollId":"p1"');
    expect(line).not.toContain('me@x.com');
    expect(line).not.toContain('Keys');
  });
});
