// Spec §10: brute-force protection on invite codes and sign-in.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../support/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ rateLimitMax: 3 });
});
afterAll(() => h.close());

describe('auth rate limits', () => {
  it('limit invite code guessing per client', async () => {
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const r = await h.app.inject({
        method: 'POST',
        url: '/auth/invite/check',
        payload: { code: `GUESS${i}` },
      });
      statuses.push(r.statusCode);
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
  });

  it('limit password guessing per client', async () => {
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const r = await h.app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'nobody@example.com', password: `guess-${i}-xxxx` },
      });
      statuses.push(r.statusCode);
    }
    expect(statuses).toEqual([401, 401, 401, 429, 429]);
  });
});
