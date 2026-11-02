function computeReachable(snapshot) {
  const commits = new Map(snapshot.objects.commits.map((obj) => [obj.oid, obj]));
  const trees = new Map(snapshot.objects.trees.map((obj) => [obj.oid, obj]));
  const seen = new Set();
  const stack = [];
  const tags = new Map((snapshot.objects.tags || []).map((obj) => [obj.oid, obj]));
  if (snapshot.head?.oid) stack.push(snapshot.head.oid);
  for (const ref of snapshot.refs || []) {
    stack.push(ref.oid);
    if (ref.peeled) stack.push(ref.peeled);
  }
  for (const entry of snapshot.index || []) stack.push(entry.oid);

  while (stack.length) {
    const oid = stack.pop();
    if (!oid || seen.has(oid)) continue;
    seen.add(oid);
    const commit = commits.get(oid);
    if (commit) {
      if (commit.tree) stack.push(commit.tree);
      for (const parent of commit.parents || []) stack.push(parent);
      continue;
    }
    const tree = trees.get(oid);
    if (tree) {
      for (const entry of tree.entries || []) stack.push(entry.oid);
      continue;
    }
    const tag = tags.get(oid);
    if (tag?.object) stack.push(tag.object);
  }
  return seen;
}

export function markReachable(snapshot) {
  const reachable = computeReachable(snapshot);
  for (const group of [
    snapshot.objects.commits,
    snapshot.objects.trees,
    snapshot.objects.blobs,
    snapshot.objects.tags || [],
  ]) {
    for (const obj of group) obj.reachable = reachable.has(obj.oid);
  }
  return reachable;
}

function pickHead(head) {
  return {
    name: head?.name ?? null,
    oid: head?.oid ?? null,
    detached: Boolean(head?.detached),
  };
}

