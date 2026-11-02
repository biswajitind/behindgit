const PRESETS = [
  'git status',
  'git add test_main.py',
  'git add main.py',
  'git add README.md',
  'git add -A',
  'git commit -m "Fix Greeter import"',
  'git commit -m "Personalize the greeting"',
  'git switch -c feature-greeting',
  'git switch main',
  'git merge feature-greeting --no-ff -m "Merge feature-greeting"',
  'git reset --soft HEAD~1',
  'git reset --mixed HEAD~1',
  'git reset --hard HEAD~1',
  'git log --oneline --decorate --graph --all',
];

const state = {
  id: null,
  sample: null,
  view: null,
  busy: false,
  history: [],
  histIndex: -1,
  draft: '',
  selected: 'test_main.py',
  dirty: false,
  open: new Set(),
  closed: new Set(),
  diffTab: 'commit',
  diffSide: 'after',
};

const $ = (id) => document.getElementById(id);

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function short(oid) {
  return oid ? String(oid).slice(0, 7) : '—';
}

function quoteArg(arg) {
  if (/^[A-Za-z0-9._~/@:=+-]+$/.test(arg)) return arg;
  return `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({ error: 'Bad response from server' }));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function emptyChanges() {
  return {
    head: { changed: false, before: null, after: null },
    refs: { added: [], removed: [], modified: [] },
    worktree: { added: [], removed: [], modified: [] },
    index: { added: [], removed: [], modified: [] },
    objects: {
      commits: { added: [], removed: [] },
      trees: { added: [], removed: [] },
      blobs: { added: [], removed: [] },
    },
    reachability: { gained: [], lost: [] },
  };
}

function viewFromSnapshot(snapshot, summary) {
  return {
    ok: true,
    exitCode: 0,
    command: null,
    argv: null,
    stdout: '',
    stderr: '',
    before: snapshot,
    after: snapshot,
    changes: emptyChanges(),
    summary,
  };
}

function chooseTab(view) {
  const changes = view.changes;
  if (changes.objects.commits.added.length) return 'commit';
  if (
    changes.objects.blobs.added.length
    || changes.objects.trees.added.length
    || changes.reachability.lost.length
    || changes.objects.commits.removed.length
  ) return 'objects';
  if ((view.after.patches?.indexVsHead || '').trim()) return 'index';
  if ((view.after.patches?.worktreeVsIndex || '').trim()) return 'worktree';
  return 'commit';
}

function setBusy(busy) {
  state.busy = busy;
  $('run-btn').disabled = busy;
  $('reset-btn').disabled = busy;
  $('save-btn').disabled = busy;
  document.querySelectorAll('[data-command], [data-suggest]').forEach((button) => {
    button.disabled = busy;
  });
}

async function boot() {
  setBusy(true);
  try {
    const config = await api('/api/config');
    state.sample = config;
    $('sample-label').textContent = config.label || 'moon';
    if (config.upstream) $('upstream').href = config.upstream;
    const created = await api('/api/sessions', { method: 'POST', body: '{}' });
    state.id = created.id;
    state.sample = created.sample || config;
    state.view = viewFromSnapshot(
      created.snapshot,
      `Fresh ${state.sample.label} sample. Edit a file or run a command to compare before and after.`,
    );
    state.diffTab = 'commit';
    render();
    loadEditor(false);
  } catch (error) {
    $('command-line').textContent = 'Could not start a sandbox';
    $('summary').textContent = error.message;
  } finally {
    setBusy(false);
  }
}

async function runCommand(command) {
  const trimmed = command.trim();
  if (!trimmed || state.busy) return;
  if (!state.history.length || state.history[state.history.length - 1] !== trimmed) {
    state.history.push(trimmed);
  }
  state.histIndex = state.history.length;
  $('command-input').value = trimmed;
  setBusy(true);
  $('command-line').textContent = `Running ${trimmed}`;
  try {
    const result = await api(`/api/sessions/${state.id}/command`, {
      method: 'POST',
      body: JSON.stringify({ command: trimmed }),
    });
    applyResult(result);
  } catch (error) {
    if (error.status === 404) {
      $('summary').textContent = 'Session expired. Starting a fresh sandbox.';
      await boot();
      return;
    }
    $('command-line').textContent = trimmed;
    $('summary').textContent = error.message;
    $('console').textContent = error.message;
    $('console').classList.add('fail');
  } finally {
    setBusy(false);
  }
}

async function saveFile(filePath, content) {
  setBusy(true);
  try {
    const result = await api(`/api/sessions/${state.id}/files`, {
      method: 'PUT',
      body: JSON.stringify({ path: filePath, content }),
    });
    state.selected = filePath;
    state.dirty = false;
    applyResult(result);
    loadEditor(true);
  } catch (error) {
    $('summary').textContent = error.message;
  } finally {
    setBusy(false);
  }
}

async function deleteSelected() {
  if (!state.selected || state.busy) return;
  setBusy(true);
  try {
    const result = await api(`/api/sessions/${state.id}/files/delete`, {
      method: 'POST',
      body: JSON.stringify({ path: state.selected }),
    });
    state.dirty = false;
    applyResult(result);
    loadEditor(true);
  } catch (error) {
    $('summary').textContent = error.message;
  } finally {
    setBusy(false);
  }
}

async function resetSandbox() {
  if (state.busy || !state.id) return;
  setBusy(true);
  try {
    const result = await api(`/api/sessions/${state.id}/reset`, { method: 'POST', body: '{}' });
    state.dirty = false;
    state.open.clear();
    state.closed.clear();
    state.view = viewFromSnapshot(result.snapshot, result.summary);
    state.diffTab = 'commit';
    render();
    loadEditor(true);
  } catch (error) {
    $('summary').textContent = error.message;
  } finally {
    setBusy(false);
  }
}

function applyResult(result) {
  state.view = result;
  state.open.clear();
  state.closed.clear();
  state.diffTab = chooseTab(result);
  render();
}

function fileByPath(snapshot, filePath) {
  return snapshot.worktree.find((file) => file.path === filePath);
}

function loadEditor(force) {
  const file = state.view ? fileByPath(state.view.after, state.selected) : null;
  if (!force && state.dirty) return;
  $('editor').value = file?.content ?? '';
  state.dirty = false;
  renderEditorState();
  renderFileList();
}

function renderEditorState() {
  const file = state.view ? fileByPath(state.view.after, state.selected) : null;
  const bits = [state.selected || 'no file'];
  if (file?.statusLabel && file.statusLabel !== 'clean') bits.push(file.statusLabel);
  if (state.dirty) bits.push('unsaved');
  $('editor-state').textContent = bits.join(' · ');
}

function renderFileList() {
  const files = state.view?.after.worktree || [];
  $('file-list').innerHTML = files.map((file) => (
    `<button type="button" data-file="${esc(file.path)}" class="${file.path === state.selected ? 'on' : ''}">${esc(file.path)}</button>`
  )).join('');
}

function renderPresets() {
  $('presets').innerHTML = PRESETS.map((command) => (
    `<button type="button" data-command="${esc(command)}">${esc(command)}</button>`
  )).join('');
}

function objectName(snapshot, oid) {
  const names = new Set();
  for (const tree of snapshot.objects.trees) {
    for (const entry of tree.entries) {
      if (entry.oid === oid) names.add(entry.name);
    }
  }
  for (const file of snapshot.worktree) if (file.oid === oid) names.add(file.path);
  for (const entry of snapshot.index) if (entry.oid === oid) names.add(entry.path);
  return [...names].slice(0, 2).join(', ');
}

function findObject(snapshot, oid) {
  return snapshot.objects.commits.find((obj) => obj.oid === oid)
    || snapshot.objects.trees.find((obj) => obj.oid === oid)
    || snapshot.objects.blobs.find((obj) => obj.oid === oid);
}

function renderChips(view) {
  const changes = view.changes;
  const chips = [];
  const pushObj = (oid, type, klass) => {
    const obj = findObject(view.after, oid) || findObject(view.before, oid);
    let label = `${type} ${short(oid)}`;
    if (type === 'commit' && obj?.message) label += ` ${obj.message.split('\n')[0]}`;
    if (type === 'blob') {
      const name = objectName(view.after, oid) || objectName(view.before, oid);
      if (name) label += ` ${name}`;
    }
    if (type === 'tree' && obj?.entries) label += ` ${obj.entries.length} entries`;
    chips.push(`<span class="chip ${klass}">${esc(label)}</span>`);
  };
  for (const oid of changes.objects.commits.added) pushObj(oid, 'commit', 'added');
  for (const oid of changes.objects.trees.added) pushObj(oid, 'tree', 'added');
  for (const oid of changes.objects.blobs.added) pushObj(oid, 'blob', 'added');
  for (const oid of changes.objects.commits.removed) pushObj(oid, 'commit', 'removed');
  for (const oid of changes.objects.trees.removed) pushObj(oid, 'tree', 'removed');
  for (const oid of changes.objects.blobs.removed) pushObj(oid, 'blob', 'removed');
  for (const oid of changes.reachability.lost) {
    const obj = findObject(view.after, oid);
    chips.push(`<span class="chip removed">unreachable ${esc(obj?.type || 'object')} ${esc(short(oid))}</span>`);
  }
  for (const ref of changes.refs.added) {
    chips.push(`<span class="chip added">ref ${esc(ref.name.replace('refs/heads/', ''))} ${esc(short(ref.oid))}</span>`);
  }
  for (const ref of changes.refs.modified) {
    chips.push(`<span class="chip changed">${esc(ref.name.replace('refs/heads/', ''))} ${esc(short(ref.before))} → ${esc(short(ref.after))}</span>`);
  }
  for (const ref of changes.refs.removed) {
    chips.push(`<span class="chip removed">ref ${esc(ref.name.replace('refs/heads/', ''))} removed</span>`);
  }
  if (changes.head.changed) chips.push('<span class="chip changed">HEAD moved</span>');
  $('chips').innerHTML = chips.join('');
}

function markSet(changes, side) {
  const added = new Set([
    ...changes.objects.commits.added,
    ...changes.objects.trees.added,
    ...changes.objects.blobs.added,
  ]);
  const removed = new Set([
    ...changes.objects.commits.removed,
    ...changes.objects.trees.removed,
    ...changes.objects.blobs.removed,
  ]);
  const lost = new Set(changes.reachability.lost);
  return { added, removed, lost, side };
}

function objectClass(oid, marks) {
  if (marks.side === 'after' && marks.added.has(oid)) return 'added';
  if (marks.side === 'before' && marks.removed.has(oid)) return 'removed';
  if (marks.side === 'after' && marks.lost.has(oid)) return 'removed';
  return '';
}

function isOpen(side, oid, marks) {
  const key = `${side}:${oid}`;
  if (state.closed.has(key)) return false;
  if (state.open.has(key)) return true;
  return marks.side === 'after' && (marks.added.has(oid) || marks.lost.has(oid));
}

function layoutCommits(commits) {
  const rows = commits.map((commit) => ({ ...commit, lane: 0, joins: [] }));
  const indexOf = new Map(rows.map((row, index) => [row.oid, index]));
  const active = [];
  for (const row of rows) {
    let lane = active.indexOf(row.oid);
    if (lane === -1) {
      lane = active.findIndex((value) => value == null);
      if (lane === -1) lane = active.length;
    }
    row.lane = lane;
    const parents = (row.parents || []).filter((parent) => indexOf.has(parent));
    active[lane] = parents[0] || null;
    for (let i = 1; i < parents.length; i += 1) {
      let parentLane = active.indexOf(parents[i]);
      if (parentLane === -1) {
        parentLane = active.findIndex((value) => value == null);
        if (parentLane === -1) parentLane = active.length;
        active[parentLane] = parents[i];
      }
      row.joins.push(parentLane);
    }
  }
  return { rows, laneCount: Math.max(1, active.length) };
}

function renderGraph(snapshot, marks, side) {
  const commits = snapshot.objects.commits;
  if (!commits.length) return '<p class="empty">No commits in the object store.</p>';
  const { rows, laneCount } = layoutCommits(commits);
  const rowH = 46;
  const laneW = 14;
  const pad = 8;
  const width = laneCount * laneW + pad;
  const height = rows.length * rowH;
  const pos = new Map(rows.map((row, index) => [row.oid, {
    x: pad / 2 + row.lane * laneW + 4,
    y: index * rowH + rowH / 2,
  }]));
  const paths = [];
  for (const row of rows) {
    const from = pos.get(row.oid);
    for (const parent of row.parents || []) {
      const to = pos.get(parent);
      if (!from || !to) continue;
      if (Math.abs(from.x - to.x) < 1) paths.push(`<path d="M${from.x} ${from.y} L${to.x} ${to.y}" />`);
      else {
        const mid = from.y + rowH * 0.62;
        paths.push(`<path d="M${from.x} ${from.y} L${from.x} ${mid} L${to.x} ${mid} L${to.x} ${to.y}" />`);
      }
    }
  }
  const dots = rows.map((row) => {
    const point = pos.get(row.oid);
    const klass = objectClass(row.oid, marks);
    const unreachable = row.reachable === false ? 'unreachable' : '';
    return `<circle class="${klass} ${unreachable}" cx="${point.x}" cy="${point.y}" r="4" />`;
  }).join('');
  const cards = rows.map((row) => {
    const klass = objectClass(row.oid, marks);
    const parents = (row.parents || []).map(short).join(', ') || 'root';
    const flags = [
      klass === 'added' ? '<span class="badge added">added</span>' : '',
      row.reachable === false ? '<span class="badge removed">unreachable</span>' : '',
      row.parents?.length > 1 ? '<span class="badge">merge</span>' : '',
      row.signed ? '<span class="badge">signed</span>' : '',
    ].join('');
    return `<div class="commit-row" style="padding-left:${width}px">
      <button type="button" class="commit-card linkish ${klass}" data-open="${esc(side)}:${esc(row.tree)}">
        <div class="msg">${flags}${esc(row.message.split('\n')[0] || '(no message)')}</div>
        <div class="meta">commit ${esc(short(row.oid))} · tree ${esc(short(row.tree))} · ${esc(parents)}</div>
      </button>
    </div>`;
  }).join('');
  return `<div class="graph" style="height:${height}px">
    <svg class="graph-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${paths.join('')}${dots}</svg>
    ${cards}
  </div>`;
}

function renderDetails(snapshot, marks, side) {
  const bits = [];
  const headCommit = snapshot.objects.commits.find((commit) => commit.oid === snapshot.head.oid);
  const headTree = headCommit?.tree;
  const interesting = [
    ...snapshot.objects.trees.filter((tree) => tree.oid === headTree || isOpen(side, tree.oid, marks)),
    ...snapshot.objects.blobs.filter((blob) => isOpen(side, blob.oid, marks)),
  ];
  const seen = new Set();
  for (const obj of interesting) {
    if (seen.has(obj.oid)) continue;
    seen.add(obj.oid);
    if (bits.length > 8) break;
    const klass = objectClass(obj.oid, marks);
    if (obj.type === 'tree') {
      const entries = obj.entries.map((entry) => (
        `<div class="entry"><span class="kind ${esc(entry.type)}">${esc(entry.type)}</span><span>${esc(entry.name)}</span><span class="muted">${esc(short(entry.oid))}</span></div>`
      )).join('');
      bits.push(`<div class="obj detail ${klass}"><div class="meta">tree ${esc(short(obj.oid))} · ${obj.entries.length} entries</div>${entries}</div>`);
    } else {
      const name = objectName(snapshot, obj.oid);
      const preview = obj.binary
        ? 'Binary blob'
        : (obj.content || '').split('\n').slice(0, 40).join('\n');
      bits.push(`<div class="obj detail ${klass}"><div class="meta">blob ${esc(short(obj.oid))}${name ? ` · ${esc(name)}` : ''}${obj.truncated ? ' · truncated' : ''}</div><pre>${esc(preview)}</pre></div>`);
    }
  }
  const head = snapshot.objects.commits.find((commit) => commit.oid === snapshot.head.oid);
  if (head && !bits.length) {
    const tree = snapshot.objects.trees.find((item) => item.oid === head.tree);
    if (tree) {
      const entries = tree.entries.map((entry) => (
        `<div class="entry"><span class="kind ${esc(entry.type)}">${esc(entry.type)}</span><span>${esc(entry.name)}</span><span class="muted">${esc(short(entry.oid))}</span></div>`
      )).join('');
      bits.push(`<div class="obj detail"><div class="meta">HEAD tree ${esc(short(tree.oid))}</div>${entries}</div>`);
    }
  }
  return bits.join('');
}

function fileRowClass(side, file, changes) {
  if (file.missing) return 'removed';
  if (side === 'after' && changes.worktree.added.includes(file.path)) return 'added';
  if (changes.worktree.modified.includes(file.path)) return 'changed';
  if (side === 'before' && changes.worktree.removed.includes(file.path)) return 'removed';
  return '';
}

function indexRowClass(side, entry, changes) {
  const hit = (list) => list.some((item) => item.path === entry.path && item.stage === entry.stage);
  if (side === 'after' && hit(changes.index.added)) return 'added';
  if (hit(changes.index.modified)) return 'changed';
  if (side === 'before' && hit(changes.index.removed)) return 'removed';
  if (entry.state === 'added') return 'added';
  if (entry.state === 'modified' || entry.state === 'unmerged') return 'changed';
  return '';
}

function stageLabel(stage) {
  if (stage === 1) return 'base';
  if (stage === 2) return 'ours';
  if (stage === 3) return 'theirs';
  return 'stage';
}

function renderPane(side, view) {
  const snapshot = view[side];
  const changes = view.changes;
  const marks = markSet(changes, side);
  const headChanged = changes.head.changed;
  const refs = snapshot.refs.filter((ref) => ref.kind !== 'remote');
  const refHtml = refs.map((ref) => {
    const modified = changes.refs.modified.some((item) => item.name === ref.name);
    const added = changes.refs.added.some((item) => item.name === ref.name);
    let klass = ref.current ? 'current' : '';
    if (side === 'after' && added) klass += ' added';
    if (modified) klass += ' changed';
    return `<span class="ref ${klass}">${esc(ref.short)} ${esc(short(ref.oid))}</span>`;
  }).join('');
  const ghosts = side === 'after'
    ? changes.refs.removed.map((ref) => `<span class="ref removed">${esc(ref.name.replace('refs/heads/', ''))} removed</span>`).join('')
    : '';
  const files = snapshot.worktree.map((file) => (
    `<button type="button" class="row linkish ${fileRowClass(side, file, changes)}" data-file="${esc(file.path)}">
      <span class="status">${esc(file.statusLabel || 'clean')}</span>
      <span class="path">${esc(file.path)}</span>
      <span class="oid">${esc(short(file.oid))}</span>
    </button>`
  )).join('');
  const indexRows = snapshot.index.map((entry) => (
    `<div class="row ${indexRowClass(side, entry, changes)}">
      <span class="status">${esc(entry.stage ? stageLabel(entry.stage) : (entry.state || 'staged'))}</span>
      <span class="path">${esc(entry.path)}</span>
      <span class="oid">${esc(short(entry.oid))}</span>
    </div>`
  )).join('');
  const indexGhosts = side === 'after'
    ? changes.index.removed.map((entry) => (
      `<div class="row removed"><span class="status">removed</span><span class="path">${esc(entry.path)}</span><span class="oid">${esc(stageLabel(entry.stage))}</span></div>`
    )).join('')
    : '';
  const indexHtml = `${indexRows}${indexGhosts}`;
  return `<div class="pane-kicker"><strong>${side === 'before' ? 'Before' : 'After'}</strong><span>${esc(view.command || 'current sandbox')}</span></div>
    <div class="head-line">
      <span>HEAD</span>
      <strong>${esc(snapshot.head.name || 'HEAD')}</strong>
      <code>${esc(short(snapshot.head.oid))}</code>
      ${snapshot.head.detached ? '<em>detached</em>' : ''}
      ${side === 'after' && headChanged ? '<em>moved</em>' : ''}
    </div>
    <div class="ref-row">${refHtml}${ghosts}</div>
    <div class="lists">
      <div><h3>Working tree</h3>${files || '<p class="empty">Empty</p>'}</div>
      <div><h3>Index</h3>${indexHtml || '<p class="empty">Empty index</p>'}</div>
    </div>
    <div class="section-label">Objects</div>
    ${renderGraph(snapshot, marks, side)}
    ${renderDetails(snapshot, marks, side)}`;
}

function renderPatch(text) {
  if (!text || !text.trim()) return '<p class="empty">No difference.</p>';
  const lines = text.replace(/\n$/, '').split('\n').slice(0, 500);
  const html = lines.map((line) => {
    let klass = 'ctx';
    if (/^(diff |index |new file |deleted file |old mode |new mode |similarity |rename |copy |\+\+\+|---)/.test(line)) klass = 'meta';
    else if (line.startsWith('@@')) klass = 'hunk';
    else if (line.startsWith('+')) klass = 'add';
    else if (line.startsWith('-')) klass = 'del';
    return `<div class="${klass}">${esc(line) || ' '}</div>`;
  }).join('');
  const extra = text.split('\n').length > 500 ? '<p class="empty">Diff truncated in the view.</p>' : '';
  return `<div class="diff">${html}</div>${extra}`;
}

function renderCommitDiff(view) {
  const added = new Set(view.changes.objects.commits.added);
  const source = view.after;
  let commits = source.objects.commits.filter((commit) => added.has(commit.oid));
  if (!commits.length && source.head.oid) {
    commits = source.objects.commits.filter((commit) => commit.oid === source.head.oid);
  }
  if (!commits.length) return '<p class="empty">No commit to show.</p>';
  return commits.map((commit) => {
    const patches = (commit.patches || []).map((patch) => {
      const title = patch.parent ? `against parent ${short(patch.parent)}` : 'root commit';
      const body = patch.patch && patch.patch.trim()
        ? renderPatch(patch.patch)
        : '<p class="empty">No content difference against this parent. The tree already matched.</p>';
      return `<div class="meta">${esc(title)}</div>${body}`;
    }).join('');
    return `<article class="commit-diff">
      <h3>${esc(commit.message.split('\n')[0] || '(no message)')}</h3>
      <div class="meta">commit ${esc(commit.oid)} · ${esc(commit.parents.length ? commit.parents.map(short).join(', ') : 'root')}</div>
      ${patches || '<p class="empty">Patch not captured.</p>'}
    </article>`;
  }).join('');
}

function renderObjectDelta(view) {
  const changes = view.changes;
  const rows = [];
  const line = (klass, text) => rows.push(`<div class="chip ${klass}">${esc(text)}</div>`);
  for (const oid of changes.objects.commits.added) line('added', `added commit ${oid}`);
  for (const oid of changes.objects.trees.added) line('added', `added tree ${oid}`);
  for (const oid of changes.objects.blobs.added) {
    const name = objectName(view.after, oid);
    line('added', `added blob ${oid}${name ? ` (${name})` : ''}`);
  }
  for (const oid of changes.objects.commits.removed) line('removed', `removed commit ${oid}`);
  for (const oid of changes.objects.trees.removed) line('removed', `removed tree ${oid}`);
  for (const oid of changes.objects.blobs.removed) line('removed', `removed blob ${oid}`);
  for (const oid of changes.reachability.lost) line('removed', `now unreachable ${oid}`);
  for (const oid of changes.reachability.gained) line('changed', `reachable again ${oid}`);
  for (const ref of changes.refs.modified) line('changed', `${ref.name} ${ref.before} → ${ref.after}`);
  for (const ref of changes.refs.added) line('added', `added ref ${ref.name} ${ref.oid}`);
  for (const ref of changes.refs.removed) line('removed', `removed ref ${ref.name}`);
  if (!rows.length) return '<p class="empty">The object store and refs did not change. Git objects are immutable, so an edit only shows up here after git add creates a blob.</p>';
  return `<div class="chips" style="justify-content:flex-start">${rows.join('')}</div>`;
}

function renderDiffs() {
  const view = state.view;
  if (!view) return;
  const tabs = [
    ['worktree', 'Worktree ↔ index'],
    ['index', 'Index ↔ HEAD'],
    ['commit', 'Commit diff'],
    ['objects', 'Object store'],
  ];
  $('diff-tabs').innerHTML = tabs.map(([id, label]) => (
    `<button type="button" data-tab="${id}" class="${state.diffTab === id ? 'on' : ''}">${label}</button>`
  )).join('');
  document.querySelectorAll('[data-side]').forEach((button) => {
    button.classList.toggle('on', button.dataset.side === state.diffSide);
  });
  const snapshot = view[state.diffSide] || view.after;
  let html;
  if (state.diffTab === 'worktree') html = renderPatch(snapshot.patches?.worktreeVsIndex);
  else if (state.diffTab === 'index') html = renderPatch(snapshot.patches?.indexVsHead);
  else if (state.diffTab === 'commit') html = renderCommitDiff(view);
  else html = renderObjectDelta(view);
  $('diff-body').innerHTML = html;
}

function renderConsole(view) {
  const parts = [];
  if (view.argv) parts.push(`$ git ${view.argv.map(quoteArg).join(' ')}`);
  if (view.stdout) parts.push(view.stdout.trimEnd());
  if (view.stderr) parts.push(view.stderr.trimEnd());
  if (!parts.length) parts.push('Git stdout and stderr land here. Commands run as an argument list, not a shell.');
  $('console').textContent = parts.join('\n\n');
  $('console').classList.toggle('fail', view.ok === false);
}

function render() {
  const view = state.view;
  if (!view) return;
  const head = view.after.head;
  $('head-chip').textContent = head?.oid
    ? `HEAD ${head.name || ''} @ ${short(head.oid)}`
    : 'HEAD unborn';
  const command = view.command || 'Sandbox ready';
  const exit = view.command ? ` · exit ${view.exitCode}` : '';
  $('command-line').textContent = `${command}${exit}`;
  $('command-line').classList.toggle('fail-text', view.ok === false);
  $('summary').textContent = view.summary || '';
  renderChips(view);
  const beforeScroll = $('before').scrollTop;
  const afterScroll = $('after').scrollTop;
  $('before').innerHTML = renderPane('before', view);
  $('after').innerHTML = renderPane('after', view);
  $('before').scrollTop = beforeScroll;
  $('after').scrollTop = afterScroll;
  renderDiffs();
  renderConsole(view);
  renderFileList();
  renderEditorState();
}

function currentFileContent() {
  const file = state.view ? fileByPath(state.view.after, state.selected) : null;
  return file?.content ?? '';
}

async function applySuggestion(filePath) {
  const file = state.view ? fileByPath(state.view.after, filePath) : null;
  if (!file || file.content == null) {
    $('summary').textContent = `${filePath} is not a text file in the working tree.`;
    return;
  }
  let next = file.content;
  if (filePath === 'test_main.py') {
    next = next.replace('from hello_oop import Greeter', 'from main import Greeter');
  } else if (filePath === 'main.py') {
    next = next.replace(
      'return f"Hello, {self.name}!"',
      'return f"Hello, {self.name}! Welcome to the moon."',
    );
  }
  if (next === file.content) {
    $('summary').textContent = `${filePath} already has that edit, or it no longer matches the moon sample.`;
    return;
  }
  state.selected = filePath;
  await saveFile(filePath, next);
}

function bind() {
  renderPresets();
  $('command-form').addEventListener('submit', (event) => {
    event.preventDefault();
    runCommand($('command-input').value);
  });
  $('command-input').addEventListener('keydown', (event) => {
    if (event.key === 'ArrowUp') {
      if (!state.history.length) return;
      event.preventDefault();
      if (state.histIndex === state.history.length) state.draft = $('command-input').value;
      state.histIndex = Math.max(0, state.histIndex - 1);
      $('command-input').value = state.history[state.histIndex];
    } else if (event.key === 'ArrowDown') {
      if (state.histIndex >= state.history.length) return;
      event.preventDefault();
      state.histIndex += 1;
      $('command-input').value = state.histIndex >= state.history.length
        ? state.draft
        : state.history[state.histIndex];
    }
  });
  $('reset-btn').addEventListener('click', resetSandbox);
  document.body.addEventListener('click', (event) => {
    const command = event.target.closest('[data-command]');
    if (command) {
      runCommand(command.dataset.command);
      return;
    }
    const suggest = event.target.closest('[data-suggest]');
    if (suggest) {
      applySuggestion(suggest.dataset.suggest);
      return;
    }
    const file = event.target.closest('[data-file]');
    if (file) {
      if (state.dirty) {
        $('summary').textContent = 'Save or discard the open file before switching.';
        return;
      }
      state.selected = file.dataset.file;
      loadEditor(true);
      return;
    }
    const opener = event.target.closest('[data-open]');
    if (opener && state.view) {
      const key = opener.dataset.open;
      const splitAt = key.indexOf(':');
      const side = key.slice(0, splitAt);
      const oid = key.slice(splitAt + 1);
      const currently = isOpen(side, oid, markSet(state.view.changes, side));
      if (currently) {
        state.open.delete(key);
        state.closed.add(key);
      } else {
        state.closed.delete(key);
        state.open.add(key);
      }
      render();
      return;
    }
    const tab = event.target.closest('[data-tab]');
    if (tab) {
      state.diffTab = tab.dataset.tab;
      renderDiffs();
      return;
    }
    const side = event.target.closest('[data-side]');
    if (side) {
      state.diffSide = side.dataset.side;
      renderDiffs();
    }
  });
  $('editor').addEventListener('input', () => {
    state.dirty = $('editor').value !== currentFileContent();
    renderEditorState();
  });
  $('save-btn').addEventListener('click', () => {
    if (!state.selected) return;
    saveFile(state.selected, $('editor').value);
  });
  $('discard-btn').addEventListener('click', () => loadEditor(true));
  $('delete-btn').addEventListener('click', deleteSelected);
  $('new-file-btn').addEventListener('click', () => {
    const filePath = $('new-path').value.trim();
    if (!filePath) return;
    if (state.dirty) {
      $('summary').textContent = 'Save or discard the open file first.';
      return;
    }
    state.selected = filePath;
    $('editor').value = '';
    state.dirty = true;
    renderEditorState();
    $('editor').focus();
  });
}

bind();
boot();
