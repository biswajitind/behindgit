import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readlink, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertSafePath } from './allowlist.js';
import { describeSample, getConfig } from './config.js';
import { AppError } from './errors.js';
import { gitText } from './git.js';

const sessions = new Map();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let pendingCreates = 0;
const pendingByClient = new Map();
let clonesInFlight = 0;
const cloneWaiters = [];
let slotGate = Promise.resolve();

function withSlot(fn) {
  const run = slotGate.then(fn, fn);
  slotGate = run.then(() => undefined, () => undefined);
  return run;
}

function acquireClone() {
  const cfg = getConfig();
  if (clonesInFlight < cfg.maxCloneConcurrency) {
    clonesInFlight += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    cloneWaiters.push(resolve);
  }).then(() => {
    clonesInFlight += 1;
  });
}

function releaseClone() {
  clonesInFlight -= 1;
  const next = cloneWaiters.shift();
  if (next) next();
}

function assertHttpsUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new AppError('BEHINDGIT_SAMPLE_URL is not a valid URL', 500);
  }
  if (url.protocol !== 'https:') throw new AppError('BEHINDGIT_SAMPLE_URL must be an https URL', 500);
  if (url.username || url.password) throw new AppError('Sample URL must not include credentials', 500);
  if (!url.hostname) throw new AppError('Sample URL is missing a host', 500);
}

// True when `candidate` is the root itself or resolves outside it.
// A sibling such as `<root>-evil/x` is outside: path.relative yields `../...`.
export function escapesRoot(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === ''
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative);
}

// Every user-path filesystem call goes through here. The path.relative check
// sits in this function, directly before the call, which is the shape CodeQL
// treats as a barrier. Callers do not repeat it.
// After a directory is created, callers realpath it and run escapesRoot again
// so a symlink swapped in between the check and mkdir cannot point outside.
// The final file is opened with O_NOFOLLOW and fstat'd so the handle is the
// same inode we just checked, not a symlink planted under that name.
async function accessInside(root, full, op, content) {
  const relative = path.relative(root, full);
  if (relative.startsWith('..' + path.sep) || relative === '..' || relative === '' || path.isAbsolute(relative)) {
    throw new AppError('Path escapes the sandbox');
  }
  if (op === 'lstat') return lstat(full);
  if (op === 'mkdir') return mkdir(full, { recursive: true });
  if (op === 'realpath') return realpath(full);
  if (op === 'rm') return rm(full);
  const flags = op === 'openRead'
    ? constants.O_RDONLY | constants.O_NOFOLLOW
    : constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;
  const handle = await open(full, flags, 0o644);
  if (op === 'openRead') return handle;
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new AppError('Refusing to follow a symlink');
    await handle.writeFile(content, 'utf8');
  } finally {
    await handle.close();
  }
  return undefined;
}

export function resolveSample(cfg = getConfig()) {
  if (cfg.samplePath) {
    if (!existsSync(cfg.samplePath)) {
      throw new AppError(`BEHINDGIT_SAMPLE_PATH does not exist: ${cfg.samplePath}`, 500);
    }
    return { kind: 'path', path: path.resolve(cfg.samplePath), label: cfg.sampleLabel };
  }
  if (cfg.sampleUrl) {
    assertHttpsUrl(cfg.sampleUrl);
    return { kind: 'url', url: cfg.sampleUrl, label: cfg.sampleLabel };
  }
  if (!existsSync(cfg.sampleBundle)) {
    throw new AppError(`Sample bundle not found: ${cfg.sampleBundle}`, 500);
  }
  return { kind: 'bundle', bundlePath: path.resolve(cfg.sampleBundle), label: cfg.sampleLabel };
}

async function stripRemotes(repo) {
  const listed = await gitText(repo, ['remote'], { allowNonZero: true });
  if (listed.exitCode !== 0) return;
  for (const name of listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean)) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) continue;
    await gitText(repo, ['remote', 'remove', name], { allowNonZero: true });
  }
}

