import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { executeGit } from '../server/commands.js';
import { gitText, requestContext } from '../server/git.js';
import { assertGitQuota, closeSession, createSession, rebuildRepo, resolveInside, writeWorktreeFile } from '../server/sandbox.js';
import { captureSnapshot } from '../server/snapshot.js';

const exec = promisify(execFile);
const dirs = [];
const sandboxRoot = await mkdtemp(path.join(os.tmpdir(), 'behindgit-review-'));
process.env.BEHINDGIT_SANDBOX_ROOT = sandboxRoot;
process.env.BEHINDGIT_RATE_CREATE_PER_MIN = '1000';
process.env.BEHINDGIT_RATE_COMMAND_PER_MIN = '1000';
process.env.BEHINDGIT_MAX_SESSIONS = '100';
process.env.BEHINDGIT_MAX_SESSIONS_PER_CLIENT = '100';

async function git(repo, args, env = {}) {
  await exec('git', ['-C', repo, ...args], {
    env: { ...process.env, ...env },
  });
}

async function initRepo(name = 'main') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'behindgit-review-repo-'));
  dirs.push(dir);
  await exec('git', ['init', '-q', '-b', name, dir]);
  await git(dir, ['config', 'user.email', 't@example.com']);
  await git(dir, ['config', 'user.name', 'Tester']);
  return dir;
}

