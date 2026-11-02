import assert from 'node:assert/strict';
import test from 'node:test';
import { diffSnapshots, summarizeChanges } from '../server/diff.js';

function blob(oid, content = oid) {
  return { oid, type: 'blob', content, size: content.length, binary: false, truncated: false };
}

function tree(oid, entries) {
  return { oid, type: 'tree', entries };
}

function commit(oid, { tree: treeOid, parents = [], message }) {
  return {
    oid,
    type: 'commit',
    tree: treeOid,
    parents,
    message,
    author: { time: 1 },
    committer: { time: 1 },
    patches: [],
  };
}

function file(path, oid, content) {
  return {
    path,
    oid,
    content,
    missing: false,
    symlink: false,
    target: null,
  };
}

function snap({ head, refs, commits, trees, blobs, worktree, index }) {
  return {
    head,
    refs,
    objects: { commits, trees, blobs },
    worktree,
    index,
  };
}

const C1 = 'a'.repeat(40);
const C2 = 'b'.repeat(40);
const T1 = 'c'.repeat(40);
const T2 = 'd'.repeat(40);
const B1 = 'e'.repeat(40);
const B2 = 'f'.repeat(40);

function beforeCommit() {
  return snap({
    head: { name: 'main', oid: C1, detached: false },
    refs: [{ name: 'refs/heads/main', oid: C1 }],
    commits: [commit(C1, { tree: T1, message: 'base' })],
    trees: [tree(T1, [{ mode: '100644', type: 'blob', oid: B1, name: 'hello.txt' }])],
    blobs: [blob(B1, 'hello\n')],
    worktree: [file('hello.txt', B1, 'hello\n')],
    index: [{ path: 'hello.txt', stage: 0, oid: B1, mode: '100644' }],
  });
}

test('a new commit adds a commit, a tree, and a blob and moves HEAD', () => {
  const before = beforeCommit();
  const after = snap({
    head: { name: 'main', oid: C2, detached: false },
    refs: [{ name: 'refs/heads/main', oid: C2 }],
    commits: [
      commit(C2, { tree: T2, parents: [C1], message: 'edit' }),
      commit(C1, { tree: T1, message: 'base' }),
    ],
    trees: [
      tree(T2, [{ mode: '100644', type: 'blob', oid: B2, name: 'hello.txt' }]),
      tree(T1, [{ mode: '100644', type: 'blob', oid: B1, name: 'hello.txt' }]),
    ],
    blobs: [blob(B2, 'hello!\n'), blob(B1, 'hello\n')],
    worktree: [file('hello.txt', B2, 'hello!\n')],
    index: [{ path: 'hello.txt', stage: 0, oid: B2, mode: '100644' }],
  });
  const changes = diffSnapshots(before, after);
  assert.deepEqual(changes.objects.commits.added, [C2]);
  assert.deepEqual(changes.objects.trees.added, [T2]);
  assert.deepEqual(changes.objects.blobs.added, [B2]);
  assert.deepEqual(changes.objects.commits.removed, []);
  assert.equal(changes.head.changed, true);
  assert.equal(changes.head.after.oid, C2);
  assert.deepEqual(changes.refs.modified, [{ name: 'refs/heads/main', before: C1, after: C2 }]);
  assert.deepEqual(changes.worktree.modified, ['hello.txt']);
  assert.deepEqual(changes.index.modified, [{ path: 'hello.txt', stage: 0 }]);
  const summary = summarizeChanges(changes, after);
  assert.match(summary, /1 new commit/);
  assert.match(summary, /1 new tree/);
  assert.match(summary, /1 new blob/);
  assert.match(summary, /HEAD moved/);
});

test('soft reset keeps the objects but marks the undone commit unreachable', () => {
  const before = snap({
    head: { name: 'main', oid: C2, detached: false },
    refs: [{ name: 'refs/heads/main', oid: C2 }],
    commits: [
      commit(C2, { tree: T2, parents: [C1], message: 'edit' }),
      commit(C1, { tree: T1, message: 'base' }),
    ],
    trees: [
      tree(T2, [{ mode: '100644', type: 'blob', oid: B2, name: 'hello.txt' }]),
      tree(T1, [{ mode: '100644', type: 'blob', oid: B1, name: 'hello.txt' }]),
    ],
    blobs: [blob(B1, 'hello\n'), blob(B2, 'hello!\n')],
    worktree: [file('hello.txt', B2, 'hello!\n')],
    index: [{ path: 'hello.txt', stage: 0, oid: B2, mode: '100644' }],
  });
  const after = snap({
    head: { name: 'main', oid: C1, detached: false },
    refs: [{ name: 'refs/heads/main', oid: C1 }],
    commits: before.objects.commits,
    trees: before.objects.trees,
    blobs: before.objects.blobs,
    worktree: before.worktree,
    index: before.index,
  });
  const changes = diffSnapshots(before, after);
  assert.deepEqual(changes.objects.commits.added, []);
  assert.deepEqual(changes.objects.commits.removed, []);
  assert.deepEqual(changes.reachability.lost, [C2, T2]);
  assert.ok(!changes.reachability.lost.includes(B2));
  assert.equal(changes.index.modified.length, 0);
  assert.match(summarizeChanges(changes), /now unreachable/);
  assert.match(summarizeChanges(changes), /HEAD moved/);
});

test('identical snapshots have an empty diff', () => {
  const before = beforeCommit();
  const changes = diffSnapshots(before, before);
  assert.equal(changes.head.changed, false);
  assert.deepEqual(changes.objects.blobs.added, []);
  assert.deepEqual(changes.worktree.modified, []);
  assert.equal(summarizeChanges(changes), 'No changes in the worktree, index, refs, or object store');
});

test('a merge conflict in the index is called out', () => {
  const before = beforeCommit();
  const after = beforeCommit();
  after.index = [
    { path: 'hello.txt', stage: 1, oid: B1, mode: '100644' },
    { path: 'hello.txt', stage: 2, oid: B1, mode: '100644' },
    { path: 'hello.txt', stage: 3, oid: B2, mode: '100644' },
  ];
  const changes = diffSnapshots(before, after);
  assert.deepEqual(changes.index.removed, [{ path: 'hello.txt', stage: 0 }]);
  assert.equal(changes.index.added.length, 3);
  assert.match(summarizeChanges(changes, after), /merge conflict/);
});
