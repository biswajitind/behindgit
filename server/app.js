import express from 'express';
import path from 'node:path';
import { ALLOWED_COMMANDS, parseGitCommand } from './allowlist.js';
import { executeGit } from './commands.js';
import { describeSample, getConfig, repoRoot } from './config.js';
import { diffSnapshots, summarizeChanges } from './diff.js';
import { AppError } from './errors.js';
import { requestContext } from './git.js';
import { rateLimit, requireSameOriginMutation } from './httpguard.js';
import {
  createSession,
  deleteWorktreeFile,
  enqueue,
  getSession,
  rebuildRepo,
  touchSession,
  writeWorktreeFile,
} from './sandbox.js';
import { captureSnapshot } from './snapshot.js';

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

function preferOids(snapshot) {
  if (!snapshot) return [];
  return [
    ...snapshot.objects.commits.map((obj) => obj.oid),
    ...snapshot.objects.trees.map((obj) => obj.oid),
    ...snapshot.objects.blobs.map((obj) => obj.oid),
    ...(snapshot.objects.tags || []).map((obj) => obj.oid),
  ];
}

function wrap(fn) {
  return (req, res, next) => {
    const deadlineAt = req.behindgitDeadline || (Date.now() + getConfig().requestDeadlineMs);
    return requestContext.run({ deadlineAt }, () => Promise.resolve(fn(req, res, next)).catch(next));
  };
}

async function withTransition(session, label, mutate) {
  return enqueue(session, async () => {
    const before = session.lastSnapshot
      ? structuredClone(session.lastSnapshot)
      : await captureSnapshot(session.repo);
    const executed = await mutate();
    let after = null;
    let warning = null;
    try {
      after = await captureSnapshot(session.repo, { preferOids: preferOids(before) });
      session.lastSnapshot = structuredClone(after);
    } catch (error) {
      session.lastSnapshot = null;
      warning = error instanceof AppError ? error.message : 'Could not read the repository after the command';
    }
    await touchSession(session);
    const changes = after ? diffSnapshots(before, after) : emptyChanges();
    let summary = after
      ? summarizeChanges(changes, after)
      : 'Command ran, but the after snapshot failed';
    const notes = [...(after?.warnings || [])];
    if (warning) notes.push(warning);
    if (notes.length) summary = `${summary} · ${notes.join(' · ')}`;
    return {
      ok: executed.exitCode === 0,
      exitCode: executed.exitCode,
      command: label,
      argv: executed.argv,
      stdout: executed.stdout,
      stderr: executed.stderr,
      before,
      after,
      changes,
      summary,
      warning,
    };
  });
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    req.behindgitDeadline = Date.now() + getConfig().requestDeadlineMs;
    next();
  });
  app.use(requireSameOriginMutation);
  app.use(express.json({ limit: '300kb' }));

  app.get('/favicon.ico', (req, res) => {
    res.status(204).end();
  });

  app.get('/api/health', (req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/config', (req, res) => {
    res.json({ ...describeSample(), allowedCommands: ALLOWED_COMMANDS });
  });

  app.post('/api/sessions', rateLimit('create'), wrap(async (req, res) => {
    const session = await createSession();
    const snapshot = await captureSnapshot(session.repo);
    session.lastSnapshot = structuredClone(snapshot);
    res.status(201).json({
      id: session.id,
      sample: describeSample(),
      snapshot,
    });
  }));

  app.get('/api/sessions/:id', wrap(async (req, res) => {
    const session = getSession(req.params.id);
    const snapshot = await enqueue(session, async () => {
      const captured = await captureSnapshot(session.repo, { preferOids: preferOids(session.lastSnapshot) });
      session.lastSnapshot = structuredClone(captured);
      return captured;
    });
    res.json({ id: session.id, snapshot });
  }));

  app.post('/api/sessions/:id/reset', wrap(async (req, res) => {
    const session = getSession(req.params.id);
    const snapshot = await enqueue(session, async () => {
      await rebuildRepo(session);
      const captured = await captureSnapshot(session.repo);
      session.lastSnapshot = structuredClone(captured);
      return captured;
    });
    res.json({
      id: session.id,
      snapshot,
      summary: 'Sandbox reset to a fresh sample.',
    });
  }));

  app.post('/api/sessions/:id/command', rateLimit('command'), wrap(async (req, res) => {
    const session = getSession(req.params.id);
    const command = req.body?.command;
    const parsed = parseGitCommand(command);
    const label = typeof command === 'string' ? command.trim() : '';
    const outcome = await withTransition(session, label, () => (
      executeGit(session.repo, command, { parsed })
    ));
    res.json(outcome);
  }));

  app.put('/api/sessions/:id/files', rateLimit('command'), wrap(async (req, res) => {
    const session = getSession(req.params.id);
    const filePath = req.body?.path;
    const content = req.body?.content;
    if (typeof content !== 'string') throw new AppError('File content must be a string');
    if (content.length > 200_000) throw new AppError('File is too large');
    const outcome = await withTransition(session, `write ${filePath}`, async () => {
      await writeWorktreeFile(session, filePath, content);
      return { exitCode: 0, argv: null, stdout: '', stderr: '' };
    });
    res.json(outcome);
  }));

  app.post('/api/sessions/:id/files/delete', rateLimit('command'), wrap(async (req, res) => {
    const session = getSession(req.params.id);
    const filePath = req.body?.path;
    const outcome = await withTransition(session, `delete ${filePath}`, async () => {
      await deleteWorktreeFile(session, filePath);
      return { exitCode: 0, argv: null, stdout: '', stderr: '' };
    });
    res.json(outcome);
  }));

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use(express.static(path.join(repoRoot, 'public')));

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = Number(err.status) || 500;
    const exposed = err instanceof AppError ? err.expose !== false : status < 500;
    if (!exposed) console.error(err);
    if (err.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));
    res.status(status).json({ error: exposed ? err.message : 'Internal error' });
  });

  return app;
}
