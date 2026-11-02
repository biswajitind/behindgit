import { AppError } from './errors.js';
import { assertSafePath, parseGitCommand } from './allowlist.js';
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

async function applyDynamicChecks(repo, parsed) {
  const checks = [];
  for (const check of parsed.checks) {
    if (check.op === 'checkout-target') {
      const exists = await gitText(
        repo,
        ['show-ref', '--verify', '--quiet', `refs/heads/${check.name}`],
        { allowNonZero: true },
      );
      if (exists.exitCode === 0) {
        checks.push({ op: 'branch-format', name: check.name });
        continue;
      }
      const rev = await gitText(
        repo,
        ['rev-parse', '--verify', '--end-of-options', `${check.name}^{commit}`],
        { allowNonZero: true },
      );
      if (rev.exitCode !== 0) throw new AppError(`Branch does not exist: ${check.name}`);
      parsed.argv = [check.command, '--detach', check.name];
      continue;
    }
    if (check.op === 'reset-target') {
      const token = check.value;
      const looksPath = token.includes('/') || token.includes('.');
      const asRev = looksPath ? { exitCode: 1 } : await gitText(
        repo,
        ['rev-parse', '--verify', '--end-of-options', `${token}^{commit}`],
        { allowNonZero: true },
      );
      if (asRev.exitCode === 0) {
        parsed.argv = ['reset', token];
        checks.push({ op: 'rev', value: token });
      } else {
        const filePath = assertSafePath(token);
        parsed.argv = ['reset', '--', filePath];
      }
      continue;
    }
    checks.push(check);
  }
  await validateChecks(repo, checks);
}

export async function executeGit(repo, input, options = {}) {
  const parsed = options.parsed || parseGitCommand(input);
  await applyDynamicChecks(repo, parsed);
  const cfg = getConfig();
  const result = await gitText(repo, parsed.argv, {
    allowNonZero: true,
    timeout: cfg.commandTimeoutMs,
    maxOutput: 100_000,
    allowTruncate: true,
    env: { GIT_LITERAL_PATHSPECS: '1' },
  });
  return {
    argv: parsed.argv,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
