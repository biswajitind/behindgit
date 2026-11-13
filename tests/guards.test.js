import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp, retainSnapshot } from '../server/app.js';
import { getConfig } from '../server/config.js';
import { rateKey, rateLimit, sweepRateLimits } from '../server/httpguard.js';
import { assertSandboxDisk, createSession, getSession } from '../server/sandbox.js';
const sandboxRoot = mkdtempSync(path.join(os.tmpdir(), 'behindgit-guards-'));
process.env.BEHINDGIT_SANDBOX_ROOT = sandboxRoot;
process.env.BEHINDGIT_RATE_CREATE_PER_MIN = '2';
process.env.BEHINDGIT_RATE_COMMAND_PER_MIN = '1000';
process.env.BEHINDGIT_MAX_SESSIONS = '8';
process.env.BEHINDGIT_IDLE_EVICT_MS = '600000';

function jsonHeaders(extra = {}) {
  return {
    'content-type': 'application/json',
    'x-behindgit': '1',
    ...extra,
  };
}

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, port: server.address().port };
}

async function request(port, urlPath, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, options);
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body, headers: response.headers };
}

test.describe('http guards', { concurrency: false }, () => {

test('the process binds to loopback unless HOST is set', () => {
  const saved = process.env.HOST;
  delete process.env.HOST;
  try {
    assert.equal(getConfig().host, '127.0.0.1');
  } finally {
    if (saved === undefined) delete process.env.HOST;
    else process.env.HOST = saved;
  }
});

test('mutations require the app header, JSON, and a same-site fetch', { timeout: 30_000 }, async () => {
  const { server, port } = await listen(createApp());
  try {
    const health = await request(port, '/api/health');
    assert.equal(health.status, 200);
    assert.match(health.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(health.headers.get('x-frame-options'), 'DENY');
    assert.equal(health.headers.get('referrer-policy'), 'no-referrer');

    const missing = await request(port, '/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(missing.status, 403);

    const crossSite = await request(port, '/api/sessions', {
      method: 'POST',
      headers: jsonHeaders({ 'sec-fetch-site': 'cross-site' }),
      body: '{}',
    });
    assert.equal(crossSite.status, 403);

    const textBody = await request(port, '/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-behindgit': '1' },
      body: '{}',
    });
    assert.equal(textBody.status, 415);
  } finally {
    server.close();
  }
});

test('create is rate limited, and a live session is not evicted to make room', { timeout: 60_000 }, async () => {
  const saved = {
    create: process.env.BEHINDGIT_RATE_CREATE_PER_MIN,
    command: process.env.BEHINDGIT_RATE_COMMAND_PER_MIN,
    max: process.env.BEHINDGIT_MAX_SESSIONS,
    idle: process.env.BEHINDGIT_IDLE_EVICT_MS,
  };
  const { server, port } = await listen(createApp());
  try {
    const first = await request(port, '/api/sessions', {
      method: 'POST',
      headers: jsonHeaders(),
      body: '{}',
    });
    const second = await request(port, '/api/sessions', {
      method: 'POST',
      headers: jsonHeaders(),
      body: '{}',
    });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    const limited = await request(port, '/api/sessions', {
      method: 'POST',
      headers: jsonHeaders(),
      body: '{}',
    });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);

    process.env.BEHINDGIT_RATE_CREATE_PER_MIN = '1000';
    process.env.BEHINDGIT_MAX_SESSIONS = '2';
    const busy = await request(port, '/api/sessions', {
      method: 'POST',
      headers: jsonHeaders(),
      body: '{}',
    });
    assert.equal(busy.status, 503);
    assert.equal(busy.headers.get('retry-after'), '30');
    const stillThere = await request(port, `/api/sessions/${first.body.id}`);
    assert.equal(stillThere.status, 200);

    process.env.BEHINDGIT_IDLE_EVICT_MS = '0';
    const evicted = await request(port, '/api/sessions', {
      method: 'POST',
      headers: jsonHeaders(),
      body: '{}',
    });
    assert.equal(evicted.status, 201);
    // The lookup above refreshed the first session, so the idle one is the second.
    const kept = await request(port, `/api/sessions/${first.body.id}`);
    assert.equal(kept.status, 200);
    const gone = await request(port, `/api/sessions/${second.body.id}`);
    assert.equal(gone.status, 404);

    process.env.BEHINDGIT_RATE_COMMAND_PER_MIN = '1';
    const command = await request(port, `/api/sessions/${first.body.id}/command`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ command: 'git status' }),
    });
    assert.equal(command.status, 200);
    const again = await request(port, `/api/sessions/${first.body.id}/command`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ command: 'git status' }),
    });
    assert.equal(again.status, 429);
  } finally {
    server.close();
    process.env.BEHINDGIT_RATE_CREATE_PER_MIN = saved.create;
    process.env.BEHINDGIT_RATE_COMMAND_PER_MIN = saved.command;
    process.env.BEHINDGIT_MAX_SESSIONS = saved.max;
    process.env.BEHINDGIT_IDLE_EVICT_MS = saved.idle;
  }
});

function saveEnv(names) {
  const saved = {};
  for (const name of names) saved[name] = process.env[name];
  return {
    set(name, value) {
      process.env[name] = value;
    },
    async restore() {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    },
  };
}

