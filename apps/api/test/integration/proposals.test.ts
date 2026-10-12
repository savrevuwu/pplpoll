// Spec §3, §9, AT-25, AT-32: proposals cost 1 PP, routing, review, refunds, My Polls, attribution.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  as,
  balanceOf,
  createHarness,
  createOwner,
  grantPp,
  login,
  makeInvite,
  setRole,
  signUp,
  type Harness,
  type Session,
} from '../support/harness.js';

let h: Harness;
let owner: Session;
let mod: Session;
let superMod: Session;

beforeAll(async () => {
  h = await createHarness();
  const o = await createOwner(h);
  owner = await login(h, o.email, o.password);
  const inv = await makeInvite(h, owner, 100);
  mod = await signUp(h, inv.code);
  superMod = await signUp(h, inv.code);
  await setRole(h, owner, mod.userId, 'moderator');
  await setRole(h, owner, superMod.userId, 'super_moderator');
});
afterAll(() => h.close());

async function member(pp = 0) {
  const u = await signUp(h, (await makeInvite(h, owner)).code);
  if (pp) await grantPp(h, u.userId, pp);
  return u;
}

let n = 0;
const uniqueText = () =>
  `Name something people keep in drawer number ${++n} ${randomUUID().slice(0, 4)}`;

const submit = (s: Session, text: string, key = randomUUID(), visibility = 'public') =>
  h.app.inject({
    method: 'POST',
    url: '/proposals',
    headers: { ...as(s), 'idempotency-key': key },
    payload: { text, visibility },
  });

const decide = (s: Session, id: string, payload: Record<string, unknown>) =>
  h.app.inject({ method: 'POST', url: `/staff/proposals/${id}/decision`, headers: as(s), payload });

const notifications = async (s: Session) =>
  (await h.app.inject({ method: 'GET', url: '/me/notifications', headers: as(s) })).json()
    .notifications as { kind: string; payload: Record<string, unknown> }[];

describe('submitting proposals', () => {
  it('costs exactly 1 PP and fails cleanly without PP', async () => {
    const u = await member();
    const none = await submit(u, uniqueText());
    expect(none.statusCode).toBe(402);
    expect(none.json().error.code).toBe('PP_INSUFFICIENT');
    expect(
      await h.db
        .selectFrom('poll_proposals')
        .where('creator_user_id', '=', u.userId)
        .select('id')
        .execute(),
    ).toHaveLength(0);

    await grantPp(h, u.userId, 1);
    const ok = await submit(u, uniqueText());
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ status: 'pending', refunded: false });
    expect(await balanceOf(h, u.userId)).toBe(0);
  });

  it('requires an Idempotency-Key and never charges twice for retries, even concurrent ones', async () => {
    const u = await member(3);
    const noKey = await h.app.inject({
      method: 'POST',
      url: '/proposals',
      headers: as(u),
      payload: { text: uniqueText(), visibility: 'public' },
    });
    expect(noKey.statusCode).toBe(400);

    const key = randomUUID();
    const text = uniqueText();
    const results = await Promise.all(Array.from({ length: 6 }, () => submit(u, text, key)));
    const ids = new Set(results.map((r) => r.json().proposalId));
    expect(ids.size).toBe(1);
    expect(await balanceOf(h, u.userId)).toBe(2);
  });

  it('several pending proposals are allowed while PP lasts (concurrent spends never overdraw)', async () => {
    const u = await member(2);
    const results = await Promise.all(Array.from({ length: 6 }, () => submit(u, uniqueText())));
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(2);
    expect(results.filter((r) => r.statusCode === 402)).toHaveLength(4);
    expect(await balanceOf(h, u.userId)).toBe(0);
  });

  it('exact duplicates are auto-rejected and refunded (case/punctuation/spacing ignored)', async () => {
    const seed = await h.app.inject({
      method: 'POST',
      url: '/staff/polls',
      headers: as(owner),
      payload: { text: 'Name a fruit that is yellow' },
    });
    expect(seed.statusCode).toBe(201);
    const u = await member(1);
    const r = await submit(u, '  name a FRUIT that is   yellow?! ');
    expect(r.json()).toMatchObject({
      status: 'rejected',
      reason: 'duplicate_exact',
      refunded: true,
    });
    expect(await balanceOf(h, u.userId)).toBe(1);
    const ledger = await h.db
      .selectFrom('pp_ledger')
      .select(['kind', 'delta'])
      .where('user_id', '=', u.userId)
      .orderBy('created_at')
      .execute();
    expect(ledger.map((l) => l.kind)).toEqual(['proposal_debit', 'proposal_refund']);
  });

  it('routes similar questions to the similarity queue and sensitive ones to the sensitive queue', async () => {
    await h.app.inject({
      method: 'POST',
      url: '/staff/polls',
      headers: as(owner),
      payload: { text: 'Name something you bring to the beach' },
    });
    const u = await member(2);
    const sim = await submit(u, 'Name something you bring to a beach');
    const sens = await submit(u, 'Name a topic people avoid like politics at dinner');
    const simQ = (
      await h.app.inject({
        method: 'GET',
        url: '/staff/proposals?route=similarity',
        headers: as(mod),
      })
    ).json().proposals;
    const sensQ = (
      await h.app.inject({
        method: 'GET',
        url: '/staff/proposals?route=sensitive',
        headers: as(mod),
      })
    ).json().proposals;
    const simRow = simQ.find((p: { id: string }) => p.id === sim.json().proposalId);
    expect(simRow.similarTo[0]).toMatchObject({
      type: 'poll',
      text: 'Name something you bring to the beach',
    });
    expect(sensQ.some((p: { id: string }) => p.id === sens.json().proposalId)).toBe(true);
  });

  it('rejects junk text', async () => {
    const u = await member(1);
    expect((await submit(u, 'short')).statusCode).toBe(400);
    expect((await submit(u, '1234567890 1234')).statusCode).toBe(400);
    expect(await balanceOf(h, u.userId)).toBe(1);
  });
});

