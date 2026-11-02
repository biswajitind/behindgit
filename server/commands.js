import { AppError } from './errors.js';
import { parseGitCommand } from './allowlist.js';
import { gitText } from './git.js';
import { getConfig } from './config.js';

async function validateChecks(repo, checks) {
  for (const check of checks) {
    if (check.op === 'rev') {
      const result = await gitText(
        repo,
        ['rev-parse', '--verify', '--end-of-options', `${check.value}^{commit}`],
        { allowNonZero: true },
      );
      if (result.exitCode !== 0) {
        throw new AppError(`Revision does not resolve to a commit: ${check.value}`);
      }
    } else if (check.op === 'branch-format') {
      const result = await gitText(repo, ['check-ref-format', '--branch', check.name], { allowNonZero: true });
      if (result.exitCode !== 0) {
        throw new AppError(result.stderr.trim() || `Invalid branch name: ${check.name}`);
      }
    } else if (check.op === 'branch-exists') {
      const result = await gitText(
        repo,
        ['show-ref', '--verify', '--quiet', `refs/heads/${check.name}`],
        { allowNonZero: true },
      );
      if (result.exitCode !== 0) throw new AppError(`Branch does not exist: ${check.name}`);
    } else {
      throw new AppError(`Unknown check ${check.op}`, 500, false);
    }
  }
}

export async function executeGit(repo, input) {
  const parsed = parseGitCommand(input);
  await validateChecks(repo, parsed.checks);
  const cfg = getConfig();
  const result = await gitText(repo, parsed.argv, {
    allowNonZero: true,
    timeout: cfg.commandTimeoutMs,
    maxOutput: 100_000,
    allowTruncate: true,
  });
  return {
    argv: parsed.argv,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
