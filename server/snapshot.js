import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import path from 'node:path';
import { getConfig } from './config.js';
import { markReachable } from './diff.js';
import { gitText, runGit } from './git.js';

const STATUS_LABELS = {
  '??': 'untracked',
  ' M': 'modified',
  'M ': 'staged',
  MM: 'staged+modified',
  'A ': 'added',
  AM: 'added+modified',
  AD: 'added+deleted',
  ' D': 'deleted',
  'D ': 'staged delete',
  MD: 'staged+deleted',
  '!!': 'ignored',
  UU: 'conflict',
  AA: 'conflict',
  DD: 'conflict',
  UA: 'conflict',
  AU: 'conflict',
  UD: 'conflict',
  DU: 'conflict',
};

export function statusLabel(xy) {
  if (!xy || xy === '  ') return 'clean';
  if (STATUS_LABELS[xy]) return STATUS_LABELS[xy];
  if (xy.includes('U')) return 'conflict';
  if (xy[0] === 'R' || xy[1] === 'R') return 'renamed';
  if (xy[0] === 'C' || xy[1] === 'C') return 'copied';
  return xy;
}

export function parsePorcelain(text) {
  const parts = text.split('\0');
  const entries = [];
  for (let i = 0; i < parts.length; i += 1) {
    const record = parts[i];
    if (!record || record.length < 4) continue;
    const xy = record.slice(0, 2);
    const filePath = record.slice(3);
    let originalPath = null;
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') {
      originalPath = parts[i + 1] || null;
      i += 1;
    }
    if (!filePath) continue;
    entries.push({ xy, path: filePath, originalPath });
  }
  return entries;
}

export function parseLsFiles(text) {
  const entries = [];
  for (const record of text.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const meta = record.slice(0, tab);
    const filePath = record.slice(tab + 1);
    const [mode, oid, stage] = meta.split(' ');
    if (!mode || !oid || stage === undefined) continue;
    entries.push({ mode, oid, stage: Number(stage), path: filePath });
  }
  return entries;
}

export function parseCommitText(content) {
  const lines = content.split('\n');
  let index = 0;
  const headers = [];
  while (index < lines.length) {
    const line = lines[index];
    if (line === '') {
      index += 1;
      break;
    }
    if ((line.startsWith(' ') || line.startsWith('\t')) && headers.length) {
      const last = headers[headers.length - 1];
      last[1] = `${last[1]}\n${line.slice(1)}`;
      index += 1;
      continue;
    }
    const space = line.indexOf(' ');
    if (space === -1) headers.push([line, '']);
    else headers.push([line.slice(0, space), line.slice(space + 1)]);
    index += 1;
  }
  let message = lines.slice(index).join('\n');
  if (message.endsWith('\n')) message = message.slice(0, -1);
  const ident = (value) => {
    const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(value || '');
    if (!match) return { raw: value || '', name: value || '', email: '', time: 0, tz: '' };
    return { raw: value, name: match[1], email: match[2], time: Number(match[3]), tz: match[4] };
  };
  return {
    tree: headers.find(([key]) => key === 'tree')?.[1] ?? null,
    parents: headers.filter(([key]) => key === 'parent').map(([, value]) => value),
    author: ident(headers.find(([key]) => key === 'author')?.[1]),
    committer: ident(headers.find(([key]) => key === 'committer')?.[1]),
    message,
    signed: headers.some(([key]) => key === 'gpgsig' || key === 'gpgsig-sha256'),
    encoding: headers.find(([key]) => key === 'encoding')?.[1] ?? null,
  };
}

export function parseTreeBuffer(buf) {
  const entries = [];
  let index = 0;
  while (index < buf.length) {
    const space = buf.indexOf(0x20, index);
    if (space === -1) break;
    const mode = buf.toString('ascii', index, space);
    const nul = buf.indexOf(0x00, space);
    if (nul === -1) break;
    const name = buf.toString('utf8', space + 1, nul);
    const oidBuf = buf.subarray(nul + 1, nul + 21);
    if (oidBuf.length < 20) break;
    let type = 'blob';
    if (mode === '40000' || mode === '040000') type = 'tree';
    else if (mode === '120000') type = 'symlink';
    else if (mode === '160000') type = 'commit';
    entries.push({
      mode: mode.padStart(6, '0'),
      type,
      oid: oidBuf.toString('hex'),
      name,
    });
    index = nul + 21;
  }
  return entries;
}