function diffRefs(before, after) {
  const previous = new Map(before.map((ref) => [ref.name, ref]));
  const next = new Map(after.map((ref) => [ref.name, ref]));
  const added = [];
  const removed = [];
  const modified = [];
  for (const [name, ref] of next) {
    if (!previous.has(name)) added.push({ name, oid: ref.oid });
    else if (previous.get(name).oid !== ref.oid) {
      modified.push({ name, before: previous.get(name).oid, after: ref.oid });
    }
  }
  for (const [name, ref] of previous) {
    if (!next.has(name)) removed.push({ name, oid: ref.oid });
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  added.sort(byName);
  removed.sort(byName);
  modified.sort(byName);
  return { added, removed, modified };
}

function sameFile(a, b) {
  return a.oid === b.oid
    && a.content === b.content
    && Boolean(a.missing) === Boolean(b.missing)
    && Boolean(a.symlink) === Boolean(b.symlink)
    && (a.target || null) === (b.target || null);
}

function diffFiles(before, after) {
  const previous = new Map(before.map((file) => [file.path, file]));
  const next = new Map(after.map((file) => [file.path, file]));
  const added = [];
  const removed = [];
  const modified = [];
  for (const [filePath, file] of next) {
    if (!previous.has(filePath)) {
      if (!file.missing) added.push(filePath);
      continue;
    }
    const prior = previous.get(filePath);
    if (file.missing && !prior.missing) removed.push(filePath);
    else if (!file.missing && prior.missing) added.push(filePath);
    else if (!sameFile(prior, file)) modified.push(filePath);
  }
  for (const [filePath, file] of previous) {
    if (!next.has(filePath) && !file.missing) removed.push(filePath);
  }
  added.sort();
  removed.sort();
  modified.sort();
  return { added, removed, modified };
}

function diffIndex(before, after) {
  const keyOf = (entry) => `${entry.stage}\0${entry.path}`;
  const previous = new Map(before.map((entry) => [keyOf(entry), entry]));
  const next = new Map(after.map((entry) => [keyOf(entry), entry]));
  const added = [];
  const removed = [];
  const modified = [];
  for (const [key, entry] of next) {
    if (!previous.has(key)) added.push(entry);
    else if (previous.get(key).oid !== entry.oid || previous.get(key).mode !== entry.mode) modified.push(entry);
  }
  for (const [key, entry] of previous) {
    if (!next.has(key)) removed.push(entry);
  }
  const slim = (entry) => ({ path: entry.path, stage: entry.stage });
  const sort = (a, b) => a.path.localeCompare(b.path) || a.stage - b.stage;
  return {
    added: added.map(slim).sort(sort),
    removed: removed.map(slim).sort(sort),
    modified: modified.map(slim).sort(sort),
  };
}

function diffOids(before, after) {
  const previous = new Set(before.map((obj) => obj.oid));
  const next = new Set(after.map((obj) => obj.oid));
  return {
    added: [...next].filter((oid) => !previous.has(oid)).sort(),
    removed: [...previous].filter((oid) => !next.has(oid)).sort(),
  };
}

function diffReachability(before, after) {
  const previous = computeReachable(before);
  const next = computeReachable(after);
  const beforeIds = new Set([
    ...before.objects.commits.map((obj) => obj.oid),
    ...before.objects.trees.map((obj) => obj.oid),
    ...before.objects.blobs.map((obj) => obj.oid),
    ...(before.objects.tags || []).map((obj) => obj.oid),
  ]);
  const afterIds = new Set([
    ...after.objects.commits.map((obj) => obj.oid),
    ...after.objects.trees.map((obj) => obj.oid),
    ...after.objects.blobs.map((obj) => obj.oid),
    ...(after.objects.tags || []).map((obj) => obj.oid),
  ]);
  const gained = [];
  const lost = [];
  for (const oid of afterIds) {
    if (beforeIds.has(oid) && next.has(oid) && !previous.has(oid)) gained.push(oid);
  }
  for (const oid of beforeIds) {
    if (afterIds.has(oid) && previous.has(oid) && !next.has(oid)) lost.push(oid);
  }
  gained.sort();
  lost.sort();
  return { gained, lost };
}

export function diffSnapshots(before, after) {
  const head = {
    before: pickHead(before.head),
    after: pickHead(after.head),
    changed: before.head?.oid !== after.head?.oid
      || before.head?.name !== after.head?.name
      || Boolean(before.head?.detached) !== Boolean(after.head?.detached),
  };
  const objects = {
    commits: diffOids(before.objects.commits, after.objects.commits),
    trees: diffOids(before.objects.trees, after.objects.trees),
    blobs: diffOids(before.objects.blobs, after.objects.blobs),
  };
  if (before.objectsTruncated || after.objectsTruncated) {
    objects.commits.removed = [];
    objects.trees.removed = [];
    objects.blobs.removed = [];
  }
  return {
    head,
    refs: diffRefs(before.refs || [], after.refs || []),
    worktree: diffFiles(before.worktree || [], after.worktree || []),
    index: diffIndex(before.index || [], after.index || []),
    objects,
    reachability: diffReachability(before, after),
  };
}

export function summarizeChanges(changes, after = null) {
  const parts = [];
  const count = (n, noun) => {
    if (n) parts.push(`${n} new ${noun}${n === 1 ? '' : 's'}`);
  };
  count(changes.objects.commits.added.length, 'commit');
  count(changes.objects.trees.added.length, 'tree');
  count(changes.objects.blobs.added.length, 'blob');
  const gone = changes.objects.commits.removed.length
    + changes.objects.trees.removed.length
    + changes.objects.blobs.removed.length;
  if (gone) parts.push(`${gone} object${gone === 1 ? '' : 's'} removed from the store`);
  if (changes.reachability.lost.length) {
    parts.push(`${changes.reachability.lost.length} now unreachable`);
  }
  if (changes.refs.added.length) {
    parts.push(`${changes.refs.added.length} ref${changes.refs.added.length === 1 ? '' : 's'} added`);
  }
  if (changes.refs.removed.length) {
    parts.push(`${changes.refs.removed.length} ref${changes.refs.removed.length === 1 ? '' : 's'} removed`);
  }
  if (changes.refs.modified.length) {
    parts.push(`${changes.refs.modified.length} ref${changes.refs.modified.length === 1 ? '' : 's'} moved`);
  }
  if (changes.head.changed) parts.push('HEAD moved');
  const worktreeChanged = changes.worktree.added.length + changes.worktree.removed.length + changes.worktree.modified.length;
  if (worktreeChanged) parts.push('working tree changed');
  const indexChanged = changes.index.added.length + changes.index.removed.length + changes.index.modified.length;
  if (indexChanged) parts.push('index changed');
  if (after?.index?.some((entry) => entry.stage > 0)) parts.push('index has a merge conflict');
  if (!parts.length) return 'No changes in the worktree, index, refs, or object store';
  return parts.join(' · ');
}