async function writeMinimalConfig(repo) {
  const cfg = getConfig();
  const body = [
    '[core]',
    '\trepositoryformatversion = 0',
    '\tfilemode = true',
    '\tbare = false',
    '\tlogallrefupdates = true',
    '\thooksPath = /dev/null',
    '\tautocrlf = false',
    '',
  ].join('\n');
  await writeFile(path.join(repo, '.git', 'config'), body);
  await gitText(repo, ['config', 'user.name', cfg.authorName]);
  await gitText(repo, ['config', 'user.email', cfg.authorEmail]);
  await gitText(repo, ['config', 'commit.gpgsign', 'false']);
}

async function assertNoEscapingSymlinks(repo) {
  const root = await realpath(repo);
  const rootWith = root.endsWith(path.sep) ? root : root + path.sep;
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let resolved;
        try {
          resolved = await realpath(full);
        } catch {
          const target = await readlink(full);
          resolved = path.resolve(path.dirname(full), target);
        }
        if (resolved !== root && !resolved.startsWith(rootWith)) {
          throw new AppError(`Sample contains a symlink that escapes the repository: ${path.relative(repo, full)}`, 500);
        }
        continue;
      }
      if (entry.isDirectory()) await walk(full);
    }
  }
  await walk(repo);
}

async function assertNoEscapingSymlinkObjects(repo) {
  const raw = await gitText(repo, ['log', '--all', '--pretty=format:', '--raw', '--no-color'], {
    allowNonZero: true,
    maxOutput: 4_000_000,
    allowTruncate: true,
  });
  const oids = new Set();
  for (const line of raw.stdout.split('\n')) {
    const match = /^:\d+ 120000 [0-9a-f]+ ([0-9a-f]+)/i.exec(line);
    if (match) oids.add(match[1]);
  }
  for (const oid of oids) {
    const blob = await gitText(repo, ['cat-file', '-p', oid], { allowNonZero: true, maxOutput: 10_000 });
    const target = blob.stdout.replace(/\n$/, '');
    if (target.startsWith('/') || target.split('/').includes('..')) {
      throw new AppError(`Sample contains a symlink that escapes the repository: ${target}`, 500);
    }
  }
}

async function materialize(sample, repo) {
  const cfg = getConfig();
  if (sample.kind === 'bundle') {
    await gitText(null, ['clone', '--quiet', sample.bundlePath, repo], { timeout: cfg.cloneTimeoutMs });
  } else if (sample.kind === 'url') {
    await gitText(null, ['clone', '--quiet', sample.url, repo], { timeout: cfg.cloneTimeoutMs });
  } else {
    const sourceFormat = await gitText(sample.path, ['rev-parse', '--show-object-format'], { allowNonZero: true });
    if (sourceFormat.exitCode === 0 && sourceFormat.stdout.trim() !== 'sha1') {
      throw new AppError(`Only SHA-1 repositories are supported (this sample is ${sourceFormat.stdout.trim()})`, 500);
    }
    await gitText(null, ['clone', '--no-local', '--no-hardlinks', '--quiet', sample.path, repo], {
      timeout: cfg.cloneTimeoutMs,
    });
  }
  const format = await gitText(repo, ['rev-parse', '--show-object-format'], { allowNonZero: true });
  const objectFormat = format.stdout.trim();
  if (format.exitCode !== 0 || objectFormat !== 'sha1') {
    throw new AppError(`Only SHA-1 repositories are supported (this sample is ${objectFormat || 'unknown'})`, 500);
  }
  await stripRemotes(repo);
  await writeMinimalConfig(repo);
  await assertNoEscapingSymlinks(repo);
  await assertNoEscapingSymlinkObjects(repo);
  const check = await gitText(repo, ['rev-parse', '--is-inside-work-tree'], { allowNonZero: true });
  if (check.stdout.trim() !== 'true') throw new AppError('Sample did not materialize as a Git work tree', 500);
}

export function enqueue(session, fn) {
  const cfg = getConfig();
  if (session.closing) throw new AppError('Session not found', 404);
  if (session.pending >= cfg.queueLimit) {
    const error = new AppError('Too many queued commands for this session', 429);
    error.retryAfter = 2;
    throw error;
  }
  session.pending += 1;
  const run = session.queue.then(fn, fn);
  session.queue = run.then(() => undefined, () => undefined);
  return run.finally(() => {
    session.pending -= 1;
  });
}