export function parseCatFileBatch(buf) {
  const objects = [];
  let offset = 0;
  while (offset < buf.length) {
    const nl = buf.indexOf(0x0a, offset);
    if (nl === -1) break;
    const header = buf.toString('utf8', offset, nl);
    offset = nl + 1;
    if (!header.trim()) continue;
    if (header.endsWith(' missing')) {
      objects.push({ oid: header.split(' ')[0], missing: true });
      continue;
    }
    const [oid, type, sizeText] = header.split(' ');
    const size = Number(sizeText);
    if (!oid || !type || !Number.isFinite(size)) break;
    const content = buf.subarray(offset, offset + size);
    offset += size;
    if (buf[offset] === 0x0a) offset += 1;
    objects.push({ oid, type, size, content });
  }
  return objects;
}

function decodeBlob(buf, maxBytes) {
  const size = buf.length;
  if (buf.includes(0)) return { size, binary: true, truncated: false, content: null };
  const truncated = size > maxBytes;
  const slice = truncated ? buf.subarray(0, maxBytes) : buf;
  return { size, binary: false, truncated, content: slice.toString('utf8') };
}

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function readHead(repo) {
  const symbolic = await gitText(repo, ['symbolic-ref', '-q', 'HEAD'], { allowNonZero: true });
  const parsed = await gitText(repo, ['rev-parse', '--verify', '-q', 'HEAD'], { allowNonZero: true });
  const detached = symbolic.exitCode !== 0;
  const oid = parsed.exitCode === 0 ? parsed.stdout.trim() : null;
  let name = 'HEAD';
  const short = await gitText(repo, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowNonZero: true });
  if (short.exitCode === 0 && short.stdout.trim()) name = short.stdout.trim();
  return {
    name,
    oid,
    detached,
    symbolic: symbolic.exitCode === 0 ? symbolic.stdout.trim() : null,
    unborn: !oid,
  };
}

