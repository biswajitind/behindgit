import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { getConfig } from '../server/config.js';

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
  }
});

});

test.after(() => {
  rmSync(sandboxRoot, { recursive: true, force: true });
});