describe('staff review', () => {
  it('members cannot see or decide the queue', async () => {
    const u = await member();
    expect(
      (await h.app.inject({ method: 'GET', url: '/staff/proposals?route=normal', headers: as(u) }))
        .statusCode,
    ).toBe(403);
    expect((await decide(u, randomUUID(), { action: 'approve' })).statusCode).toBe(403);
  });

  it('approve (with a wording fix) creates a zero-response queued poll; creator is notified', async () => {
    const u = await member(1);
    const p = (await submit(u, 'Name somthing you keep in a purse')).json();
    const r = await decide(mod, p.proposalId, {
      action: 'approve',
      text: 'Name something you keep in a purse',
    });
    expect(r.statusCode).toBe(200);
    const poll = await h.db
      .selectFrom('polls')
      .selectAll()
      .where('id', '=', r.json().pollId)
      .executeTakeFirstOrThrow();
    expect(poll).toMatchObject({
      status: 'queued',
      response_count: 0,
      debut_et_date: null,
      text: 'Name something you keep in a purse',
    });
    const auditRow = await h.db
      .selectFrom('audit.events')
      .select('detail')
      .where('action', '=', 'proposal.approve')
      .where('target_id', '=', p.proposalId)
      .executeTakeFirstOrThrow();
    expect(auditRow.detail).toMatchObject({
      before: 'Name somthing you keep in a purse',
      after: 'Name something you keep in a purse',
    });
    expect((await notifications(u)).map((x) => x.kind)).toContain('proposal_approved');
    expect((await decide(mod, p.proposalId, { action: 'approve' })).json().error.code).toBe(
      'ALREADY_DECIDED',
    );
  });

  it('good-faith rejection refunds; spam does not', async () => {
    const u = await member(2);
    const a = (await submit(u, uniqueText())).json();
    const b = (await submit(u, uniqueText())).json();
    expect(
      (await decide(mod, a.proposalId, { action: 'reject', reason: 'quality' })).json(),
    ).toMatchObject({ refunded: true });
    expect(
      (await decide(mod, b.proposalId, { action: 'reject', reason: 'spam' })).json(),
    ).toMatchObject({ refunded: false });
    expect(await balanceOf(h, u.userId)).toBe(1);
    const kinds = (await notifications(u))
      .filter((x) => x.kind === 'proposal_rejected')
      .map((x) => x.payload.refunded);
    expect(kinds.sort()).toEqual([false, true]);
  });

  it('request revision refunds and passes the note to the creator', async () => {
    const u = await member(1);
    const p = (await submit(u, uniqueText())).json();
    const r = await decide(mod, p.proposalId, {
      action: 'request_revision',
      note: 'Please make it less specific',
    });
    expect(r.json()).toMatchObject({ status: 'revision_requested', refunded: true });
    const note = (await notifications(u)).find((x) => x.kind === 'proposal_revision_requested');
    expect(note?.payload.note).toBe('Please make it less specific');
  });

  it('only Super Moderators and above can correct refunds', async () => {
    const u = await member(1);
    const p = (await submit(u, uniqueText())).json();
    await decide(mod, p.proposalId, { action: 'reject', reason: 'spam' });
    const url = `/staff/proposals/${p.proposalId}/refund-correction`;
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url,
          headers: as(mod),
          payload: { action: 'grant', note: 'was not spam' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url,
          headers: as(superMod),
          payload: { action: 'grant', note: 'was not spam' },
        })
      ).statusCode,
    ).toBe(200);
    expect(await balanceOf(h, u.userId)).toBe(1);
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url,
          headers: as(superMod),
          payload: { action: 'grant', note: 'again' },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url,
          headers: as(superMod),
          payload: { action: 'reverse', note: 'it was spam' },
        })
      ).statusCode,
    ).toBe(200);
    expect(await balanceOf(h, u.userId)).toBe(0);
  });

  it('two identical pending proposals cannot both become polls', async () => {
    const a = await member(1);
    const b = await member(1);
    const text = uniqueText();
    const pa = (await submit(a, text)).json();
    // b's identical text is auto-rejected because a's is still pending
    expect((await submit(b, text)).json()).toMatchObject({
      status: 'rejected',
      reason: 'duplicate_exact',
    });
    expect((await decide(mod, pa.proposalId, { action: 'approve' })).statusCode).toBe(200);
  });

  it('the PP ledger is append-only', async () => {
    await expect(h.db.updateTable('pp_ledger').set({ delta: 5 }).execute()).rejects.toThrow(
      /append-only/,
    );
  });
});

