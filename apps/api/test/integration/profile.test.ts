// Spec §10, AT-21: display-name rules and exact 168-hour cooldown; username permanence.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  as,
  createHarness,
  createOwner,
  login,
  makeInvite,
  signUp,
  type Harness,
  type Session,
} from '../support/harness.js';

let h: Harness;
let owner: Session;
beforeAll(async () => {
  h = await createHarness();
  const o = await createOwner(h);
  owner = await login(h, o.email, o.password);
});
afterAll(() => h.close());

const setName = (s: Session, displayName: string | null) =>
  h.app.inject({ method: 'PATCH', url: '/me/profile', headers: as(s), payload: { displayName } });

describe('display name', () => {
  it('trims and validates', async () => {
    const u = await signUp(h, (await makeInvite(h, owner)).code);
    expect((await setName(u, 'Bad!')).statusCode).toBe(400);
    expect((await setName(u, '   ')).statusCode).toBe(400);
    const ok = await setName(u, '  Poll Fan 7 ');
    expect(ok.statusCode).toBe(200);
    expect(ok.json().displayName).toBe('Poll Fan 7');
  });

  it('can change again only after exactly 168 hours', async () => {
    const u = await signUp(h, (await makeInvite(h, owner)).code);
    expect((await setName(u, 'First')).statusCode).toBe(200);
    h.clock.advance(168 * 3600_000 - 1);
    const early = await setName(u, 'Second');
    expect(early.statusCode).toBe(429);
    expect(early.json().error.code).toBe('DISPLAY_NAME_COOLDOWN');
    h.clock.advance(1);
    expect((await setName(u, 'Second')).statusCode).toBe(200);
  });

  it('removing the display name also counts as a change', async () => {
    const u = await signUp(h, (await makeInvite(h, owner)).code);
    expect((await setName(u, 'Named')).statusCode).toBe(200);
    expect((await setName(u, null)).statusCode).toBe(429);
  });

  it('display names are not unique', async () => {
    const a = await signUp(h, (await makeInvite(h, owner)).code);
    const b = await signUp(h, (await makeInvite(h, owner)).code);
    expect((await setName(a, 'Same Name')).statusCode).toBe(200);
    expect((await setName(b, 'Same Name')).statusCode).toBe(200);
  });
});

describe('username', () => {
  it('cannot be changed through the profile endpoint', async () => {
    const u = await signUp(h, (await makeInvite(h, owner)).code);
    const r = await h.app.inject({
      method: 'PATCH',
      url: '/me/profile',
      headers: as(u),
      payload: { username: 'newname' },
    });
    expect(r.statusCode).toBe(400);
  });
});