async function closeSession(session) {
  if (!session || session.closing) return;
  session.closing = true;
  sessions.delete(session.id);
  try {
    await session.queue;
  } catch {
    // The in-flight command already failed.
  }
  await rm(session.dir, { recursive: true, force: true });
}

function sessionsFor(clientKey) {
  return [...sessions.values()]
    .filter((session) => !session.closing && session.clientKey === clientKey)
    .sort((a, b) => a.lastUsed - b.lastUsed);
}

async function evictOwnToCap(cfg, clientKey) {
  const own = sessionsFor(clientKey);
  const pending = pendingByClient.get(clientKey) || 0;
  while (own.length + pending >= cfg.maxSessionsPerClient && own.length) {
    await closeSession(own.shift());
  }
}

async function evictIdleToFit(cfg) {
  const now = Date.now();
  const idle = [...sessions.values()]
    .filter((session) => !session.closing && now - session.lastUsed >= cfg.idleEvictMs)
    .sort((a, b) => a.lastUsed - b.lastUsed);
  while (sessions.size + pendingCreates >= cfg.maxSessions && idle.length) {
    await closeSession(idle.shift());
  }
}

function releasePending(clientKey) {
  pendingCreates -= 1;
  const left = (pendingByClient.get(clientKey) || 1) - 1;
  if (left <= 0) pendingByClient.delete(clientKey);
  else pendingByClient.set(clientKey, left);
}

export async function createSession(options = {}) {
  const cfg = getConfig();
  const clientKey = options.clientKey || 'local';
  await mkdir(cfg.sandboxRoot, { recursive: true });
  const sample = resolveSample(cfg);
  await withSlot(async () => {
    await evictOwnToCap(cfg, clientKey);
    if (sessionsFor(clientKey).length + (pendingByClient.get(clientKey) || 0) >= cfg.maxSessionsPerClient) {
      const error = new AppError('Too many sandboxes for this client', 429);
      error.retryAfter = 5;
      throw error;
    }
    await evictIdleToFit(cfg);
    if (sessions.size + pendingCreates >= cfg.maxSessions) {
      const error = new AppError('Too many active sessions. Try again shortly.', 503);
      error.retryAfter = 30;
      throw error;
    }
    pendingCreates += 1;
    pendingByClient.set(clientKey, (pendingByClient.get(clientKey) || 0) + 1);
  });

  const id = randomUUID();
  const dir = path.join(cfg.sandboxRoot, id);
  const repo = path.join(dir, 'repo');
  try {
    await acquireClone();
    try {
      await mkdir(dir, { recursive: true });
      await materialize(sample, repo);
    } finally {
      releaseClone();
    }
  } catch (error) {
    releasePending(clientKey);
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  const session = {
    id,
    dir,
    repo,
    sample,
    clientKey,
    createdAt: Date.now(),
    lastUsed: Date.now(),
    queue: Promise.resolve(),
    pending: 0,
    closing: false,
    lastSnapshot: null,
  };
  sessions.set(id, session);
  releasePending(clientKey);
  return session;
}

export function getSession(id) {
  if (typeof id !== 'string' || !UUID_RE.test(id) || !sessions.has(id)) {
    throw new AppError('Session not found', 404);
  }
  const session = sessions.get(id);
  if (session.closing) throw new AppError('Session not found', 404);
  session.lastUsed = Date.now();
  return session;
}

export async function rebuildRepo(session) {
  session.lastSnapshot = null;
  await rm(session.repo, { recursive: true, force: true });
  await materialize(session.sample, session.repo);
  session.lastUsed = Date.now();
  return session;
}

async function worktreeUsage(repo) {
  let bytes = 0;
  let files = 0;
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      files += 1;
      const st = await lstat(full);
      bytes += st.size;
    }
  }
  await walk(repo);
  return { bytes, files };
}

async function directoryBytes(dir) {
  let bytes = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      bytes += await directoryBytes(full);
      continue;
    }
    if (!entry.isFile()) continue;
    const st = await lstat(full);
    bytes += st.size;
  }
  return bytes;
}

export async function assertGitQuota(repo) {
  const cfg = getConfig();
  const bytes = await directoryBytes(path.join(repo, '.git'));
  if (bytes > cfg.sessionMaxGitBytes) {
    throw new AppError('Session object store quota exceeded', 413);
  }
}

