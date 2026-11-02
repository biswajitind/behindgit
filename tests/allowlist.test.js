import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGitCommand } from '../server/allowlist.js';

function argvOf(command) {
  return parseGitCommand(command).argv;
}

function rejects(command, pattern) {
  assert.throws(() => parseGitCommand(command), pattern);
}

test('accepts the teaching commands with an argument array', () => {
  assert.deepEqual(argvOf('git add test_main.py'), ['add', '--', 'test_main.py']);
  assert.deepEqual(argvOf('git add .'), ['add', '--', '.']);
  assert.deepEqual(argvOf('git add -A'), ['add', '-A']);
  assert.deepEqual(argvOf('git add --all'), ['add', '--all']);
  assert.deepEqual(argvOf('git add -u'), ['add', '-u']);
  assert.deepEqual(argvOf('git add -n main.py README.md'), ['add', '-n', '--', 'main.py', 'README.md']);
  assert.deepEqual(argvOf('git add -- main.py'), ['add', '--', 'main.py']);
  assert.deepEqual(argvOf('git commit -m "Fix Greeter import"'), ['commit', '-m', 'Fix Greeter import']);
  assert.deepEqual(argvOf("git commit -m 'single quotes'"), ['commit', '-m', 'single quotes']);
  assert.deepEqual(argvOf('git commit --allow-empty -m "empty"'), ['commit', '--allow-empty', '-m', 'empty']);
  assert.deepEqual(argvOf('git commit -a -m "all tracked"'), ['commit', '-a', '-m', 'all tracked']);
  assert.deepEqual(argvOf('git commit --amend -m "reword"'), ['commit', '--amend', '-m', 'reword']);
  assert.deepEqual(argvOf('git commit --message="inline"'), ['commit', '-m', 'inline']);
  assert.deepEqual(
    argvOf('git merge feature-greeting --no-ff -m "Merge feature-greeting"'),
    ['merge', '--no-ff', '-m', 'Merge feature-greeting', 'feature-greeting'],
  );
  assert.deepEqual(argvOf('git merge --abort'), ['merge', '--abort']);
  assert.deepEqual(argvOf('git merge feature --ff-only'), ['merge', '--ff-only', 'feature']);
  assert.deepEqual(argvOf('git merge -s ort feature'), ['merge', '-s', 'ort', 'feature']);
  assert.deepEqual(argvOf('git reset --soft HEAD~1'), ['reset', '--soft', 'HEAD~1']);
  assert.deepEqual(argvOf('git reset --mixed HEAD~1'), ['reset', '--mixed', 'HEAD~1']);
  assert.deepEqual(argvOf('git reset --hard HEAD'), ['reset', '--hard', 'HEAD']);
  assert.deepEqual(argvOf('git reset --hard'), ['reset', '--hard']);
  assert.deepEqual(argvOf('git checkout -b feature'), ['checkout', '-b', 'feature']);
  assert.deepEqual(argvOf('git checkout -b feature main'), ['checkout', '-b', 'feature', 'main']);
  assert.deepEqual(argvOf('git checkout main'), ['checkout', 'main']);
  assert.deepEqual(argvOf('git switch -c feature-greeting'), ['switch', '-c', 'feature-greeting']);
  assert.deepEqual(argvOf('git switch main'), ['switch', 'main']);
  assert.deepEqual(argvOf('git switch -'), ['switch', '-']);
  assert.deepEqual(argvOf('git branch'), ['branch']);
  assert.deepEqual(argvOf('git branch feature'), ['branch', 'feature']);
  assert.deepEqual(argvOf('git branch -d feature'), ['branch', '-d', 'feature']);
  assert.deepEqual(argvOf('git status'), ['status']);
  assert.deepEqual(argvOf('git status --short'), ['status', '--short']);
  assert.deepEqual(
    argvOf('git log --oneline --decorate --graph --all'),
    ['log', '--no-color', '--oneline', '--decorate', '--graph', '--all', '-n', '40'],
  );
  assert.deepEqual(argvOf('git diff'), ['diff', '--no-color']);
  assert.deepEqual(argvOf('git diff --cached'), ['diff', '--no-color', '--cached']);
  assert.deepEqual(argvOf('git diff --staged --stat'), ['diff', '--no-color', '--staged', '--stat']);
  assert.deepEqual(argvOf('git rm notes.txt'), ['rm', '--', 'notes.txt']);
  assert.deepEqual(argvOf('git rm --cached notes.txt'), ['rm', '--cached', '--', 'notes.txt']);
});

