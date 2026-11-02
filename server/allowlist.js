import { AppError } from './errors.js';

export const ALLOWED_COMMANDS = Object.freeze([
  'add',
  'branch',
  'checkout',
  'commit',
  'diff',
  'log',
  'merge',
  'reset',
  'rm',
  'status',
  'switch',
  'restore',
  'tag',
]);

const BRANCH_RE = /^(?!.*\.lock$)(?!.*\.\.)(?!.*@\{)(?!.*\/\/)(?!\/)(?!.*\/$)[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const REV_RE = /^(?:HEAD|@|(?:HEAD|@)~\d{1,2}|(?:HEAD|@)\^[12]?|[0-9a-f]{4,40})$/i;

export function assertBranchName(name) {
  if (typeof name !== 'string' || name.length > 100 || !BRANCH_RE.test(name)) {
    throw new AppError(`Branch name not allowed: ${name}`);
  }
  const parts = name.split('/');
  if (parts.some((part) => part === '' || part.startsWith('.') || part.endsWith('.') || part.toLowerCase() === '.git')) {
    throw new AppError(`Branch name not allowed: ${name}`);
  }
  if (name.toLowerCase() === 'head') {
    throw new AppError('Branch name HEAD is reserved');
  }
  return name;
}

export function assertRevision(rev) {
  if (typeof rev !== 'string' || rev.length > 120) {
    throw new AppError(`Revision not allowed: ${rev}`);
  }
  if (REV_RE.test(rev)) {
    const tilde = rev.match(/~(\d+)$/);
    if (tilde && Number(tilde[1]) > 50) throw new AppError('Revision ~n is limited to 50');
    if (tilde && Number(tilde[1]) < 1) throw new AppError(`Revision not allowed: ${rev}`);
    return rev;
  }
  return assertBranchName(rev);
}

export function assertSafePath(inputPath) {
  if (typeof inputPath !== 'string' || inputPath.length === 0 || inputPath.length > 512) {
    throw new AppError('Invalid path');
  }
  if (inputPath.includes('\\') || inputPath.includes('\0')) {
    throw new AppError('Invalid path');
  }
  if (inputPath.startsWith('-')) throw new AppError('Path must not start with -');
  if (inputPath.startsWith(':')) throw new AppError('Pathspec magic is not allowed');
  if (inputPath.includes('*') || inputPath.includes('?') || inputPath.includes('[')) {
    throw new AppError('Path globs are not allowed');
  }
  if (inputPath.startsWith('/') || /^[A-Za-z]:/.test(inputPath)) {
    throw new AppError('Absolute paths are not allowed');
  }
  if (inputPath === '.') return inputPath;
  const parts = inputPath.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
    throw new AppError(`Path not allowed: ${inputPath}`);
  }
  return inputPath;
}

const UNSAFE_UNQUOTED = new Set(['|', '&', ';', '<', '>', '`', '$', '\\', '\n', '\r', '\0']);

function tokenize(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t') {
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      let buf = '';
      let closed = false;
      while (i < input.length) {
        if (quote === '"' && input[i] === '\\') {
          const next = input[i + 1];
          if (next === '"' || next === '\\' || next === 'n') {
            buf += next === 'n' ? '\n' : next;
            i += 2;
            continue;
          }
        }
        if (input[i] === '\0') throw new AppError('Command contains a NUL byte');
        if (input[i] === quote) {
          closed = true;
          i += 1;
          break;
        }
        buf += input[i];
        i += 1;
      }
      if (!closed) throw new AppError('Unclosed quote in command');
      tokens.push(buf);
      continue;
    }
    let buf = '';
    while (i < input.length && input[i] !== ' ' && input[i] !== '\t') {
      if (UNSAFE_UNQUOTED.has(input[i])) {
        throw new AppError('Pipes, redirects, backticks, and other shell syntax are not allowed');
      }
      if (input[i] === '"' || input[i] === "'") {
        if (!buf.includes('=')) throw new AppError('Quotes must wrap a whole argument');
        const quote = input[i];
        i += 1;
        let closed = false;
        while (i < input.length) {
          if (quote === '"' && input[i] === '\\') {
            const next = input[i + 1];
            if (next === '"' || next === '\\' || next === 'n') {
              buf += next === 'n' ? '\n' : next;
              i += 2;
              continue;
            }
          }
          if (input[i] === '\0') throw new AppError('Command contains a NUL byte');
          if (input[i] === quote) {
            closed = true;
            i += 1;
            break;
          }
          buf += input[i];
          i += 1;
        }
        if (!closed) throw new AppError('Unclosed quote in command');
        continue;
      }
      buf += input[i];
      i += 1;
    }
    tokens.push(buf);
  }
  return tokens;
}

