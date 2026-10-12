// M0-03: /health reports database connectivity.
import { createDb } from '@pplpoll/db';
import type { Kysely } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { createLogger } from '../../src/logger.js';
import { buildServer } from '../../src/server.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for integration tests');

const logger = createLogger({ level: 'silent' });
const dbs: Kysely<unknown>[] = [];

afterAll(async () => {
  await Promise.all(dbs.map((d) => d.destroy()));
});

function server(connectionString: string) {
  const db = createDb(connectionString) as unknown as Kysely<unknown>;
  dbs.push(db);
  return buildServer({ db, logger });
}

describe('GET /health', () => {
  it('returns 200 when the database is reachable', async () => {
    const res = await server(url).inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', db: 'ok' });
  });

  it('returns 503 without leaking details when the database is unreachable', async () => {
    const res = await server('postgres://nobody:wrong@127.0.0.1:1/none').inject({
      method: 'GET',
      url: '/health',
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'degraded', db: 'unavailable' });
  });

  it('returns a generic 404 shape for unknown routes', async () => {
    const res = await server(url).inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
  });
});

describe('request logging', () => {
  it('records method, url and status but no headers', async () => {
    const { Writable } = await import('node:stream');
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const db = createDb(url!) as unknown as Kysely<unknown>;
    dbs.push(db);
    const app = buildServer({ db, logger: createLogger({ level: 'info' }, sink) });
    await app.inject({
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