async function readRefs(repo) {
  const result = await gitText(
    repo,
    ['for-each-ref', '--format=%(objectname)%00%(objecttype)%00%(refname)%00%(HEAD)%00%(*objectname)%00%(*objecttype)'],
    { allowNonZero: true },
  );
  if (result.exitCode !== 0) return [];
  const refs = [];
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [oid, type, name, headMark, peeled, peeledType] = line.split('\0');
    if (!name?.startsWith('refs/')) continue;
    let kind = 'other';
    if (name.startsWith('refs/heads/')) kind = 'branch';
    else if (name.startsWith('refs/tags/')) kind = 'tag';
    else if (name.startsWith('refs/remotes/')) kind = 'remote';
    const short = name
      .replace(/^refs\/heads\//, '')
      .replace(/^refs\/tags\//, '')
      .replace(/^refs\/remotes\//, '');
    refs.push({
      name,
      short: kind === 'other' ? name.replace(/^refs\//, '') : short,
      oid,
      objectType: type,
      kind,
      current: headMark === '*',
      peeled: peeled || null,
      peeledType: peeledType || null,
    });
  }
  refs.sort((a, b) => a.name.localeCompare(b.name));
  return refs;
}

async function readIndex(repo) {
  const result = await gitText(repo, ['ls-files', '--stage', '-z'], { allowNonZero: true });
  if (result.exitCode !== 0) return [];
  const entries = parseLsFiles(result.stdout);
  const head = await gitText(repo, ['ls-tree', '-r', '-z', 'HEAD'], { allowNonZero: true });
  const headMap = new Map();
  if (head.exitCode === 0) {
    for (const record of head.stdout.split('\0')) {
      if (!record) continue;
      const tab = record.indexOf('\t');
      if (tab === -1) continue;
      const [mode, type, oid] = record.slice(0, tab).split(' ');
      headMap.set(record.slice(tab + 1), { mode, type, oid });
    }
  }
  for (const entry of entries) {
    if (entry.stage !== 0) {
      entry.state = 'unmerged';
      continue;
    }
    const baseline = headMap.get(entry.path);
    if (!baseline) entry.state = 'added';
    else if (baseline.oid !== entry.oid) entry.state = 'modified';
    else entry.state = 'same';
  }
  entries.sort((a, b) => a.path.localeCompare(b.path) || a.stage - b.stage);
  return entries;
}

async function walkWorktree(repo, maxFiles) {
  const files = [];
  let truncated = false;
  async function walk(dir) {
    if (truncated) return;
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      if (truncated || files.length >= maxFiles) {
        truncated = true;
        return;
      }
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await readlink(full);
        files.push({ full, rel: path.relative(repo, full), symlink: true, target });
        continue;
      }
      if (entry.isDirectory()) {
        await walk(full);
        if (truncated) return;
        continue;
      }
      if (!entry.isFile()) continue;
      const st = await lstat(full);
      files.push({
        full,
        rel: path.relative(repo, full),
        symlink: false,
        mode: (st.mode & 0o111) ? '100755' : '100644',
        size: st.size,
      });
    }
  }
  await walk(repo);
  return { files, truncated };
}

async function hashFiles(repo, paths) {
  if (!paths.length) return [];
  const result = await gitText(repo, ['hash-object', '--stdin-paths'], {
    stdin: Buffer.from(`${paths.join('\n')}\n`),
    allowNonZero: true,
  });
  if (result.exitCode !== 0) return paths.map(() => null);
  return result.stdout.trim().split('\n');
}

async function readWorktree(repo, statusEntries) {
  const cfg = getConfig();
  const walked = await walkWorktree(repo, cfg.maxFiles);
  const regular = walked.files.filter((file) => !file.symlink);
  const hashes = await hashFiles(repo, regular.map((file) => file.rel));
  const hashByPath = new Map(regular.map((file, index) => [file.rel, hashes[index] || null]));
  const statusByPath = new Map(statusEntries.map((entry) => [entry.path, entry]));
  const files = [];

  for (const file of walked.files) {
    const status = statusByPath.get(file.rel);
    if (file.symlink) {
      files.push({
        path: file.rel.split(path.sep).join('/'),
        oid: null,
        mode: '120000',
        content: null,
        target: file.target,
        symlink: true,
        missing: false,
        binary: false,
        truncated: false,
        size: 0,
        status: status?.xy || 'symlink',
        statusLabel: 'symlink',
        originalPath: status?.originalPath || null,
      });
      continue;
    }
    let content = null;
    let binary = false;
    let truncated = false;
    if (file.size > cfg.maxBlobBytes) {
      truncated = true;
    } else {
      const buf = await readFile(file.full);
      if (buf.includes(0)) binary = true;
      else content = buf.toString('utf8');
    }
    files.push({
      path: file.rel.split(path.sep).join('/'),
      oid: hashByPath.get(file.rel) || null,
      mode: file.mode,
      content,
      target: null,
      symlink: false,
      missing: false,
      binary,
      truncated,
      size: file.size,
      status: status?.xy || '  ',
      statusLabel: statusLabel(status?.xy),
      originalPath: status?.originalPath || null,
    });
  }

  const seen = new Set(files.map((file) => file.path));
  for (const entry of statusEntries) {
    if (seen.has(entry.path)) continue;
    files.push({
      path: entry.path,
      oid: null,
      mode: null,
      content: null,
      target: null,
      symlink: false,
      missing: true,
      binary: false,
      truncated: false,
      size: 0,
      status: entry.xy,
      statusLabel: statusLabel(entry.xy),
      originalPath: entry.originalPath,
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, truncated: walked.truncated };
}

async function listObjects(repo) {
  const result = await gitText(repo, ['cat-file', '--batch-check', '--batch-all-objects'], {
    maxOutput: 8_000_000,
  });
  const listed = [];
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [oid, type, sizeText] = line.split(' ');
    if (!oid || !type || type === 'missing') continue;
    listed.push({ oid, type, size: Number(sizeText) });
  }
  return listed;
}

async function catBatch(repo, oids) {
  if (!oids.length) return [];
  const result = await runGit(repo, ['cat-file', '--batch'], {
    stdin: Buffer.from(`${oids.join('\n')}\n`),
    maxOutput: 40_000_000,
  });
  return parseCatFileBatch(result.stdout);
}

function stripLeadingOid(text, oid) {
  const lines = text.split('\n');
  if (lines[0] && lines[0].trim() === oid) return lines.slice(1).join('\n').replace(/^\n/, '');
  return text;
}

const patchCache = new Map();

async function attachPatches(repo, commits) {
  await mapPool(commits, 6, async (commit) => {
    if (patchCache.has(commit.oid)) {
      commit.patches = patchCache.get(commit.oid);
      return;
    }
    const patches = [];
    if (!/^[0-9a-f]{40}$/i.test(commit.oid)) {
      commit.patches = patches;
      return;
    }
    if (commit.parents.length === 0) {
      const result = await gitText(repo, ['diff-tree', '--no-color', '-p', '--root', commit.oid], {
        allowNonZero: true,
        maxOutput: 100_000,
        allowTruncate: true,
      });
      patches.push({ parent: null, patch: stripLeadingOid(result.stdout, commit.oid) });
    } else {
      for (const parent of commit.parents) {
        if (!/^[0-9a-f]{40}$/i.test(parent)) continue;
        const result = await gitText(repo, ['diff-tree', '--no-color', '-p', parent, commit.oid], {
          allowNonZero: true,
          maxOutput: 100_000,
          allowTruncate: true,
        });
        patches.push({ parent, patch: result.stdout });
      }
    }
    commit.patches = patches;
    if (patchCache.size > 500) {
      const oldest = patchCache.keys().next().value;
      patchCache.delete(oldest);
    }
    patchCache.set(commit.oid, patches);
  });
}

async function orderFromGit(repo, commits) {
  const result = await gitText(repo, ['rev-list', '--topo-order', '--all'], {
    allowNonZero: true,
    maxOutput: 2_000_000,
    allowTruncate: true,
  });
  const rank = new Map();
  result.stdout.split('\n').filter(Boolean).forEach((oid, index) => rank.set(oid, index));
  const reachable = [];
  const rest = [];
  for (const commit of commits) {
    if (rank.has(commit.oid)) reachable.push(commit);
    else rest.push(commit);
  }
  reachable.sort((a, b) => rank.get(a.oid) - rank.get(b.oid));
  rest.sort((a, b) => (b.committer?.time || 0) - (a.committer?.time || 0));
  return reachable.concat(rest);
}

function parseTagText(content) {
  const lines = content.split('\n');
  let index = 0;
  const headers = [];
  while (index < lines.length) {
    const line = lines[index];
    if (line === '') {
      index += 1;
      break;
    }
    if ((line.startsWith(' ') || line.startsWith('\t')) && headers.length) {
      const last = headers[headers.length - 1];
      last[1] = `${last[1]}\n${line.slice(1)}`;
      index += 1;
      continue;
    }
    const space = line.indexOf(' ');
    if (space === -1) headers.push([line, '']);
    else headers.push([line.slice(0, space), line.slice(space + 1)]);
    index += 1;
  }
  let message = lines.slice(index).join('\n');
  if (message.endsWith('\n')) message = message.slice(0, -1);
  return {
    object: headers.find(([key]) => key === 'object')?.[1] ?? null,
    objectType: headers.find(([key]) => key === 'type')?.[1] ?? null,
    name: headers.find(([key]) => key === 'tag')?.[1] ?? null,
    message: message.slice(0, 4000),
  };
}

export async function captureSnapshot(repo, hints = {}) {
  const cfg = getConfig();
  const warnings = [];
  const [head, refs, index, statusResult] = await Promise.all([
    readHead(repo),
    readRefs(repo),
    readIndex(repo),
    gitText(repo, ['status', '--porcelain=v1', '-uall', '--ignored=matching', '-z'], { allowNonZero: true }),
  ]);
  const statusEntries = statusResult.exitCode === 0 ? parsePorcelain(statusResult.stdout) : [];
  const worktreeResult = await readWorktree(repo, statusEntries);

  let listed = [];
  let listFailed = false;
  try {
    listed = await listObjects(repo);
  } catch (error) {
    listFailed = true;
    warnings.push(error instanceof Error ? error.message : 'Could not list objects');
  }
  let objectsTruncated = listFailed;
  let readFailed = listFailed;
  if (listed.length > cfg.maxObjects) {
    objectsTruncated = true;
    warnings.push(`Object list truncated to ${cfg.maxObjects}`);
    const reachable = await gitText(repo, ['rev-list', '--objects', '--all'], {
      allowNonZero: true,
      maxOutput: 8_000_000,
      allowTruncate: true,
    });
    const keep = new Set(hints.preferOids || []);
    for (const entry of index) keep.add(entry.oid);
    if (head.oid) keep.add(head.oid);
    for (const line of reachable.stdout.split('\n')) {
      const oid = line.split(' ')[0];
      if (oid) keep.add(oid);
    }
    const preferred = listed.filter((obj) => keep.has(obj.oid));
    const rest = listed.filter((obj) => !keep.has(obj.oid));
    listed = [...preferred, ...rest].slice(0, cfg.maxObjects);
  }

  const blobs = [];
  const fetchIds = [];
  const rank = { commit: 0, tag: 1, tree: 2, blob: 3 };
  const ordered = [...listed].sort((a, b) => (rank[a.type] ?? 9) - (rank[b.type] ?? 9));
  let budget = cfg.maxObjectBytes;
  for (const obj of ordered) {
    if (obj.type === 'blob' && obj.size > cfg.maxBlobBytes) {
      blobs.push({
        oid: obj.oid,
        type: 'blob',
        size: obj.size,
        binary: false,
        truncated: true,
        content: null,
      });
      continue;
    }
    if (!Number.isFinite(obj.size) || obj.size > budget) {
      objectsTruncated = true;
      if (obj.type === 'blob') {
        blobs.push({
          oid: obj.oid,
          type: 'blob',
          size: obj.size,
          binary: false,
          truncated: true,
          content: null,
        });
      }
      continue;
    }
    budget -= obj.size;
    if (obj.type === 'blob' || obj.type === 'tree' || obj.type === 'commit' || obj.type === 'tag') {
      fetchIds.push(obj.oid);
    }
  }
  let rawObjects = [];
  try {
    rawObjects = await catBatch(repo, fetchIds);
  } catch (error) {
    objectsTruncated = true;
    readFailed = true;
    warnings.push(error instanceof Error ? error.message : 'Could not read objects');
  }
  const commits = [];
  const trees = [];
  const tags = [];
  for (const obj of rawObjects) {
    if (obj.missing) continue;
    if (obj.type === 'commit') {
      const parsed = parseCommitText(obj.content.toString('utf8'));
      commits.push({
        oid: obj.oid,
        type: 'commit',
        tree: parsed.tree,
        parents: parsed.parents,
        author: parsed.author,
        committer: parsed.committer,
        message: parsed.message.slice(0, 4000),
        signed: parsed.signed,
        encoding: parsed.encoding,
        patches: [],
      });
    } else if (obj.type === 'tree') {
      trees.push({
        oid: obj.oid,
        type: 'tree',
        entries: parseTreeBuffer(obj.content),
      });
    } else if (obj.type === 'blob') {
      const decoded = decodeBlob(obj.content, cfg.maxBlobBytes);
      blobs.push({ oid: obj.oid, type: 'blob', ...decoded });
    } else if (obj.type === 'tag') {
      const parsed = parseTagText(obj.content.toString('utf8'));
      tags.push({ oid: obj.oid, type: 'tag', ...parsed });
    }
  }

  const snapshot = {
    head,
    refs,
    index,
    worktree: worktreeResult.files,
    worktreeTruncated: worktreeResult.truncated,
    objectsTruncated,
    readFailed,
    warnings,
    objects: { commits, trees, blobs, tags },
    patches: { worktreeVsIndex: '', indexVsHead: '' },
  };
  snapshot.objects.commits = await orderFromGit(repo, commits);
  markReachable(snapshot);

  const patchTargets = snapshot.objects.commits.slice(0, cfg.maxPatchCommits);
  const [worktreeVsIndex, indexVsHead] = await Promise.all([
    gitText(repo, ['diff', '--no-color', '--patch'], { allowNonZero: true, maxOutput: 200_000, allowTruncate: true }),
    gitText(repo, ['diff', '--cached', '--no-color', '--patch'], { allowNonZero: true, maxOutput: 200_000, allowTruncate: true }),
    attachPatches(repo, patchTargets),
  ]);
  snapshot.patches = {
    worktreeVsIndex: worktreeVsIndex.stdout,
    indexVsHead: indexVsHead.stdout,
  };
  return snapshot;
}