function parseFlags(args, { bools, values }) {
  const foundBools = [];
  const foundValues = [];
  const positionals = [];
  const afterDash = [];
  const valueSet = new Set(values);
  const boolSet = new Set(bools);
  let dashed = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') {
      dashed = true;
      continue;
    }
    if (dashed) {
      afterDash.push(arg);
      continue;
    }
    if (arg.startsWith('-') && !arg.startsWith('--') && arg.length > 2 && !arg.includes('=') && !boolSet.has(arg)) {
      const chars = [...arg.slice(1)];
      for (let c = 0; c < chars.length; c += 1) {
        const flag = `-${chars[c]}`;
        const last = c === chars.length - 1;
        if (valueSet.has(flag)) {
          if (!last) throw new AppError(`${flag} must be the last flag in ${arg}`);
          const value = args[i + 1];
          i += 1;
          if (value === undefined || value.startsWith('-')) throw new AppError(`${flag} needs a value`);
          foundValues.push([flag, value]);
          continue;
        }
        if (!boolSet.has(flag)) throw new AppError(`Flag not allowed: ${flag}`);
        foundBools.push(flag);
      }
      continue;
    }
    if (arg === '-') {
      positionals.push(arg);
      continue;
    }
    if (arg.startsWith('-')) {
      let flag = arg;
      let inline = null;
      if (arg.startsWith('--') && arg.includes('=')) {
        const eq = arg.indexOf('=');
        flag = arg.slice(0, eq);
        inline = arg.slice(eq + 1);
      }
      if (valueSet.has(flag)) {
        const value = inline !== null ? inline : args[i + 1];
        if (inline === null) i += 1;
        if (value === undefined) throw new AppError(`${flag} needs a value`);
        foundValues.push([flag, value]);
        continue;
      }
      if (inline !== null || !boolSet.has(flag)) {
        throw new AppError(`Flag not allowed: ${arg}`);
      }
      foundBools.push(flag);
      continue;
    }
    positionals.push(arg);
  }
  return { bools: foundBools, values: foundValues, positionals, afterDash };
}

function parseAdd(args) {
  const { bools, positionals, afterDash } = parseFlags(args, {
    bools: ['-A', '--all', '-u', '--update', '-f', '--force', '-n', '--dry-run', '-v', '--verbose'],
    values: [],
  });
  const paths = [...positionals, ...afterDash].map((p) => assertSafePath(p));
  const updatesTree = bools.some((flag) => ['-A', '--all', '-u', '--update'].includes(flag));
  if (!updatesTree && paths.length === 0) {
    throw new AppError('git add needs a path or -A/--all/-u');
  }
  const argv = ['add', ...bools];
  if (paths.length) argv.push('--', ...paths);
  return { argv, checks: [] };
}

function parseCommit(args) {
  const { bools, values, positionals } = parseFlags(args, {
    bools: ['--allow-empty', '--amend', '-a', '--all', '--dry-run', '-v', '--verbose'],
    values: ['-m', '--message'],
  });
  if (positionals.length) throw new AppError(`Unexpected argument for git commit: ${positionals[0]}`);
  const messages = values.filter(([flag]) => flag === '-m' || flag === '--message');
  if (messages.length !== 1) throw new AppError('git commit requires exactly one -m "message"');
  const message = messages[0][1];
  if (!message.trim()) throw new AppError('Commit message is empty');
  if (message.length > 2000) throw new AppError('Commit message is too long');
  return { argv: ['commit', ...bools, '-m', message], checks: [] };
}

