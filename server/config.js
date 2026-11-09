import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(serverDir, '..');

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export const UPSTREAM_MOON = 'https://github.com/biswajitind/moon';

export function getConfig() {
  return {
    port: intEnv('PORT', 8080),
    // Loopback unless the operator opts in. The container image sets HOST=0.0.0.0.
    host: process.env.HOST || '127.0.0.1',
    repoRoot,
    sampleLabel: process.env.BEHINDGIT_SAMPLE_LABEL || 'moon',
    samplePath: process.env.BEHINDGIT_SAMPLE_PATH || '',
    sampleUrl: process.env.BEHINDGIT_SAMPLE_URL || '',
    sampleBundle: process.env.BEHINDGIT_SAMPLE_BUNDLE || path.join(repoRoot, 'samples', 'moon.bundle'),
    upstream: UPSTREAM_MOON,
    sandboxRoot: process.env.BEHINDGIT_SANDBOX_ROOT || path.join(os.tmpdir(), 'behindgit-sandboxes'),
    sandboxTtlMs: intEnv('BEHINDGIT_SANDBOX_TTL_MS', 2 * 60 * 60 * 1000),
    commandTimeoutMs: intEnv('BEHINDGIT_COMMAND_TIMEOUT_MS', 15_000),
    cloneTimeoutMs: intEnv('BEHINDGIT_CLONE_TIMEOUT_MS', 60_000),
    // 20 sessions × (4 MB .git + 5 MB worktree) = 180 MB, under the 256 MB
    // /sandboxes tmpfs. BEHINDGIT_SANDBOX_MIN_FREE_BYTES keeps a 32 MB floor
    // so one command that overshoots a per-session check cannot fill the disk.
    maxSessions: intEnv('BEHINDGIT_MAX_SESSIONS', 20),
    maxSessionsPerClient: intEnv('BEHINDGIT_MAX_SESSIONS_PER_CLIENT', 3),
    // Own-session replacement waits until the sandbox has been idle this long.
    // A shared NAT address then gets 429 instead of deleting someone else's lesson.
    clientEvictMs: intEnv('BEHINDGIT_CLIENT_EVICT_MS', 2 * 60 * 1000),
    maxBlobBytes: intEnv('BEHINDGIT_MAX_BLOB_BYTES', 100_000),
    maxObjects: intEnv('BEHINDGIT_MAX_OBJECTS', 2500),
    maxFiles: intEnv('BEHINDGIT_MAX_FILES', 2000),
    maxPatchCommits: 40,
    idleEvictMs: intEnv('BEHINDGIT_IDLE_EVICT_MS', 10 * 60 * 1000),
    maxCloneConcurrency: intEnv('BEHINDGIT_MAX_CLONE_CONCURRENCY', 2),
    sessionMaxFiles: intEnv('BEHINDGIT_SESSION_MAX_FILES', 200),
    sessionMaxBytes: intEnv('BEHINDGIT_SESSION_MAX_BYTES', 5_000_000),
    sessionMaxGitBytes: intEnv('BEHINDGIT_SESSION_MAX_GIT_BYTES', 4_000_000),
    sandboxMinFreeBytes: intEnv('BEHINDGIT_SANDBOX_MIN_FREE_BYTES', 32 * 1024 * 1024),
    maxObjectBytes: intEnv('BEHINDGIT_MAX_OBJECT_BYTES', 8_000_000),
    requestDeadlineMs: intEnv('BEHINDGIT_REQUEST_DEADLINE_MS', 60_000),
    rateCreatePerMin: intEnv('BEHINDGIT_RATE_CREATE_PER_MIN', 10),
    rateCommandPerMin: intEnv('BEHINDGIT_RATE_COMMAND_PER_MIN', 60),
    rateReadPerMin: intEnv('BEHINDGIT_RATE_READ_PER_MIN', 60),
    // Off unless a trusted reverse proxy sets X-Forwarded-For. Otherwise the
    // limiter uses the socket address, which is the client when the process
    // is reached directly (the default bind is loopback).
    trustProxy: process.env.BEHINDGIT_TRUST_PROXY === '1',
    queueLimit: intEnv('BEHINDGIT_QUEUE_LIMIT', 5),
    authorName: 'BehindGit Learner',
    authorEmail: 'learner@behindgit.local',
  };
}

// PATH wins, then URL, then the vendored moon bundle. The UI always shows sampleLabel.
export function describeSample(cfg = getConfig()) {
  if (cfg.samplePath) {
    return {
      kind: 'path',
      label: cfg.sampleLabel,
      source: cfg.samplePath,
      upstream: null,
      description: `Each sandbox is a copy of ${cfg.samplePath}.`,
    };
  }
  if (cfg.sampleUrl) {
    return {
      kind: 'url',
      label: cfg.sampleLabel,
      source: cfg.sampleUrl,
      upstream: cfg.sampleUrl,
      description: `Each sandbox is a clone of ${cfg.sampleUrl}.`,
    };
  }
  return {
    kind: 'bundle',
    label: cfg.sampleLabel,
    source: 'samples/moon.bundle',
    upstream: cfg.upstream,
    description: 'Each sandbox is cloned from samples/moon.bundle, an offline snapshot of github.com/biswajitind/moon.',
  };
}