export async function assertWorktreeQuota(repo, full, nextBytes) {
  const cfg = getConfig();
  const usage = await worktreeUsage(repo);
  let previous = 0;
  let exists = false;
  try {
    const st = await accessInside(path.resolve(repo), full, 'lstat');
    if (st.isFile()) {
      exists = true;
      previous = st.size;
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    exists = false;
  }
  const files = usage.files + (exists ? 0 : 1);
  const bytes = usage.bytes - previous + nextBytes;
  if (files > cfg.sessionMaxFiles) throw new AppError('Session file quota exceeded', 413);
  if (bytes > cfg.sessionMaxBytes) throw new AppError('Session disk quota exceeded', 413);
}

export async function resolveInside(repo, rel) {
  if (typeof rel !== 'string' || !rel.trim()) throw new AppError('Path is required');
  const safe = assertSafePath(rel);
  if (safe === '.') throw new AppError('Path must be a file');
  const root = path.resolve(repo);
  const full = path.resolve(root, safe);
  if (escapesRoot(root, full)) throw new AppError('Path escapes the sandbox');
  let cursor = root;
  for (const part of safe.split('/')) {
    cursor = path.resolve(cursor, part);
    if (escapesRoot(root, cursor)) throw new AppError('Path escapes the sandbox');
    try {
      const st = await accessInside(root, cursor, 'lstat');
      if (st.isSymbolicLink()) throw new AppError('Refusing to follow a symlink');
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error.code === 'ENOENT') return full;
      throw error;
    }
  }
  return full;
}

async function realDirectory(root, dir) {
  if (dir === root) return root;
  const realDir = await accessInside(root, dir, 'realpath');
  if (realDir !== root && escapesRoot(root, realDir)) throw new AppError('Path escapes the sandbox');
  return realDir;
}

export async function writeWorktreeFile(session, rel, content) {
  const root = path.resolve(session.repo);
  const full = await resolveInside(session.repo, rel);
  await assertWorktreeQuota(session.repo, full, Buffer.byteLength(String(content)));
  const dir = path.resolve(path.dirname(full));
  if (dir === root) await mkdir(root, { recursive: true });
  else await accessInside(root, dir, 'mkdir');
  await realDirectory(root, dir);
  try {
    await accessInside(root, full, 'write', String(content));
  } catch (error) {
    if (error.code === 'ELOOP') throw new AppError('Refusing to follow a symlink');
    throw error;
  }
}

export async function deleteWorktreeFile(session, rel) {
  const root = path.resolve(session.repo);
  const full = await resolveInside(session.repo, rel);
  await realDirectory(root, path.resolve(path.dirname(full)));
  let st;
  try {
    st = await accessInside(root, full, 'lstat');
  } catch (error) {
    if (error.code === 'ENOENT') throw new AppError('File not found', 404);
    throw error;
  }
  if (st.isSymbolicLink()) throw new AppError('Refusing to delete a symlink');
  if (!st.isFile()) throw new AppError('Refusing to delete a directory');
  let handle;
  try {
    handle = await accessInside(root, full, 'openRead');
  } catch (error) {
    if (error.code === 'ELOOP') throw new AppError('Refusing to follow a symlink');
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== st.ino || opened.dev !== st.dev) {
      throw new AppError('Refusing to follow a symlink');
    }
  } finally {
    await handle.close();
  }
  await accessInside(root, full, 'rm');
}

export async function cleanupOldSandboxes() {
  const cfg = getConfig();
  let entries;
  try {
    entries = await readdir(cfg.sandboxRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory() || !UUID_RE.test(entry.name)) continue;
    const dir = path.join(cfg.sandboxRoot, entry.name);
    const session = sessions.get(entry.name);
    if (session) {
      if (now - session.lastUsed <= cfg.sandboxTtlMs) continue;
      await closeSession(session);
      continue;
    }
    const st = await lstat(dir);
    if (now - st.mtimeMs <= cfg.sandboxTtlMs) continue;
    await rm(dir, { recursive: true, force: true });
  }
}

export async function touchSession(session) {
  session.lastUsed = Date.now();
  const now = new Date();
  await utimes(session.dir, now, now);
}

export function publicSample() {
  return describeSample();
}