test.describe('review regressions', { concurrency: false }, () => {

test('commits follow git rev-list --topo-order, not committer date', async () => {
  const repo = await initRepo();
  await writeFile(path.join(repo, 'a'), 'a\n');
  await git(repo, ['add', 'a']);
  await git(repo, ['commit', '-m', 'A'], {
    GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
  });
  await git(repo, ['switch', '-c', 'side']);
  await writeFile(path.join(repo, 'c'), 'c\n');
  await git(repo, ['add', 'c']);
  await git(repo, ['commit', '-m', 'C'], {
    GIT_AUTHOR_DATE: '2020-01-02T00:00:00Z',
    GIT_COMMITTER_DATE: '2020-01-02T00:00:00Z',
  });
  await git(repo, ['switch', 'main']);
  await writeFile(path.join(repo, 'b'), 'b\n');
  await git(repo, ['add', 'b']);
  await git(repo, ['commit', '-m', 'B'], {
    GIT_AUTHOR_DATE: '2020-01-05T00:00:00Z',
    GIT_COMMITTER_DATE: '2020-01-05T00:00:00Z',
  });
  await git(repo, ['merge', '--no-ff', 'side', '-m', 'M'], {
    GIT_AUTHOR_DATE: '2020-01-06T00:00:00Z',
    GIT_COMMITTER_DATE: '2020-01-06T00:00:00Z',
  });

  const snapshot = await captureSnapshot(repo);
  const messages = snapshot.objects.commits.map((commit) => commit.message);
  const { stdout } = await exec('git', ['-C', repo, 'rev-list', '--topo-order', '--all']);
  const topo = stdout.trim().split('\n');
  assert.deepEqual(snapshot.objects.commits.map((commit) => commit.oid), topo);
  const byDate = [...snapshot.objects.commits].sort((a, b) => (b.committer?.time || 0) - (a.committer?.time || 0));
  assert.notDeepEqual(messages, byDate.map((commit) => commit.message));
  assert.ok(messages.indexOf('C') < messages.indexOf('B'));
});

test('oversized blobs are metadata, and ignored files are labelled ignored', async () => {
  const saved = process.env.BEHINDGIT_MAX_BLOB_BYTES;
  process.env.BEHINDGIT_MAX_BLOB_BYTES = '30';
  try {
    const repo = await initRepo();
    await writeFile(path.join(repo, '.gitignore'), 'secret.txt\n');
    await writeFile(path.join(repo, 'secret.txt'), 'hidden\n');
    await writeFile(path.join(repo, 'big.txt'), 'x'.repeat(80));
    await git(repo, ['add', '.gitignore', 'big.txt']);
    await git(repo, ['commit', '-m', 'add files']);
    const snapshot = await captureSnapshot(repo);
    const big = snapshot.objects.blobs.find((blob) => blob.size === 80);
    assert.ok(big);
    assert.equal(big.truncated, true);
    assert.equal(big.content, null);
    const ignored = snapshot.worktree.find((file) => file.path === 'secret.txt');
    assert.equal(ignored.statusLabel, 'ignored');
    assert.equal(snapshot.warnings.length, 0);
  } finally {
    if (saved === undefined) delete process.env.BEHINDGIT_MAX_BLOB_BYTES;
    else process.env.BEHINDGIT_MAX_BLOB_BYTES = saved;
  }
});

test('an unborn branch keeps its name, and an annotated tag is peeled', async () => {
  const empty = await initRepo('topic');
  const unborn = await captureSnapshot(empty);
  assert.equal(unborn.head.unborn, true);
  assert.equal(unborn.head.name, 'topic');
  assert.equal(unborn.head.oid, null);

  const repo = await initRepo();
  await writeFile(path.join(repo, 'hello.txt'), 'hello\n');
  await git(repo, ['add', 'hello.txt']);
  await git(repo, ['commit', '-m', 'hello']);
  await git(repo, ['tag', '-a', 'v1', '-m', 'release']);
  const snapshot = await captureSnapshot(repo);
  assert.equal(snapshot.objects.tags.length, 1);
  assert.equal(snapshot.objects.tags[0].name, 'v1');
  assert.equal(snapshot.objects.tags[0].object, snapshot.head.oid);
  const tag = snapshot.refs.find((ref) => ref.name === 'refs/tags/v1');
  assert.equal(tag.peeled, snapshot.head.oid);
  assert.equal(tag.peeledType, 'commit');
});

test('user paths are literal, and checkout of a commit detaches', async () => {
  assert.match(executeGit.toString(), /GIT_LITERAL_PATHSPECS/);
  const repo = await initRepo();
  await writeFile(path.join(repo, 'magic*.txt'), 'literal\n');
  await writeFile(path.join(repo, 'magicX.txt'), 'other\n');
  await git(repo, ['add', 'magicX.txt']);
  await git(repo, ['commit', '-m', 'base']);
  const added = await gitText(repo, ['add', '--', 'magic*.txt'], {
    allowNonZero: true,
    env: { GIT_LITERAL_PATHSPECS: '1' },
  });
  assert.equal(added.exitCode, 0, added.stderr);
  const staged = await gitText(repo, ['diff', '--cached', '--name-only']);
  assert.equal(staged.stdout.trim(), 'magic*.txt');

  const head = (await gitText(repo, ['rev-parse', 'HEAD'])).stdout.trim();
  const detached = await executeGit(repo, `git checkout ${head}`);
  assert.deepEqual(detached.argv, ['checkout', '--detach', head]);
  assert.equal(detached.exitCode, 0, detached.stderr);
  const after = await captureSnapshot(repo);
  assert.equal(after.head.detached, true);
  assert.equal(after.head.oid, head);
});

test('git reset of a path unstages that file only', async () => {
  const repo = await initRepo();
  await writeFile(path.join(repo, 'keep.txt'), 'keep\n');
  await git(repo, ['add', 'keep.txt']);
  await git(repo, ['commit', '-m', 'base']);
  await writeFile(path.join(repo, 'notes.txt'), 'notes\n');
  await writeFile(path.join(repo, 'keep.txt'), 'keep more\n');
  const added = await executeGit(repo, 'git add notes.txt keep.txt');
  assert.equal(added.exitCode, 0, added.stderr);
  const reset = await executeGit(repo, 'git reset notes.txt');
  assert.deepEqual(reset.argv, ['reset', '--', 'notes.txt']);
  assert.equal(reset.exitCode, 0, reset.stderr);
  const snapshot = await captureSnapshot(repo);
  assert.equal(snapshot.index.some((entry) => entry.path === 'notes.txt'), false);
  assert.equal(snapshot.index.some((entry) => entry.path === 'keep.txt'), true);
  assert.equal(snapshot.worktree.find((file) => file.path === 'notes.txt').content, 'notes\n');
});

test('worktree paths reject traversal, absolute paths, and .git', async () => {
  const session = await createSession();
  try {
    await assert.rejects(() => resolveInside(session.repo, '/etc/passwd'), /Absolute paths/);
    await assert.rejects(() => resolveInside(session.repo, 'a/../b'), /not allowed/);
    await assert.rejects(() => resolveInside(session.repo, '.GIT/config'), /not allowed/);
    await assert.rejects(() => writeWorktreeFile(session, ':(top)', 'nope'), /Pathspec magic/);
  } finally {
    await rm(session.dir, { recursive: true, force: true });
  }
});

test('a session stops accepting files past its quota', async () => {
  const savedFiles = process.env.BEHINDGIT_SESSION_MAX_FILES;
  const savedBytes = process.env.BEHINDGIT_SESSION_MAX_BYTES;
  process.env.BEHINDGIT_SESSION_MAX_FILES = '1000';
  process.env.BEHINDGIT_SESSION_MAX_BYTES = '1';
  const session = await createSession();
  try {
    await assert.rejects(() => writeWorktreeFile(session, 'quota.txt', 'too much'), /quota exceeded/);
    assert.equal(await stat(path.join(session.repo, 'quota.txt')).then(() => true, () => false), false);
  } finally {
    if (savedFiles === undefined) delete process.env.BEHINDGIT_SESSION_MAX_FILES;
    else process.env.BEHINDGIT_SESSION_MAX_FILES = savedFiles;
    if (savedBytes === undefined) delete process.env.BEHINDGIT_SESSION_MAX_BYTES;
    else process.env.BEHINDGIT_SESSION_MAX_BYTES = savedBytes;
    await rm(session.dir, { recursive: true, force: true });
  }
});

test('a path sample is cloned without hardlinking objects', async () => {
  const source = await initRepo();
  await writeFile(path.join(source, 'hello.txt'), 'hello\n');
  await git(source, ['add', 'hello.txt']);
  await git(source, ['commit', '-m', 'hello']);
  const saved = process.env.BEHINDGIT_SAMPLE_PATH;
  process.env.BEHINDGIT_SAMPLE_PATH = source;
  const session = await createSession();
  try {
    const oid = (await exec('git', ['-C', source, 'rev-parse', 'HEAD:hello.txt'])).stdout.trim();
    const loose = path.join(source, '.git', 'objects', oid.slice(0, 2), oid.slice(2));
    const { stdout: linked } = await exec('find', [session.repo, '-samefile', loose]);
    assert.equal(linked.trim(), '');
    const copied = (await exec('git', ['-C', session.repo, 'rev-parse', 'HEAD:hello.txt'])).stdout.trim();
    assert.equal(copied, oid);
  } finally {
    if (saved === undefined) delete process.env.BEHINDGIT_SAMPLE_PATH;
    else process.env.BEHINDGIT_SAMPLE_PATH = saved;
    await rm(session.dir, { recursive: true, force: true });
  }
});

test('a request past its deadline does not start another git command', async () => {
  const repo = await initRepo();
  await assert.rejects(
    () => requestContext.run({ deadlineAt: Date.now() - 5 }, () => gitText(repo, ['status'])),
    /deadline exceeded/,
  );
});

test('a slashed branch name resets to that revision', async () => {
  const repo = await initRepo();
  await writeFile(path.join(repo, 'a'), 'a\n');
  await git(repo, ['add', 'a']);
  await git(repo, ['commit', '-m', 'first']);
  const first = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
  await git(repo, ['branch', 'feature/login']);
  await writeFile(path.join(repo, 'b'), 'b\n');
  await git(repo, ['add', 'b']);
  await git(repo, ['commit', '-m', 'second']);
  const result = await executeGit(repo, 'git reset feature/login');
  assert.equal(result.exitCode, 0);
  const head = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
  assert.equal(head, first);
});

test('an over-budget object read is truncated, not an empty snapshot', async () => {
  const repo = await initRepo();
  await writeFile(path.join(repo, 'big'), 'x'.repeat(800));
  await git(repo, ['add', 'big']);
  await git(repo, ['commit', '-m', 'big']);
  process.env.BEHINDGIT_MAX_OBJECT_BYTES = '500';
  try {
    const snapshot = await captureSnapshot(repo);
    assert.equal(snapshot.objectsTruncated, true);
    assert.ok(snapshot.objects.commits.some((commit) => commit.message.includes('big')));
  } finally {
    delete process.env.BEHINDGIT_MAX_OBJECT_BYTES;
  }
});

test('a failed object read is marked so it is not reused as a baseline', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'behindgit-not-a-repo-'));
  dirs.push(dir);
  const snapshot = await captureSnapshot(dir);
  assert.equal(snapshot.readFailed, true);
  assert.equal(snapshot.objects.commits.length, 0);
});

