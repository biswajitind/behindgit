import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { diffSnapshots } from '../server/diff.js';
import {
  captureSnapshot,
  parseCatFileBatch,
  parseCommitText,
  parseLsFiles,
  parsePorcelain,
  parseTreeBuffer,
} from '../server/snapshot.js';

const exec = promisify(execFile);
const dirs = [];

async function git(repo, args) {
  await exec('git', ['-C', repo, ...args]);
}

async function initRepo() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'behindgit-snap-'));
  dirs.push(dir);
  await exec('git', ['init', '-q', '-b', 'main', dir]);
  await git(dir, ['config', 'user.email', 't@example.com']);
  await git(dir, ['config', 'user.name', 'Tester']);
  return dir;
}

test.after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

test('parseCommitText keeps the message behind a gpgsig header', () => {
  const raw = [
    'tree aaaa',
    'parent bbbb',
    'author Ada <ada@example.com> 10 +0000',
    'committer Ada <ada@example.com> 11 +0000',
    'gpgsig -----BEGIN PGP SIGNATURE-----',
    ' abcdef',
    ' -----END PGP SIGNATURE-----',
    '',
    'Signed message',
    '',
  ].join('\n');
  const parsed = parseCommitText(raw);
  assert.equal(parsed.message, 'Signed message');
  assert.equal(parsed.tree, 'aaaa');
  assert.deepEqual(parsed.parents, ['bbbb']);
  assert.equal(parsed.signed, true);
  assert.equal(parsed.author.name, 'Ada');
  assert.equal(parsed.author.time, 10);
});

test('parsePorcelain and parseLsFiles read git -z records', () => {
  assert.deepEqual(parsePorcelain('M  a.txt\0 D b.txt\0?? c.txt\0R  b.txt\0a.txt\0'), [
    { xy: 'M ', path: 'a.txt', originalPath: null },
    { xy: ' D', path: 'b.txt', originalPath: null },
    { xy: '??', path: 'c.txt', originalPath: null },
    { xy: 'R ', path: 'b.txt', originalPath: 'a.txt' },
  ]);
  const oid = 'a'.repeat(40);
  assert.deepEqual(parseLsFiles(`100644 ${oid} 0\thello.txt\0`), [
    { mode: '100644', oid, stage: 0, path: 'hello.txt' },
  ]);
});

test('parseTreeBuffer matches a real tree object', async () => {
  const repo = await initRepo();
  await writeFile(path.join(repo, 'hello.txt'), 'hello\n');
  await git(repo, ['add', 'hello.txt']);
  await git(repo, ['commit', '-m', 'add hello']);
  const { stdout: treeOid } = await exec('git', ['-C', repo, 'rev-parse', 'HEAD^{tree}']);
  const raw = await exec('git', ['-C', repo, 'cat-file', 'tree', treeOid.trim()], { encoding: 'buffer' });
  const entries = parseTreeBuffer(raw.stdout);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'hello.txt');
  assert.equal(entries[0].type, 'blob');
  assert.equal(entries[0].mode, '100644');
  const listed = await exec('git', ['-C', repo, 'rev-parse', 'HEAD:hello.txt']);
  assert.equal(entries[0].oid, listed.stdout.trim());
});

test('parseCatFileBatch splits size-delimited records', () => {
  const body = Buffer.from('hello');
  const header = Buffer.from(`abc blob ${body.length}\n`);
  const buf = Buffer.concat([header, body, Buffer.from('\n')]);
  const [obj] = parseCatFileBatch(buf);
  assert.equal(obj.oid, 'abc');
  assert.equal(obj.type, 'blob');
  assert.equal(obj.content.toString(), 'hello');
});

test('captureSnapshot sees a commit, and a later edit stays out of the object store until add', async () => {
  const repo = await initRepo();
  await writeFile(path.join(repo, 'hello.txt'), 'hello\n');
  await git(repo, ['add', 'hello.txt']);
  await git(repo, ['commit', '-m', 'add hello']);
  const committed = await captureSnapshot(repo);
  assert.equal(committed.head.name, 'main');
  assert.equal(committed.objects.commits[0].message, 'add hello');
  assert.equal(committed.objects.commits[0].parents.length, 0);
  assert.equal(committed.objects.commits[0].reachable, true);
  const hello = committed.worktree.find((file) => file.path === 'hello.txt');
  const blob = committed.objects.blobs.find((item) => item.content === 'hello\n');
  assert.ok(blob);
  assert.equal(hello.oid, blob.oid);
  assert.equal(committed.index.find((entry) => entry.path === 'hello.txt').oid, blob.oid);
  assert.equal(committed.patches.indexVsHead.trim(), '');

  await writeFile(path.join(repo, 'hello.txt'), 'hello!\n');
  const edited = await captureSnapshot(repo);
  assert.equal(edited.objects.commits.length, committed.objects.commits.length);
  assert.equal(edited.worktree.find((file) => file.path === 'hello.txt').content, 'hello!\n');
  assert.match(edited.patches.worktreeVsIndex, /hello!/);
  assert.equal(edited.objects.blobs.some((item) => item.content === 'hello!\n'), false);

  await git(repo, ['add', 'hello.txt']);
  const staged = await captureSnapshot(repo);
  const changes = diffSnapshots(edited, staged);
  assert.equal(changes.objects.commits.added.length, 0);
  assert.equal(changes.objects.blobs.added.length, 1);
  assert.deepEqual(changes.index.modified, [{ path: 'hello.txt', stage: 0 }]);
  const stagedBlob = staged.objects.blobs.find((item) => item.content === 'hello!\n');
  assert.equal(staged.index.find((entry) => entry.path === 'hello.txt').oid, stagedBlob.oid);
});

test('captureSnapshot reports the new commit after git commit', async () => {
  const repo = await initRepo();
  await writeFile(path.join(repo, 'hello.txt'), 'hello\n');
  await git(repo, ['add', 'hello.txt']);
  await git(repo, ['commit', '-m', 'add hello']);
  const before = await captureSnapshot(repo);
  await writeFile(path.join(repo, 'hello.txt'), 'hello!\n');
  await git(repo, ['add', 'hello.txt']);
  await git(repo, ['commit', '-m', 'edit hello']);
  const after = await captureSnapshot(repo);
  const changes = diffSnapshots(before, after);
  assert.equal(changes.objects.commits.added.length, 1);
  assert.ok(changes.objects.trees.added.length >= 1);
  assert.equal(changes.head.changed, true);
  assert.equal(after.objects.commits[0].message, 'edit hello');
  assert.equal(after.objects.commits[0].parents[0], before.head.oid);
  assert.match(after.objects.commits[0].patches.map((patch) => patch.patch).join('\n'), /hello!/);
});
