import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { executeGit } from '../server/commands.js';
import { diffSnapshots } from '../server/diff.js';
import { createSession, deleteWorktreeFile, resolveInside, writeWorktreeFile } from '../server/sandbox.js';
import { captureSnapshot } from '../server/snapshot.js';

const sandboxRoot = mkdtempSync(path.join(os.tmpdir(), 'behindgit-flow-'));
process.env.BEHINDGIT_SANDBOX_ROOT = sandboxRoot;

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  return { server, port };
}

async function json(port, urlPath, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.json();
  return { status: response.status, body };
}

test('moon sandbox story: commit, branch, merge, and reset', { timeout: 60_000 }, async () => {
  const app = createApp();
  const { server, port } = await listen(app);
  const marker = path.join(os.tmpdir(), `behindgit-pwn-${process.pid}`);
  try {
    const created = await json(port, '/api/sessions', { method: 'POST', body: '{}' });
    assert.equal(created.status, 201);
    const id = created.body.id;
    const original = created.body.snapshot.head.oid;
    assert.equal(created.body.sample.label, 'moon');
    assert.equal(created.body.snapshot.objects.commits.length, 3);
    assert.equal(created.body.snapshot.objects.commits[0].message, 'Added unit test for main.py');
    assert.equal(created.body.snapshot.objects.commits[0].signed, true);
    const testFile = created.body.snapshot.worktree.find((file) => file.path === 'test_main.py');
    assert.match(testFile.content, /hello_oop/);

    const injected = await json(port, `/api/sessions/${id}/command`, {
      method: 'POST',
      body: JSON.stringify({ command: `git add .; touch ${marker}` }),
    });
    assert.equal(injected.status, 400);
    assert.equal(existsSync(marker), false);

    const traversal = await json(port, `/api/sessions/${id}/files`, {
      method: 'PUT',
      body: JSON.stringify({ path: '../../etc/passwd', content: 'nope' }),
    });
    assert.equal(traversal.status, 400);

    const pushed = await json(port, `/api/sessions/${id}/command`, {
      method: 'POST',
      body: JSON.stringify({ command: 'git push origin main' }),
    });
    assert.equal(pushed.status, 400);

    const fixed = testFile.content.replace('from hello_oop import Greeter', 'from main import Greeter');
    const written = await json(port, `/api/sessions/${id}/files`, {
      method: 'PUT',
      body: JSON.stringify({ path: 'test_main.py', content: fixed }),
    });
    assert.equal(written.status, 200);
    assert.equal(written.body.changes.objects.commits.added.length, 0);
    assert.ok(written.body.changes.worktree.modified.includes('test_main.py'));

    const added = await json(port, `/api/sessions/${id}/command`, {
      method: 'POST',
      body: JSON.stringify({ command: 'git add test_main.py' }),
    });
    assert.equal(added.body.exitCode, 0);
    assert.equal(added.body.changes.objects.blobs.added.length, 1);
    assert.equal(added.body.changes.objects.commits.added.length, 0);
    assert.deepEqual(added.body.argv, ['add', '--', 'test_main.py']);

    const committed = await json(port, `/api/sessions/${id}/command`, {
      method: 'POST',
      body: JSON.stringify({ command: 'git commit -m "Fix Greeter import"' }),
    });
    assert.equal(committed.body.exitCode, 0, committed.body.stderr);
    assert.equal(committed.body.changes.objects.commits.added.length, 1);
    assert.equal(committed.body.changes.head.changed, true);
    assert.match(committed.body.summary, /1 new commit/);
    const fixOid = committed.body.after.head.oid;

    const branched = await json(port, `/api/sessions/${id}/command`, {
      method: 'POST',
      body: JSON.stringify({ command: 'git switch -c feature-greeting' }),
    });
    assert.equal(branched.body.exitCode, 0, branched.body.stderr);
    assert.equal(branched.body.after.head.name, 'feature-greeting');

    const mainPy = branched.body.after.worktree.find((file) => file.path === 'main.py');
    const greeting = mainPy.content.replace(
      'return f"Hello, {self.name}!"',
      'return f"Hello, {self.name}! Welcome to the moon."',
    );
    const edited = await json(port, `/api/sessions/${id}/files`, {
      method: 'PUT',
      body: JSON.stringify({ path: 'main.py', content: greeting }),
    });
    assert.equal(edited.status, 200);
    await json(port, `/api/sessions/${id}/command`, {
      method: 'POST',
      body: JSON.stringify({ command: 'git add main.py' }),
    });
    const featureCommit = await json(port, `/api/sessions/${id}/command`, {
      method: 'POST',
      body: JSON.stringify({ command: 'git commit -m "Personalize the greeting"' }),
    });
    assert.equal(featureCommit.body.exitCode, 0, featureCommit.body.stderr);
    const featureOid = featureCommit.body.after.head.oid;

    const back = await json(port, `/api/sessions/${id}/command`, {
      method: 'POST',
      body: JSON.stringify({ command: 'git switch main' }),
    });
    assert.equal(back.body.exitCode, 0, back.body.stderr);
    assert.equal(back.body.after.head.oid, fixOid);

    const merged = await json(port, `/api/sessions/${id}/command`, {
      method: 'POST',
      body: JSON.stringify({ command: 'git merge feature-greeting --no-ff -m "Merge feature-greeting"' }),
    });
    assert.equal(merged.body.exitCode, 0, merged.body.stderr);
    assert.equal(merged.body.changes.objects.commits.added.length, 1);
    const mergeCommit = merged.body.after.objects.commits.find((commit) => commit.oid === merged.body.after.head.oid);
    assert.equal(mergeCommit.parents.length, 2);
    assert.ok(mergeCommit.parents.includes(fixOid));
    assert.ok(mergeCommit.parents.includes(featureOid));
    assert.match(mergeCommit.message, /Merge feature-greeting/);

    const reset = await json(port, `/api/sessions/${id}/reset`, { method: 'POST', body: '{}' });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.snapshot.head.oid, original);
    assert.equal(reset.body.snapshot.objects.commits.length, 3);
    assert.match(reset.body.snapshot.worktree.find((file) => file.path === 'test_main.py').content, /hello_oop/);
  } finally {
    server.close();
    rmSync(marker, { force: true });
  }
});

