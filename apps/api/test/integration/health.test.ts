// M0-03: /health reports database connectivity; request logs are scrubbed.
import { Writable } from 'node:stream';
import { createDb } from '@pplpoll/db';
import { afterAll, describe, expect, it } from 'vitest';
import { createLogger } from '../../src/logger.js';
import { buildServer } from '../../src/server.js';
import { createHarness, type Harness } from '../support/harness.js';

const harnesses: Harness[] = [];
afterAll(async () => {
  for (const h of harnesses) await h.close();
});

async function harness(opts: Parameters<typeof createHarness>[0] = {}) {
  const h = await createHarness(opts);
  harnesses.push(h);
  return h;
}

describe('GET /health', () => {
  it('returns 200 when the database is reachable', async () => {
    const res = await (await harness()).app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', db: 'ok' });
  });

  it('returns 503 without leaking details when the database is unreachable', async () => {
    const h = await harness();
    const badDb = createDb('postgres://nobody:wrong@127.0.0.1:1/none');
    const app = await buildServer({ ...h.deps, db: badDb });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'degraded', db: 'unavailable' });
    await app.close();
    await badDb.destroy();
  });

  it('returns 404 for unknown routes', async () => {
    const res = await (await harness()).app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
  });
});

describe('request logging', () => {
  it('records method, url and status but no headers', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const h = await harness({ logger: createLogger({ level: 'info' }, sink) });
    await h.app.inject({
      method: 'GET',
      url: '/health',
      headers: { cookie: 'sid=secret-cookie', authorization: 'Bearer secret-token' },
    });
    const log = lines.join('');
    expect(log).toContain('"method":"GET"');
    expect(log).toContain('"url":"/health"');
    expect(log).toContain('"statusCode":200');
    expect(log).not.toContain('secret-cookie');
    expect(log).not.toContain('secret-token');
  });
});