test('the object store quota rejects another command', async () => {
  const repo = await initRepo();
  await writeFile(path.join(repo, 'a'), 'a\n');
  await git(repo, ['add', 'a']);
  await git(repo, ['commit', '-m', 'a']);
  process.env.BEHINDGIT_SESSION_MAX_GIT_BYTES = '1';
  try {
    await assert.rejects(() => assertGitQuota(repo), /Reset sandbox/);
  } finally {
    delete process.env.BEHINDGIT_SESSION_MAX_GIT_BYTES;
  }
});

test('the object store quota ignores the cloned sample and counts later growth', async () => {
  const source = await initRepo();
  await writeFile(path.join(source, 'base'), 'base\n');
  await git(source, ['add', 'base']);
  await git(source, ['commit', '-m', 'base']);
  const savedPath = process.env.BEHINDGIT_SAMPLE_PATH;
  const savedCap = process.env.BEHINDGIT_SESSION_MAX_GIT_BYTES;
  process.env.BEHINDGIT_SAMPLE_PATH = source;
  process.env.BEHINDGIT_SESSION_MAX_GIT_BYTES = '1';
  let session;
  try {
    session = await createSession({ clientKey: 'quota-growth' });
    assert.ok(session.gitBaselineBytes > 0);
    await assertGitQuota(session.repo, session.gitBaselineBytes);
    await writeFile(path.join(session.repo, 'more'), 'x'.repeat(4096));
    await git(session.repo, ['add', 'more']);
    await git(session.repo, ['commit', '-m', 'more']);
    await assert.rejects(() => assertGitQuota(session.repo, session.gitBaselineBytes), /past the sample/);
    const baseline = session.gitBaselineBytes;
    await rebuildRepo(session);
    assert.equal(session.gitBaselineBytes, baseline);
    await assertGitQuota(session.repo, session.gitBaselineBytes);
  } finally {
    if (session) await closeSession(session);
    if (savedPath === undefined) delete process.env.BEHINDGIT_SAMPLE_PATH;
    else process.env.BEHINDGIT_SAMPLE_PATH = savedPath;
    if (savedCap === undefined) delete process.env.BEHINDGIT_SESSION_MAX_GIT_BYTES;
    else process.env.BEHINDGIT_SESSION_MAX_GIT_BYTES = savedCap;
  }
});