test('a live session is not replaced, and an idle one is', async () => {
  const env = saveEnv([
    'BEHINDGIT_MAX_SESSIONS',
    'BEHINDGIT_MAX_SESSIONS_PER_CLIENT',
    'BEHINDGIT_CLIENT_EVICT_MS',
  ]);
  env.set('BEHINDGIT_MAX_SESSIONS', '100');
  env.set('BEHINDGIT_MAX_SESSIONS_PER_CLIENT', '2');
  env.set('BEHINDGIT_CLIENT_EVICT_MS', '120000');
  try {
    const first = await createSession({ clientKey: 'alpha' });
    const second = await createSession({ clientKey: 'alpha' });
    await assert.rejects(() => createSession({ clientKey: 'alpha' }), /No idle sandbox/);
    assert.equal(getSession(first.id).id, first.id);
    assert.equal(getSession(second.id).id, second.id);
    first.lastUsed = Date.now() - 130_000;
    const third = await createSession({ clientKey: 'alpha' });
    await assert.rejects(() => Promise.resolve().then(() => getSession(first.id)), /not found/);
    assert.equal(getSession(second.id).id, second.id);
    assert.equal(getSession(third.id).id, third.id);
  } finally {
    await env.restore();
  }
});

test('replacing an idle session does not hold the create lock', async () => {
  const env = saveEnv([
    'BEHINDGIT_MAX_SESSIONS',
    'BEHINDGIT_MAX_SESSIONS_PER_CLIENT',
    'BEHINDGIT_CLIENT_EVICT_MS',
    'BEHINDGIT_SAMPLE_PATH',
  ]);
  env.set('BEHINDGIT_MAX_SESSIONS', '100');
  env.set('BEHINDGIT_MAX_SESSIONS_PER_CLIENT', '1');
  env.set('BEHINDGIT_CLIENT_EVICT_MS', '0');
  const source = mkdtempSync(path.join(os.tmpdir(), 'behindgit-lock-src-'));
  let release = () => {};
  let replacing = Promise.resolve();
  try {
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init', '-q', '-b', 'main', source]);
    env.set('BEHINDGIT_SAMPLE_PATH', source);
    const held = await createSession({ clientKey: 'busy' });
    held.queue = new Promise((resolve) => {
      release = resolve;
    });
    held.lastUsed = 0;
    replacing = createSession({ clientKey: 'busy' });
    const other = await Promise.race([
      createSession({ clientKey: 'other' }).then(() => 'done'),
      new Promise((resolve) => setTimeout(() => resolve('blocked'), 2000)),
    ]);
    assert.equal(other, 'done');
  } finally {
    release();
    await replacing.catch(() => {});
    await env.restore();
    rmSync(source, { recursive: true, force: true });
  }
});

test('rate keys use an IPv6 /64 and empty buckets are dropped', () => {
  assert.equal(rateKey('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2');
  assert.equal(rateKey('2001:db8:1:2::8'), '2001:db8:1:2');
  assert.equal(rateKey('::ffff:10.1.2.3'), '10.1.2.3');
  const req = { socket: { remoteAddress: '198.51.100.10' }, ip: '198.51.100.10' };
  const res = { setHeader() {} };
  process.env.BEHINDGIT_RATE_READ_PER_MIN = '1';
  const limit = rateLimit('read');
  let blocked = 0;
  limit(req, res, (error) => { if (error) blocked += 1; });
  limit(req, res, (error) => { if (error) blocked += 1; });
  assert.equal(blocked, 1);
  sweepRateLimits(Date.now() + 120_000);
  blocked = 0;
  limit(req, res, (error) => { if (error) blocked += 1; });
  assert.equal(blocked, 0);
  delete process.env.BEHINDGIT_RATE_READ_PER_MIN;
});

test('a full object store still allows status and tells you to reset', async () => {
  const env = saveEnv([
    'BEHINDGIT_RATE_CREATE_PER_MIN',
    'BEHINDGIT_RATE_COMMAND_PER_MIN',
    'BEHINDGIT_MAX_SESSIONS',
    'BEHINDGIT_MAX_SESSIONS_PER_CLIENT',
    'BEHINDGIT_SESSION_MAX_GIT_BYTES',
  ]);
  env.set('BEHINDGIT_RATE_CREATE_PER_MIN', '1000');
  env.set('BEHINDGIT_RATE_COMMAND_PER_MIN', '1000');
  env.set('BEHINDGIT_MAX_SESSIONS', '100');
  env.set('BEHINDGIT_MAX_SESSIONS_PER_CLIENT', '20');
  env.set('BEHINDGIT_SESSION_MAX_GIT_BYTES', '1');
  const { server, port } = await listen(createApp());
  try {
    const created = await request(port, '/api/sessions', {
      method: 'POST',
      headers: jsonHeaders(),
      body: '{}',
    });
    assert.equal(created.status, 201);
    const status = await request(port, `/api/sessions/${created.body.id}/command`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ command: 'git status' }),
    });
    assert.equal(status.status, 200);
    const commit = await request(port, `/api/sessions/${created.body.id}/command`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ command: 'git commit -m "nope"' }),
    });
    assert.equal(commit.status, 413);
    assert.match(commit.body.error, /Reset sandbox/);
  } finally {
    server.close();
    await env.restore();
  }
});

test('a failed object read is not cached, and a low disk floor refuses creates', async () => {
  const session = { lastSnapshot: { kept: true } };
  retainSnapshot(session, { readFailed: true, objects: {} });
  assert.equal(session.lastSnapshot, null);
  retainSnapshot(session, { readFailed: false, head: 1 });
  assert.deepEqual(session.lastSnapshot, { readFailed: false, head: 1 });

  const env = saveEnv(['BEHINDGIT_SANDBOX_MIN_FREE_BYTES', 'BEHINDGIT_MAX_SESSIONS']);
  env.set('BEHINDGIT_SANDBOX_MIN_FREE_BYTES', '999999999999999');
  env.set('BEHINDGIT_MAX_SESSIONS', '10');
  try {
    await assert.rejects(() => assertSandboxDisk(), /disk is full/);
  } finally {
    await env.restore();
  }
});

});

test.after(() => {
  rmSync(sandboxRoot, { recursive: true, force: true });
});
