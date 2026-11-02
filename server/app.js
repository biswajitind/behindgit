import express from 'express';
import path from 'node:path';
import { ALLOWED_COMMANDS } from './allowlist.js';
import { executeGit } from './commands.js';
import { describeSample, repoRoot } from './config.js';
import { diffSnapshots, summarizeChanges } from './diff.js';
import { AppError } from './errors.js';
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

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

async function withTransition(session, label, mutate) {
  return enqueue(session, async () => {
    const before = await captureSnapshot(session.repo);
    const executed = await mutate();
    const after = await captureSnapshot(session.repo);
    await touchSession(session);
    const changes = diffSnapshots(before, after);
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
      summary: summarizeChanges(changes, after),
    };
  });
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
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

  app.post('/api/sessions', wrap(async (req, res) => {
    const session = await createSession();
    const snapshot = await captureSnapshot(session.repo);
    res.status(201).json({
      id: session.id,
      sample: describeSample(),
      snapshot,
    });
  }));

  app.get('/api/sessions/:id', wrap(async (req, res) => {
    const session = getSession(req.params.id);
    const snapshot = await enqueue(session, () => captureSnapshot(session.repo));
    res.json({ id: session.id, snapshot });
  }));

  app.post('/api/sessions/:id/reset', wrap(async (req, res) => {
    const session = getSession(req.params.id);
    const snapshot = await enqueue(session, async () => {
      await rebuildRepo(session);
      return captureSnapshot(session.repo);
    });
    res.json({
      id: session.id,
      snapshot,
      summary: 'Sandbox reset to a fresh sample.',
    });
  }));

  app.post('/api/sessions/:id/command', wrap(async (req, res) => {
    const session = getSession(req.params.id);
    const command = req.body?.command;
    const outcome = await withTransition(session, typeof command === 'string' ? command.trim() : '', () => (
      executeGit(session.repo, command)
    ));
    res.json(outcome);
  }));

  app.put('/api/sessions/:id/files', wrap(async (req, res) => {
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

  app.post('/api/sessions/:id/files/delete', wrap(async (req, res) => {
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
    res.status(status).json({ error: exposed ? err.message : 'Internal error' });
  });

  return app;
}