test('command output redacts the sandbox root', async () => {
  const session = await createSession();
  const result = await executeGit(session.dir, 'git status');
  assert.notEqual(result.exitCode, 0);
  const text = `${result.stdout}\n${result.stderr}`;
  assert.equal(text.includes(session.dir), false);
  assert.match(text, /\[sandbox\]/);
});

test('sha256 samples are rejected', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'behindgit-sha256-'));
  dirs.push(dir);
  try {
    await exec('git', ['init', '-q', '--object-format=sha256', '-b', 'main', dir]);
    await exec('git', ['-C', dir, 'config', 'user.email', 't@example.com']);
    await exec('git', ['-C', dir, 'config', 'user.name', 'Tester']);
    await writeFile(path.join(dir, 'a'), 'a\n');
    await exec('git', ['-C', dir, 'add', 'a']);
    await exec('git', ['-C', dir, 'commit', '-q', '-m', 'sha256']);
  } catch (error) {
    t.skip(`git cannot create a sha256 repo: ${error.message}`);
    return;
  }
  const saved = process.env.BEHINDGIT_SAMPLE_PATH;
  process.env.BEHINDGIT_SAMPLE_PATH = dir;
  try {
    await assert.rejects(() => createSession(), /SHA-1/);
  } finally {
    if (saved === undefined) delete process.env.BEHINDGIT_SAMPLE_PATH;
    else process.env.BEHINDGIT_SAMPLE_PATH = saved;
  }
});

});

test.after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  await rm(sandboxRoot, { recursive: true, force: true });
});
