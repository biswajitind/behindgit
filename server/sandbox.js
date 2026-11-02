import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, lstat, mkdir, readdir, readlink, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertSafePath } from './allowlist.js';
import { describeSample, getConfig } from './config.js';
import { AppError } from './errors.js';
import { gitText } from './git.js';

const sessions = new Map();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

async function materialize(sample, repo) {
  const cfg = getConfig();
  if (sample.kind === 'bundle') {
    await gitText(null, ['clone', '--quiet', sample.bundlePath, repo], { timeout: cfg.cloneTimeoutMs });
  } else if (sample.kind === 'url') {
    await gitText(null, ['clone', '--quiet', sample.url, repo], { timeout: cfg.cloneTimeoutMs });
  } else {
    await cp(sample.path, repo, { recursive: true, verbatimSymlinks: true });
  }
  await stripRemotes(repo);
  await writeMinimalConfig(repo);
  await assertNoEscapingSymlinks(repo);
  const check = await gitText(repo, ['rev-parse', '--is-inside-work-tree'], { allowNonZero: true });
  if (check.stdout.trim() !== 'true') throw new AppError('Sample did not materialize as a Git work tree', 500);
}

export function enqueue(session, fn) {
  const run = session.queue.then(fn, fn);
  session.queue = run.then(() => undefined, () => undefined);
  return run;
}

async function enforceCapacity() {
  const cfg = getConfig();
  if (sessions.size <= cfg.maxSessions) return;
  const sorted = [...sessions.values()].sort((a, b) => a.lastUsed - b.lastUsed);
  while (sessions.size > cfg.maxSessions && sorted.length) {
    const oldest = sorted.shift();
    sessions.delete(oldest.id);
    await rm(oldest.dir, { recursive: true, force: true });
  }
}

export async function createSession() {
  const cfg = getConfig();
  await mkdir(cfg.sandboxRoot, { recursive: true });
  const sample = resolveSample(cfg);
  const id = randomUUID();
  const dir = path.join(cfg.sandboxRoot, id);
  const repo = path.join(dir, 'repo');
  await mkdir(dir, { recursive: true });
  try {
    await materialize(sample, repo);
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  const session = {
    id,
    dir,
    repo,
    sample,
    createdAt: Date.now(),
    lastUsed: Date.now(),
    queue: Promise.resolve(),
  };
  sessions.set(id, session);
  await enforceCapacity();
  return session;
}

export function getSession(id) {
  if (typeof id !== 'string' || !UUID_RE.test(id) || !sessions.has(id)) {
    throw new AppError('Session not found', 404);
  }
  const session = sessions.get(id);
  session.lastUsed = Date.now();
  return session;
}

export async function rebuildRepo(session) {
  await rm(session.repo, { recursive: true, force: true });
  await materialize(session.sample, session.repo);
  session.lastUsed = Date.now();
  return session;
}

export async function resolveInside(repo, rel) {
  if (typeof rel !== 'string' || !rel.trim()) throw new AppError('Path is required');
  const normalized = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  const safe = assertSafePath(normalized);
  if (safe === '.') throw new AppError('Path must be a file');
  const root = path.resolve(repo);
  const full = path.resolve(root, safe);
  const rootWith = root.endsWith(path.sep) ? root : root + path.sep;
  if (full !== root && !full.startsWith(rootWith)) throw new AppError('Path escapes the sandbox');
  let current = root;
  for (const part of safe.split('/')) {
    current = path.join(current, part);
    try {
      const st = await lstat(current);
      if (st.isSymbolicLink()) throw new AppError('Refusing to follow a symlink');
    } catch (error) {
      if (error.code === 'ENOENT') return full;
      throw error;
    }
  }
  return full;
}

export async function writeWorktreeFile(session, rel, content) {
  const full = await resolveInside(session.repo, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, 'utf8');
}

export async function deleteWorktreeFile(session, rel) {
  const full = await resolveInside(session.repo, rel);
  let st;
  try {
    st = await lstat(full);
  } catch (error) {
    if (error.code === 'ENOENT') throw new AppError('File not found', 404);
    throw error;
  }
  if (st.isSymbolicLink()) throw new AppError('Refusing to delete a symlink');
  if (st.isDirectory()) throw new AppError('Refusing to delete a directory');
  await rm(full);
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
    const st = await lstat(dir);
    if (now - st.mtimeMs <= cfg.sandboxTtlMs) continue;
    sessions.delete(entry.name);
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