function parseMerge(args) {
  const { bools, values, positionals } = parseFlags(args, {
    bools: ['--no-ff', '--ff', '--ff-only', '--no-commit', '--abort', '--continue', '--quit'],
    values: ['-m', '--message', '-s', '--strategy'],
  });
  const stop = bools.filter((flag) => ['--abort', '--continue', '--quit'].includes(flag));
  if (stop.length > 1) throw new AppError('Use only one of --abort, --continue, or --quit');
  if (stop.length === 1) {
    if (positionals.length || values.length || bools.length > 1) {
      throw new AppError(`${stop[0]} does not take a branch, message, or other flags`);
    }
    return { argv: ['merge', stop[0]], checks: [] };
  }
  const ff = bools.filter((flag) => ['--no-ff', '--ff', '--ff-only'].includes(flag));
  if (ff.length > 1) throw new AppError('Choose only one of --ff, --no-ff, or --ff-only');
  if (positionals.length !== 1) throw new AppError('git merge needs exactly one branch name');
  const branch = assertBranchName(positionals[0]);
  const strategies = values.filter(([flag]) => flag === '-s' || flag === '--strategy');
  if (strategies.length > 1) throw new AppError('Only one merge strategy is allowed');
  if (strategies.length === 1 && !['ort', 'recursive', 'resolve'].includes(strategies[0][1])) {
    throw new AppError('Merge strategy must be ort, recursive, or resolve');
  }
  const messages = values.filter(([flag]) => flag === '-m' || flag === '--message');
  if (messages.length > 1) throw new AppError('Only one merge message is allowed');
  if (messages.length === 1 && (!messages[0][1].trim() || messages[0][1].length > 2000)) {
    throw new AppError('Merge message is empty or too long');
  }
  const argv = ['merge', ...bools];
  if (strategies.length) argv.push('-s', strategies[0][1]);
  if (messages.length) argv.push('-m', messages[0][1]);
  argv.push(branch);
  return {
    argv,
    checks: [
      { op: 'branch-format', name: branch },
      { op: 'branch-exists', name: branch },
    ],
  };
}

function parseReset(args) {
  const { bools, positionals, afterDash } = parseFlags(args, {
    bools: ['--soft', '--mixed', '--hard', '-q', '--quiet'],
    values: [],
  });
  const modes = bools.filter((flag) => ['--soft', '--mixed', '--hard'].includes(flag));
  if (modes.length > 1) throw new AppError('Choose only one of --soft, --mixed, or --hard');
  if (afterDash.length) {
    if (modes.some((flag) => flag === '--soft' || flag === '--hard')) {
      throw new AppError('git reset of paths is mixed mode only');
    }
    if (positionals.length > 1) throw new AppError('git reset takes at most one revision before --');
    const paths = afterDash.map((p) => assertSafePath(p));
    const argv = ['reset', ...(modes.length ? modes : ['--mixed'])];
    const checks = [];
    if (positionals.length === 1) {
      const rev = assertRevision(positionals[0]);
      argv.push(rev);
      checks.push({ op: 'rev', value: rev });
    }
    argv.push('--', ...paths);
    return { argv, checks };
  }
  if (positionals.length > 1) throw new AppError('git reset takes at most one revision');
  if (positionals.length === 1 && modes.length === 0) {
    return { argv: ['reset', positionals[0]], checks: [{ op: 'reset-target', value: positionals[0] }] };
  }
  const argv = ['reset', ...bools];
  const checks = [];
  if (positionals.length === 1) {
    const rev = assertRevision(positionals[0]);
    argv.push(rev);
    checks.push({ op: 'rev', value: rev });
  }
  return { argv, checks };
}

function parseCheckout(args) {
  return parseSwitchLike(args, {
    command: 'checkout',
    createFlags: ['-b', '-B'],
  });
}

function parseSwitch(args) {
  return parseSwitchLike(args, {
    command: 'switch',
    createFlags: ['-c', '-C'],
  });
}

function parseSwitchLike(args, { command, createFlags }) {
  const { bools, values, positionals, afterDash } = parseFlags(args, {
    bools: ['--detach'],
    values: createFlags,
  });
  if (afterDash.length) {
    if (command !== 'checkout') throw new AppError(`git ${command} does not take paths`);
    if (positionals.length || values.length || bools.length) {
      throw new AppError('git checkout -- takes paths only');
    }
    const paths = afterDash.map((p) => assertSafePath(p));
    return { argv: ['checkout', '--', ...paths], checks: [] };
  }
  if (bools.includes('--detach')) {
    if (values.length) throw new AppError(`git ${command} --detach does not create a branch`);
    if (positionals.length !== 1) throw new AppError(`git ${command} --detach needs a revision`);
    const rev = assertRevision(positionals[0]);
    return { argv: [command, '--detach', rev], checks: [{ op: 'rev', value: rev }] };
  }
  if (bools.length) throw new AppError(`Flag not allowed for git ${command}`);
  if (values.length > 1) throw new AppError(`Use only one of ${createFlags.join(' or ')}`);
  if (values.length === 1) {
    const name = assertBranchName(values[0][1]);
    if (positionals.length > 1) {
      throw new AppError(`git ${command} ${values[0][0]} takes an optional start revision only`);
    }
    const argv = [command, values[0][0], name];
    const checks = [{ op: 'branch-format', name }];
    if (positionals.length === 1) {
      const start = assertRevision(positionals[0]);
      argv.push(start);
      checks.push({ op: 'rev', value: start });
    }
    return { argv, checks };
  }
  if (positionals.length === 1 && positionals[0] === '-') {
    return { argv: [command, '-'], checks: [] };
  }
  if (positionals.length !== 1) throw new AppError(`git ${command} needs a branch name`);
  try {
    const name = assertBranchName(positionals[0]);
    return {
      argv: [command, name],
      checks: [{ op: 'checkout-target', command, name }],
    };
  } catch {
    const rev = assertRevision(positionals[0]);
    return { argv: [command, '--detach', rev], checks: [{ op: 'rev', value: rev }] };
  }
}