test('reset and merge record the checks the sandbox must confirm', () => {
  assert.deepEqual(parseGitCommand('git reset --soft HEAD~2').checks, [{ op: 'rev', value: 'HEAD~2' }]);
  assert.deepEqual(parseGitCommand('git merge feature').checks, [
    { op: 'branch-format', name: 'feature' },
    { op: 'branch-exists', name: 'feature' },
  ]);
  assert.deepEqual(parseGitCommand('git switch -c topic main').checks, [
    { op: 'branch-format', name: 'topic' },
    { op: 'rev', value: 'main' },
  ]);
});

test('rejects shell syntax, other commands, and path escapes', () => {
  rejects('', /Enter a git command/);
  rejects('ls', /Only git commands/);
  rejects('git', /Name a git command/);
  rejects('git push origin main', /not allowed/);
  rejects('git clone https://example.com/repo.git', /not allowed/);
  rejects('git config user.name x', /not allowed/);
  rejects('git rebase main', /not allowed/);
  rejects('git -c core.editor=touch commit -m hi', /not allowed/);
  rejects('git commit -m "hi" && git push', /shell syntax/);
  rejects('git add .; touch /tmp/pwned', /shell syntax/);
  rejects('git reset --hard HEAD~1 | cat', /shell syntax/);
  assert.deepEqual(argvOf('git commit -m "$(touch /tmp/pwn)"'), ['commit', '-m', '$(touch /tmp/pwn)']);
  assert.deepEqual(argvOf('git commit -m "Fix A & B"'), ['commit', '-m', 'Fix A & B']);
  assert.deepEqual(argvOf('git commit -am "all tracked"'), ['commit', '-a', '-m', 'all tracked']);
  assert.deepEqual(argvOf('git branch -vv'), ['branch', '-vv']);
  assert.deepEqual(argvOf('git checkout --detach HEAD'), ['checkout', '--detach', 'HEAD']);
  assert.deepEqual(argvOf('git checkout -- main.py'), ['checkout', '--', 'main.py']);
  assert.deepEqual(argvOf('git reset -- notes.txt'), ['reset', '--mixed', '--', 'notes.txt']);
  assert.deepEqual(parseGitCommand('git reset notes.txt').checks, [{ op: 'reset-target', value: 'notes.txt' }]);
  assert.deepEqual(argvOf('git restore --staged notes.txt'), ['restore', '--staged', '--', 'notes.txt']);
  assert.deepEqual(argvOf('git tag -a v1 -m "release"'), ['tag', '-a', '-m', 'release', 'v1']);
  rejects('git commit -m $(touch /tmp/pwn)', /shell syntax/);
  rejects('git add :(top)', /Pathspec magic|not allowed/);
  rejects('git add :/', /Pathspec magic|Absolute paths|not allowed/);
  rejects('git add foo*', /globs|not allowed/);
  rejects('git add :(exclude)foo', /Pathspec magic|not allowed/);
  rejects('git add `whoami`', /shell syntax/);
  rejects('git add ../secret', /not allowed/);
  rejects('git add /etc/passwd', /Absolute paths/);
  rejects('git add foo/../../etc/passwd', /not allowed/);
  rejects('git add --output=/tmp/x', /Flag not allowed/);
  rejects('git add -p', /Flag not allowed/);
  rejects('git commit -F /tmp/msg', /Flag not allowed/);
  rejects('git commit --amend', /exactly one -m/);
  rejects('git commit -m ""', /empty/);
  rejects('git merge --strategy=evil main', /ort, recursive, or resolve/);
  rejects('git merge --no-ff --ff-only main', /only one of --ff/);
  rejects('git reset --soft --hard HEAD', /only one of --soft/);
  rejects('git checkout -b -evil', /Branch name not allowed/);
  rejects('git branch HEAD', /reserved/);
  rejects('git reset --hard --upload-pack=touch', /Revision not allowed|Flag not allowed/);
  rejects('git rm .', /whole repository/);
  rejects('git merge feature extra', /exactly one branch/);
  rejects('git status --upload-pack=x', /Flag not allowed/);
  rejects('git log --exec=x', /Flag not allowed/);
  rejects('git diff -c core.pager=cat', /Flag not allowed/);
  rejects('git reset --hard=x', /Flag not allowed/);
  rejects('git branch a..b', /Branch name not allowed/);
  rejects('git branch x.lock', /Branch name not allowed/);
  rejects('git branch a@{1}', /Branch name not allowed/);
  rejects('git branch café', /Branch name not allowed/);
  rejects(`git status ${'x'.repeat(2000)}`, /too long/);
});
