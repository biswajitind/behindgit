import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(serverDir, '..');

export const UPSTREAM_MOON = 'https://github.com/biswajitind/moon';

export function getConfig() {
  return {
    port: Number(process.env.PORT) || 8080,
    host: process.env.HOST || '0.0.0.0',
    repoRoot,
    sampleLabel: process.env.BEHINDGIT_SAMPLE_LABEL || 'moon',
    samplePath: process.env.BEHINDGIT_SAMPLE_PATH || '',
    sampleUrl: process.env.BEHINDGIT_SAMPLE_URL || '',
    sampleBundle: process.env.BEHINDGIT_SAMPLE_BUNDLE || path.join(repoRoot, 'samples', 'moon.bundle'),
    upstream: UPSTREAM_MOON,
    sandboxRoot: process.env.BEHINDGIT_SANDBOX_ROOT || path.join(os.tmpdir(), 'behindgit-sandboxes'),
    sandboxTtlMs: Number(process.env.BEHINDGIT_SANDBOX_TTL_MS) || 2 * 60 * 60 * 1000,
    commandTimeoutMs: Number(process.env.BEHINDGIT_COMMAND_TIMEOUT_MS) || 15_000,
    cloneTimeoutMs: Number(process.env.BEHINDGIT_CLONE_TIMEOUT_MS) || 60_000,
    maxSessions: Number(process.env.BEHINDGIT_MAX_SESSIONS) || 30,
    maxBlobBytes: Number(process.env.BEHINDGIT_MAX_BLOB_BYTES) || 100_000,
    maxObjects: Number(process.env.BEHINDGIT_MAX_OBJECTS) || 2500,
    maxFiles: Number(process.env.BEHINDGIT_MAX_FILES) || 2000,
    maxPatchCommits: 40,
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
      upstream: cfg.upstream,
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