function parseRestore(args) {
  const { bools, values, positionals, afterDash } = parseFlags(args, {
    bools: ['--staged', '--worktree'],
    values: ['--source'],
  });
  const rawPaths = afterDash.length ? afterDash : positionals;
  if (!rawPaths.length) throw new AppError('git restore needs at least one path');
  const paths = rawPaths.map((p) => assertSafePath(p));
  const sources = values.filter(([flag]) => flag === '--source');
  if (sources.length > 1) throw new AppError('Only one --source is allowed');
  const argv = ['restore', ...bools];
  const checks = [];
  if (sources.length === 1) {
    const rev = assertRevision(sources[0][1]);
    argv.push('--source', rev);
    checks.push({ op: 'rev', value: rev });
  }
  argv.push('--', ...paths);
  return { argv, checks };
}

function parseTag(args) {
  const { bools, values, positionals } = parseFlags(args, {
    bools: ['-a', '--annotate', '-d', '--delete', '-l', '--list'],
    values: ['-m', '--message'],
  });
  const deleting = bools.filter((flag) => flag === '-d' || flag === '--delete');
  if (deleting.length) {
    if (positionals.length !== 1) throw new AppError('git tag -d needs one tag name');
    const name = assertBranchName(positionals[0]);
    return { argv: ['tag', '-d', name], checks: [] };
  }
  if (positionals.length === 0) return { argv: ['tag', ...bools.filter((flag) => flag === '-l' || flag === '--list')], checks: [] };
  if (positionals.length > 2) throw new AppError('git tag takes a name and an optional revision');
  const name = assertBranchName(positionals[0]);
  const messages = values.filter(([flag]) => flag === '-m' || flag === '--message');
  const annotated = bools.some((flag) => flag === '-a' || flag === '--annotate') || messages.length > 0;
  if (messages.length > 1) throw new AppError('Only one tag message is allowed');
  if (annotated && messages.length !== 1) throw new AppError('Annotated tags need -m "message"');
  if (messages.length === 1 && (!messages[0][1].trim() || messages[0][1].length > 2000)) {
    throw new AppError('Tag message is empty or too long');
  }
  const argv = ['tag'];
  if (annotated) argv.push('-a', '-m', messages[0][1]);
  argv.push(name);
  const checks = [];
  if (positionals.length === 2) {
    const rev = assertRevision(positionals[1]);
    argv.push(rev);
    checks.push({ op: 'rev', value: rev });
  }
  return { argv, checks };
}

function parseBranch(args) {
  const { bools, positionals } = parseFlags(args, {
    bools: ['-d', '-D', '-m', '-M', '-v', '-vv', '-a', '--all', '--list'],
    values: [],
  });
  const deleting = bools.filter((flag) => flag === '-d' || flag === '-D');
  const moving = bools.filter((flag) => flag === '-m' || flag === '-M');
  const listing = bools.filter((flag) => ['-v', '-vv', '-a', '--all', '--list'].includes(flag));
  if (deleting.length && moving.length) throw new AppError('git branch cannot delete and rename at once');
  if (deleting.length > 1 || moving.length > 1) throw new AppError('Repeated branch flag');
  if (deleting.length) {
    if (positionals.length !== 1) throw new AppError('git branch -d needs one branch name');
    const name = assertBranchName(positionals[0]);
    return {
      argv: ['branch', deleting[0], name],
      checks: [
        { op: 'branch-format', name },
        { op: 'branch-exists', name },
      ],
    };
  }
  if (moving.length) {
    if (positionals.length < 1 || positionals.length > 2) {
      throw new AppError('git branch -m needs the new name, or the old and new names');
    }
    const names = positionals.map((name) => assertBranchName(name));
    const checks = names.map((name) => ({ op: 'branch-format', name }));
    if (names.length === 2) checks.push({ op: 'branch-exists', name: names[0] });
    return { argv: ['branch', moving[0], ...names], checks };
  }
  if (positionals.length === 0) return { argv: ['branch', ...bools], checks: [] };
  if (listing.length) throw new AppError('Listing flags cannot be combined with a new branch name');
  if (positionals.length > 2) throw new AppError('git branch takes at most a name and a start revision');
  const name = assertBranchName(positionals[0]);
  const argv = ['branch', name];
  const checks = [{ op: 'branch-format', name }];
  if (positionals.length === 2) {
    const start = assertRevision(positionals[1]);
    argv.push(start);
    checks.push({ op: 'rev', value: start });
  }
  return { argv, checks };
}