describe('My Polls and attribution', () => {
  it('shows approved questions only, including anonymous ones, with respondent counts', async () => {
    const u = await member(3);
    const approved = (await submit(u, uniqueText(), randomUUID(), 'anonymous')).json();
    await submit(u, uniqueText());
    const rejected = (await submit(u, uniqueText())).json();
    await decide(mod, approved.proposalId, { action: 'approve' });
    await decide(mod, rejected.proposalId, { action: 'reject', reason: 'quality' });
    const mine = (await h.app.inject({ method: 'GET', url: '/me/polls', headers: as(u) })).json()
      .polls;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      visibility: 'anonymous',
      respondents: 0,
      status: 'waiting_for_debut',
    });
  });

  it('wording of a queued poll can be corrected by staff; members cannot', async () => {
    const seed = (
      await h.app.inject({
        method: 'POST',
        url: '/staff/polls',
        headers: as(owner),
        payload: { text: uniqueText() },
      })
    ).json();
    const u = await member();
    expect(
      (
        await h.app.inject({
          method: 'PATCH',
          url: `/staff/polls/${seed.pollId}`,
          headers: as(u),
          payload: { text: uniqueText() },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await h.app.inject({
          method: 'PATCH',
          url: `/staff/polls/${seed.pollId}`,
          headers: as(mod),
          payload: { text: uniqueText() },
        })
      ).statusCode,
    ).toBe(200);
  });

  it('only Admin/Owner may seed polls without PP', async () => {
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: '/staff/polls',
          headers: as(mod),
          payload: { text: uniqueText() },
        })
      ).statusCode,
    ).toBe(403);
  });
});
