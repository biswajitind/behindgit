# BehindGit

BehindGit is an interactive web app that shows what a Git command actually changes. Run a command and the page places the repository **before** and **after** side by side: working-tree files, the index, diffs, and the objects inside `.git` (blobs, trees, commits, refs, and HEAD). New objects are marked added. Objects that a reset left behind are marked unreachable. Git never edits an object in place, so a change in the store is a new id.

The default sandbox is [moon](https://github.com/biswajitind/moon), a three-commit Python greeter used as the companion demo for this project. `test_main.py` imports `hello_oop`, but the class lives in `main.py`. That mismatch is a good first commit.

## Stack

Node.js (Express) serves a single-page UI and runs real Git in a per-session sandbox. One runtime keeps setup to `npm install` and `npm start`, and the tests use the built-in `node:test` runner. The page is static files, so there is no frontend build.

Git is invoked with an argument array. The command string is tokenized in process and checked against an allowlist of subcommands and flags. Nothing is passed through a shell.

## Prerequisites

- Node.js 20 or newer
- Git 2.30 or newer (`git --version`)

## Run

```bash
npm install
npm start
```

Open http://localhost:8080.

`PORT` and `HOST` override the bind address (`8080` and `0.0.0.0` by default).

## Tests

```bash
npm test
npm run lint
```

The tests cover the command allowlist (including shell-metacharacter rejection), snapshot parsing, before/after diffs, and a full moon session: edit, `git add`, `git commit`, branch, `git merge --no-ff`, sandbox reset, and `git reset --soft`, `--mixed`, and `--hard`. ESLint covers `server/`, `public/`, and `tests/`.

## Docker

The production image is `ghcr.io/biswajitind/behindgit`. It is based on `node:22-bookworm-slim`, installs Git (the app runs real `git`), installs production dependencies, then removes the global `npm` CLI because the server never calls it. The process runs as the image’s `node` user.

```bash
docker build -t behindgit .
docker run --rm -p 8080:8080 behindgit
```

The image label `org.opencontainers.image.source` is `https://github.com/biswajitind/behindgit`, which links the GitHub Container Registry package to this repository.

## Continuous integration

`.github/workflows/ci.yml` runs on pull requests and on pushes to `main` or `master`. The repository’s default branch is `main`; `master` is included so a rename does not silently drop the workflow. Check jobs:

| Job | What fails the build |
| --- | --- |
| npm audit | `npm audit --audit-level=high`. High and critical advisories fail. Moderate and low are reported and do not fail the job. The current moderate findings are in the ESLint toolchain (`minimatch`), not in the production dependency tree. `npm ci --omit=dev` inside the image reports none. |
| ESLint | `npm run lint` |
| Tests | `npm test` |
| CodeQL | JavaScript analysis. Results upload to the repository’s code scanning alerts. |
| Trivy | The production image, severity `HIGH,CRITICAL`, `ignore-unfixed: true`. A finding fails the job only when it is high or critical and a fixed version exists. OS packages and the app’s `node_modules` are in scope. Unfixed issues are shown and do not fail the job. |

The publish job runs only after those jobs pass, and only on a push to the default branch (never on a pull request). It logs in to `ghcr.io` with `GITHUB_TOKEN` and pushes `ghcr.io/biswajitind/behindgit:latest` plus a short commit SHA tag. GitHub creates the package on the first successful push. No separate “create the package” step is required.

### One-time steps for the repository owner

1. **Actions workflow permissions.** In the repository, open Settings → Actions → General → Workflow permissions. Choose **Read and write permissions** so a job can request `packages: write` (image push) and `security-events: write` (CodeQL upload). If this stays at “Read repository contents and packages permissions”, the workflow’s write requests are ignored and publish or CodeQL upload will fail. Fork pull requests do not receive these write permissions; that is expected.
2. **Package visibility.** A new GHCR package is **private** by default. After the first push to the default branch, open the package (linked from the repository’s Packages section) and change the visibility if the image should be public. The source label is what associates the package with this repository so it inherits access from the repo.

## Sample repository

Every new sandbox starts as a fresh copy of moon. Pick the source with the first variable that is set:

| Variable | Effect |
| --- | --- |
| `BEHINDGIT_SAMPLE_PATH` | Copy this local Git repository (including `.git`) into the sandbox. |
| `BEHINDGIT_SAMPLE_URL` | `git clone` this `https://` URL. No credentials in the URL. |
| `BEHINDGIT_SAMPLE_BUNDLE` | `git clone` this bundle. Default: `samples/moon.bundle`, an offline snapshot of `https://github.com/biswajitind/moon`. |

`BEHINDGIT_SAMPLE_LABEL` is the name shown in the header (default `moon`).

Other knobs: `BEHINDGIT_SANDBOX_ROOT` (default `$TMPDIR/behindgit-sandboxes`), `BEHINDGIT_SANDBOX_TTL_MS` (default two hours), `BEHINDGIT_COMMAND_TIMEOUT_MS` (default 15 seconds), `BEHINDGIT_MAX_SESSIONS` (default 30).

**Reset sandbox** throws away the session directory and clones the sample again.

## Try this

1. Click **Fix import in test_main.py**. The working tree changes. The object store does not — the new bytes are not a blob yet.
2. `git add test_main.py`. A blob appears and the index points at it.
3. `git commit -m "Fix Greeter import"`. A tree and a commit appear, and `main` / HEAD move.
4. `git switch -c feature-greeting`.
5. Click **Personalize greeting in main.py**, then `git add main.py` and `git commit -m "Personalize the greeting"`.
6. `git switch main`.
7. `git merge feature-greeting --no-ff -m "Merge feature-greeting"`. The new commit has two parents. Its tree already existed, so the store gains a commit and not a tree.
8. Compare `git reset --soft HEAD~1`, `--mixed`, and `--hard`. The undone commit stays in `.git` but becomes unreachable. Soft keeps the index, mixed keeps the working tree, hard moves all three back.

You can also type a command. Allowed subcommands: `add`, `rm`, `commit`, `merge`, `reset` (`--soft`, `--mixed`, `--hard`), `branch`, `checkout`, `switch`, `status`, `diff`, `log`. `git commit` needs a single `-m` message because there is no editor. `git log` is capped at 40 commits unless you pass `-n` (max 100).

The bottom of the page shows three repository diffs for the selected side (before or after the command): working tree versus index, index versus HEAD, and the commit patch (against each parent for a merge). The fourth tab lists object-store and ref changes. Chips above the columns are the same delta in one line.

## Architecture

```
browser  →  Express (server/app.js)
              ├─ public/           single-page UI
              ├─ allowlist.js      tokenize + allowlist, no Git yet
              ├─ commands.js       re-check refs inside the sandbox, then spawn git
              ├─ sandbox.js        one temp directory per session, clone or copy the sample
              ├─ snapshot.js       read the worktree, index, refs, and object database
              └─ diff.js           pure before/after comparison
```

A snapshot is taken with plumbing, not by scraping porcelain alone:

- `git status --porcelain=v1 -z` and a filesystem walk for the working tree (untracked files included)
- `git ls-files --stage` for the index, compared with `git ls-tree -r HEAD`
- `git for-each-ref` and `git symbolic-ref` for refs and HEAD
- `git cat-file --batch-all-objects` plus `git cat-file --batch` for blobs, trees, and commits
- `git diff`, `git diff --cached`, and `git diff-tree` for the three diffs

Objects are content-addressed, so the diff is “which ids appeared or disappeared”, plus which existing objects lost reachability from HEAD, refs, and the index. That last set is what `git reset` leaves behind until garbage collection.

### Sandbox boundaries

- The command string is never evaluated by a shell. Pipes, redirects, backticks, and `&&` are rejected.
- Subcommands and flags are allowlisted. Paths must be relative and stay inside the work tree. Branch names and revisions have to match a narrow grammar, and revisions are checked with `git rev-parse --verify` before the mutating command runs.
- Each Git process gets `core.hooksPath=/dev/null`, a private `HOME`, and `GIT_CONFIG_GLOBAL=/dev/null`. After clone, the sandbox’s `.git/config` is replaced so a sample cannot ship a hook, filter, or remote.
- Symlinks that resolve outside the repository abort sandbox creation. The file API refuses to follow symlinks.
- Commands time out. Idle session directories are deleted. Output captured for the page is size-capped.

## License

See [LICENSE](LICENSE). Moon’s history in `samples/moon.bundle` is a snapshot of https://github.com/biswajitind/moon for offline sandboxes.