function parseStatus(args) {
  const { bools, positionals } = parseFlags(args, {
    bools: ['-s', '--short', '-b', '--branch', '--porcelain'],
    values: [],
  });
  if (positionals.length) throw new AppError('git status does not take paths here');
  return { argv: ['status', ...bools], checks: [] };
}

function parseDiff(args) {
  const { bools, positionals, afterDash } = parseFlags(args, {
    bools: ['--cached', '--staged', '--stat', '--name-status', '--name-only', '--no-color'],
    values: [],
  });
  const paths = [...positionals, ...afterDash].map((p) => assertSafePath(p));
  const argv = ['diff', '--no-color', ...bools.filter((flag) => flag !== '--no-color')];
  if (paths.length) argv.push('--', ...paths);
  return { argv, checks: [] };
}

function parseLog(args) {
  const { bools, values, positionals } = parseFlags(args, {
    bools: ['--oneline', '--graph', '--decorate', '--all', '--stat'],
    values: ['-n', '--max-count'],
  });
  if (positionals.length) {
    throw new AppError('git log revisions are limited; use --all or the default history');
  }
  const counts = values.filter(([flag]) => flag === '-n' || flag === '--max-count');
  if (counts.length > 1) throw new AppError('Only one log count is allowed');
  let count = 40;
  if (counts.length === 1) {
    if (!/^\d{1,3}$/.test(counts[0][1])) throw new AppError('Log count must be a number');
    count = Number(counts[0][1]);
    if (count < 1 || count > 100) throw new AppError('Log count must be between 1 and 100');
  }
  return { argv: ['log', '--no-color', ...bools, '-n', String(count)], checks: [] };
}

function parseRm(args) {
  const { bools, positionals, afterDash } = parseFlags(args, {
    bools: ['--cached', '-f', '--force', '-r', '--recursive', '-q', '--quiet', '-n', '--dry-run'],
    values: [],
  });
  const paths = [...positionals, ...afterDash].map((p) => assertSafePath(p));
  if (!paths.length) throw new AppError('git rm needs at least one path');
  if (paths.some((p) => p === '.')) throw new AppError('Refusing to git rm the whole repository');
  return { argv: ['rm', ...bools, '--', ...paths], checks: [] };
}

const PARSERS = {
  add: parseAdd,
  branch: parseBranch,
  checkout: parseCheckout,
  commit: parseCommit,
  diff: parseDiff,
  log: parseLog,
  merge: parseMerge,
  reset: parseReset,
  rm: parseRm,
  restore: parseRestore,
  status: parseStatus,
  switch: parseSwitch,
  tag: parseTag,
};

export function parseGitCommand(input) {
  if (typeof input !== 'string') throw new AppError('Command must be a string');
  const trimmed = input.trim();
  if (!trimmed) throw new AppError('Enter a git command');
  if (trimmed.length > 2000) throw new AppError('Command is too long');
  if (trimmed.includes('\0')) throw new AppError('Command contains a NUL byte');
  const tokens = tokenize(trimmed);
  if (tokens.length === 0 || tokens[0] !== 'git') {
    throw new AppError('Only git commands are allowed');
  }
  if (tokens.length < 2) {
    throw new AppError(`Name a git command. Allowed: ${ALLOWED_COMMANDS.join(', ')}`);
  }
  const sub = tokens[1];
  if (!ALLOWED_COMMANDS.includes(sub)) {
    throw new AppError(`git ${sub} is not allowed. Allowed: ${ALLOWED_COMMANDS.join(', ')}`);
  }
  return PARSERS[sub](tokens.slice(2));
}
