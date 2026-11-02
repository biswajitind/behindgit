import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError } from './errors.js';
import { getConfig } from './config.js';

export const requestContext = new AsyncLocalStorage();

const privateHome = path.join(os.tmpdir(), 'behindgit-git-home');
mkdirSync(privateHome, { recursive: true });

const liveGitPids = new Set();

export function killGitChildren() {
  for (const pid of liveGitPids) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // The process has already exited.
      }
    }
  }
  liveGitPids.clear();
}

export function redact(text) {
  const root = getConfig().sandboxRoot;
  return String(text).split(root).join('[sandbox]');
}

export function gitEnv(extra = {}) {
  const cfg = getConfig();
  return {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: privateHome,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: 'true',
    GIT_SEQUENCE_EDITOR: 'true',
    GIT_PAGER: 'cat',
    GIT_AUTHOR_NAME: cfg.authorName,
    GIT_AUTHOR_EMAIL: cfg.authorEmail,
    GIT_COMMITTER_NAME: cfg.authorName,
    GIT_COMMITTER_EMAIL: cfg.authorEmail,
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_ALLOW_PROTOCOL: 'file:https',
    GIT_CEILING_DIRECTORIES: cfg.sandboxRoot,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    ...extra,
  };
}

function killGroup(child) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // The process has already exited.
    }
  }
}

// shell is intentionally omitted (spawn default is false). Callers pass argv arrays only.
export function runGit(repo, args, options = {}) {
  const cfg = getConfig();
  const {
    stdin = null,
    allowNonZero = false,
    maxOutput = 20_000_000,
    allowTruncate = false,
    env: extraEnv = {},
  } = options;
  let timeout = options.timeout ?? cfg.commandTimeoutMs;

  const deadlineAt = requestContext.getStore()?.deadlineAt;
  if (deadlineAt) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) return Promise.reject(new AppError('Request deadline exceeded', 408));
    timeout = Math.min(timeout, remaining);
  }

  const gitArgs = [
    '--no-pager',
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false',
    '-c', 'core.quotePath=false',
    '-c', 'gc.auto=0',
    '-c', 'maintenance.auto=false',
  ];
  if (repo) gitArgs.push('-C', repo);
  gitArgs.push(...args);

  const env = gitEnv(extraEnv);
  if (repo) {
    env.GIT_DIR = path.join(repo, '.git');
    env.GIT_WORK_TREE = repo;
  }

  return new Promise((resolve, reject) => {
    const child = spawn('git', gitArgs, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    if (child.pid) liveGitPids.add(child.pid);
    const dropChild = () => {
      if (child.pid) liveGitPids.delete(child.pid);
    };
    child.on('close', dropChild);
    child.on('error', dropChild);

    const out = [];
    const err = [];
    let truncatedOut = false;
    let truncatedErr = false;
    let killed = false;
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      killed = true;
      killGroup(child);
    }, timeout);

    const take = (chunk, bucket, lenRef, mark) => {
      const next = lenRef.value + chunk.length;
      if (next <= maxOutput) {
        bucket.push(chunk);
      } else if (!mark.value) {
        mark.value = true;
        const keep = maxOutput - lenRef.value;
        if (keep > 0) bucket.push(chunk.subarray(0, keep));
      }
      lenRef.value = next;
    };

    const outRef = { value: 0 };
    const errRef = { value: 0 };
    const outMark = { value: false };
    const errMark = { value: false };

    child.stdout.on('data', (chunk) => {
      take(chunk, out, outRef, outMark);
      truncatedOut = outMark.value;
    });
    child.stderr.on('data', (chunk) => {
      take(chunk, err, errRef, errMark);
      truncatedErr = errMark.value;
    });

    child.on('error', (error) => {
      finish(reject, new AppError(`Failed to run git: ${error.message}`, 500));
    });

    child.on('close', (code) => {
      if (killed) {
        finish(reject, new AppError('Git command timed out', 408));
        return;
      }
      if ((truncatedOut || truncatedErr) && !allowTruncate) {
        finish(reject, new AppError('Git output exceeded the capture limit', 500));
        return;
      }
      let stdout = Buffer.concat(out);
      let stderr = Buffer.concat(err);
      if (truncatedOut) stdout = Buffer.concat([stdout, Buffer.from('\n… output truncated\n')]);
      if (truncatedErr) stderr = Buffer.concat([stderr, Buffer.from('\n… output truncated\n')]);
      const result = { exitCode: code ?? 1, stdout, stderr };
      if (code !== 0 && !allowNonZero) {
        const message = redact(stderr.toString('utf8').trim() || stdout.toString('utf8').trim() || `git exited ${code}`);
        finish(reject, new AppError(message.slice(0, 2000), 500));
        return;
      }
      finish(resolve, result);
    });

    if (stdin) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

export async function gitText(repo, args, options) {
  const result = await runGit(repo, args, options);
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString('utf8'),
    stderr: result.stderr.toString('utf8'),
  };
}