test('reset --soft, --mixed, and --hard leave different index and worktree states', { timeout: 60_000 }, async () => {
  const session = await createSession();
  try {
    const write = async (name, content) => {
      const { writeWorktreeFile } = await import('../server/sandbox.js');
      await writeWorktreeFile(session, name, content);
    };
    await write('notes.txt', 'one\n');
    let result = await executeGit(session.repo, 'git add notes.txt');
    assert.equal(result.exitCode, 0);
    result = await executeGit(session.repo, 'git commit -m "Add notes"');
    assert.equal(result.exitCode, 0, result.stderr);
    const committed = await captureSnapshot(session.repo);
    const notesOid = committed.head.oid;

    result = await executeGit(session.repo, 'git reset --soft HEAD~1');
    assert.equal(result.exitCode, 0, result.stderr);
    const soft = await captureSnapshot(session.repo);
    const softChanges = diffSnapshots(committed, soft);
    assert.notEqual(soft.head.oid, notesOid);
    assert.equal(soft.index.find((entry) => entry.path === 'notes.txt').oid, committed.index.find((entry) => entry.path === 'notes.txt').oid);
    assert.ok(soft.worktree.some((file) => file.path === 'notes.txt' && !file.missing));
    assert.ok(softChanges.reachability.lost.includes(notesOid));

    result = await executeGit(session.repo, 'git commit -m "Add notes again"');
    assert.equal(result.exitCode, 0, result.stderr);
    const again = await captureSnapshot(session.repo);
    assert.notEqual(again.head.oid, soft.head.oid);
    result = await executeGit(session.repo, 'git reset --mixed HEAD~1');
    assert.equal(result.exitCode, 0, result.stderr);
    const mixed = await captureSnapshot(session.repo);
    assert.equal(mixed.index.some((entry) => entry.path === 'notes.txt'), false);
    const mixedNotes = mixed.worktree.find((file) => file.path === 'notes.txt');
    assert.equal(mixedNotes.missing, false);
    assert.equal(mixedNotes.content, 'one\n');

    result = await executeGit(session.repo, 'git add notes.txt');
    result = await executeGit(session.repo, 'git commit -m "Add notes once more"');
    assert.equal(result.exitCode, 0, result.stderr);
    result = await executeGit(session.repo, 'git reset --hard HEAD~1');
    assert.equal(result.exitCode, 0, result.stderr);
    const hard = await captureSnapshot(session.repo);
    const hardNotes = hard.worktree.find((file) => file.path === 'notes.txt');
    assert.ok(!hardNotes || hardNotes.missing);
    assert.equal(hard.index.some((entry) => entry.path === 'notes.txt'), false);
    assert.equal(hard.head.oid, soft.head.oid);
  } finally {
    await rm(session.dir, { recursive: true, force: true });
  }
});

test('worktree writes stay inside the sandbox', async () => {
  const session = await createSession();
  const outside = path.join(session.dir, 'outside.txt');
  try {
    await assert.rejects(() => resolveInside(session.repo, '../outside.txt'), /not allowed/);
    await assert.rejects(() => writeWorktreeFile(session, '../outside.txt', 'nope'), /not allowed/);
    await symlink(outside, path.join(session.repo, 'linked'));
    await assert.rejects(() => writeWorktreeFile(session, 'linked', 'nope'), /symlink/);
    await assert.rejects(() => deleteWorktreeFile(session, 'linked'), /symlink/);
    assert.equal(existsSync(outside), false);
    await writeWorktreeFile(session, 'notes/a.txt', 'hi\n');
    assert.equal(existsSync(path.join(session.repo, 'notes', 'a.txt')), true);
    await deleteWorktreeFile(session, 'notes/a.txt');
    assert.equal(existsSync(path.join(session.repo, 'notes', 'a.txt')), false);
  } finally {
    await rm(session.dir, { recursive: true, force: true });
  }
});

test.after(() => {
  rmSync(sandboxRoot, { recursive: true, force: true });
});
