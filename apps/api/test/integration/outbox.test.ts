// Spec §19: email payloads (addresses, tokens) are encrypted at rest and wiped after sending.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatchOutbox, type EmailMessage } from '../../src/index.js';
import {
  createHarness,
  createOwner,
  login,
  makeInvite,
  signUp,
  type Harness,
} from '../support/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

describe('email outbox', () => {
  it('sends each queued email once and wipes its payload', async () => {
    const o = await createOwner(h);
    const owner = await login(h, o.email, o.password);
    const u = await signUp(h, (await makeInvite(h, owner)).code);

    const sent: EmailMessage[] = [];
    const transport = { send: async (m: EmailMessage) => void sent.push(m) };
    const n = await dispatchOutbox(h.db, h.deps.crypto, transport, h.clock.fn());
    expect(n).toBeGreaterThan(0);
    expect(sent.some((m) => m.kind === 'verify_email' && m.to === u.email)).toBe(true);

    expect(await dispatchOutbox(h.db, h.deps.crypto, transport, h.clock.fn())).toBe(0);
    const rows = await h.db.selectFrom('email_outbox').select(['payload_enc', 'sent_at']).execute();
    expect(rows.every((r) => r.payload_enc === '' && r.sent_at !== null)).toBe(true);
  });
});
