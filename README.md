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

`PORT` defaults to `8080`. `HOST` defaults to `127.0.0.1`, so `npm start` is not reachable from another machine. Set `HOST=0.0.0.0` only when you mean to publish it. The container image sets `HOST=0.0.0.0` itself; publish that port to the host loopback (see Docker below).

## Tests

```bash
npm test
npm run lint
```

The tests cover the command allowlist (including shell-metacharacter rejection and pathspec magic), snapshot parsing, topological commit order, before/after diffs, session limits, and a full moon session: edit, `git add`, `git commit`, branch, `git merge --no-ff`, sandbox reset, and `git reset --soft`, `--mixed`, and `--hard`. ESLint covers `server/`, `public/`, and `tests/`. The test script lists `tests/*.test.js` in process, so it does not depend on a shell glob or on Node’s own glob expansion (Node 20 does not expand a quoted pattern).

## Docker

The production image is `ghcr.io/biswajitind/behindgit`. It is based on `node:22-bookworm-slim`, installs Git (the app runs real `git`), installs production dependencies, then removes the global `npm` CLI because the server never calls it. The process runs as the image’s `node` user.

```bash
docker build -t behindgit .
docker run --rm \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --tmpfs /sandboxes:rw,nosuid,size=256m \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 256 \
  --memory 512m \
  --cpus 1 \
  -p 127.0.0.1:8080:8080 \
  behindgit
```

The image’s `tini` is PID 1 and forwards `SIGTERM` to Node, so the example does not pass `--init` (a second init makes `tini` warn that it is not PID 1). `HOST=0.0.0.0` inside the container is what makes the published port work. The `-p 127.0.0.1:8080:8080` binding is what keeps it off the host’s other interfaces. Sandboxes live in `BEHINDGIT_SANDBOX_ROOT` (`/sandboxes` in the image). The 256 MB tmpfs is sized for the defaults: 20 sessions × (4 MB object store + 5 MB worktree) = 180 MB, plus a 32 MB free-space floor (`BEHINDGIT_SANDBOX_MIN_FREE_BYTES`) so one command that overshoots a per-session check cannot fill the disk. `/tmp` holds Git’s private `HOME`.

The image label `org.opencontainers.image.source` is `https://github.com/biswajitind/behindgit`, which links the GitHub Container Registry package to this repository. The package stays private until an owner changes its visibility.

## Continuous integration

`.github/workflows/ci.yml` runs on pull requests and on pushes to `main` or `master`. The repository’s default branch is `main`; `master` is included so a rename does not silently drop the workflow. Check jobs:

| Job | What fails the build |
| --- | --- |
| npm audit | `npm audit --audit-level=high`. High and critical advisories fail. Moderate and low are reported and do not fail the job. The current moderate findings are in the ESLint toolchain (`minimatch`), not in the production dependency tree. `npm ci --omit=dev` inside the image reports none. |
| ESLint | `npm run lint` |
| Tests | `npm test` on Node 20, 22, and 24, plus one job in `node:20-bullseye` so the suite also runs on Git 2.30. |
| CodeQL | JavaScript analysis. Results upload to the repository’s code scanning alerts. |
| Trivy | The production image, severity `HIGH,CRITICAL`, `ignore-unfixed: true`. A finding fails the job only when it is high or critical and a fixed version exists. OS packages and the app’s `node_modules` are in scope. Unfixed issues are shown and do not fail the job. |

Actions are pinned to full commit SHAs, with the release tag in a trailing comment. Dependabot opens updates for Actions, npm, and Docker.

The publish job runs only after those jobs pass, and only on a push to the default branch (never on a pull request). It builds the image with `load: true` and `push: false`, scans that loaded image, then `docker push`es the same tags. It does not rebuild for provenance or SBOM attestations, because that second build would not be the image Trivy scanned. It logs in to `ghcr.io` with `GITHUB_TOKEN` and pushes `ghcr.io/biswajitind/behindgit:latest` plus the full commit SHA. GitHub creates the package on the first successful push. No separate “create the package” step is required. A superseded pull-request run is cancelled; a push to the default branch is not, so a publish is not dropped halfway through.

### One-time steps for the repository owner

The workflow already requests the permissions each job needs. CodeQL has `security-events: write`. Publish has `packages: write`. Other jobs stay at the workflow’s `contents: read`. Do not switch the repository’s Actions setting to “Read and write permissions” for every workflow; that is broader than these jobs. Fork pull requests do not receive the write tokens, which is expected.

A new GHCR package is **private** by default. After the first push to the default branch, open the package (linked from the repository’s Packages section) and change the visibility only if the image should be public. The source label is what associates the package with this repository.

## Sample repository

Every new sandbox starts as a fresh copy of moon. Pick the source with the first variable that is set:

| Variable | Effect |
| --- | --- |
| `BEHINDGIT_SAMPLE_PATH` | `git clone --no-local --no-hardlinks` of this local Git repository. The header does not link to moon in this mode. |
| `BEHINDGIT_SAMPLE_URL` | `git clone` this `https://` URL. No credentials in the URL. |
| `BEHINDGIT_SAMPLE_BUNDLE` | `git clone` this bundle. Default: `samples/moon.bundle`, an offline snapshot of `https://github.com/biswajitind/moon`. |

`BEHINDGIT_SAMPLE_LABEL` is the name shown in the header (default `moon`).

Other knobs, all read on each request:

| Variable | Default | Effect |
| --- | --- | --- |
| `BEHINDGIT_SANDBOX_ROOT` | `$TMPDIR/behindgit-sandboxes` (`/sandboxes` in the image) | Where session directories are created. |
| `BEHINDGIT_SANDBOX_TTL_MS` | two hours | Delete a session that has been idle this long. |
| `BEHINDGIT_IDLE_EVICT_MS` | 10 minutes | When the session cap is hit, only sessions idle at least this long can be evicted. A busier server returns 503 with `Retry-After` instead of dropping a live session. |
| `BEHINDGIT_MAX_SESSIONS` | 20 | Cap on live sandboxes, including a create that has reserved a slot but not finished cloning. 20 × (4 MB + 5 MB) = 180 MB, which fits the 256 MB `/sandboxes` tmpfs. |
| `BEHINDGIT_MAX_SESSIONS_PER_CLIENT` | 3 | Sandboxes one socket address may hold. Behind NAT that address is shared. A further create replaces one of that address's sandboxes only after it has been idle for `BEHINDGIT_CLIENT_EVICT_MS`; otherwise the create returns 429. |
| `BEHINDGIT_CLIENT_EVICT_MS` | 2 minutes | How long one of your own sandboxes must be idle before a new create may replace it. |
| `BEHINDGIT_SANDBOX_MIN_FREE_BYTES` | 33554432 | Refuse a new sandbox or a writing command when the sandbox filesystem has less than this free. |
| `BEHINDGIT_MAX_CLONE_CONCURRENCY` | 2 | How many sample clones run at once. |
| `BEHINDGIT_CLONE_TIMEOUT_MS` | 60 seconds | Timeout for materializing the sample. |
| `BEHINDGIT_COMMAND_TIMEOUT_MS` | 15 seconds | Timeout for one Git command. |
| `BEHINDGIT_REQUEST_DEADLINE_MS` | 60 seconds | Deadline for the whole HTTP request. Past it, Git calls fail with 408. |
| `BEHINDGIT_QUEUE_LIMIT` | 5 | Queued commands per session. Further commands get 429. |
| `BEHINDGIT_RATE_CREATE_PER_MIN` | 10 | New sandboxes per client address per minute. |
| `BEHINDGIT_RATE_COMMAND_PER_MIN` | 60 | Commands and file writes per client address per minute. |
| `BEHINDGIT_RATE_READ_PER_MIN` | 60 | Snapshot reads per client address per minute. |
| `BEHINDGIT_TRUST_PROXY` | unset | Set to `1` only behind a reverse proxy you trust to set `X-Forwarded-For`. Otherwise the limit uses the socket address, so the process should be reached directly. IPv6 keys are the /64. |
| `BEHINDGIT_SESSION_MAX_FILES` | 200 | Worktree files in one session. |
| `BEHINDGIT_SESSION_MAX_BYTES` | 5000000 | Worktree bytes in one session. `.git` is not included. |
| `BEHINDGIT_SESSION_MAX_GIT_BYTES` | 4000000 | Object-store bytes (`git count-objects` size + size-pack) in one session. A writing command is refused with 413, and the message says to use Reset sandbox. `git status`, `git diff`, and `git log` still run. |
| `BEHINDGIT_MAX_BLOB_BYTES` | 100000 | Blobs larger than this are described (`size`, `truncated`) and not loaded. |
| `BEHINDGIT_MAX_OBJECTS` | 2500 | Object-store cap. Past it, the snapshot keeps reachable objects first and sets `objectsTruncated` so the diff does not pretend the rest were deleted. |
| `BEHINDGIT_MAX_OBJECT_BYTES` | 8000000 | Bytes of object content loaded for one snapshot. Past it, further objects stay metadata and `objectsTruncated` is set. A failed object read does the same, so it is not shown as deletions. |
| `BEHINDGIT_MAX_FILES` | 2000 | Worktree walk cap. The walk stops instead of continuing through the rest of the tree. |

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

You can also type a command. Allowed subcommands: `add`, `rm`, `restore`, `commit`, `merge`, `reset` (`--soft`, `--mixed`, `--hard`, and a mixed-mode path reset), `branch`, `checkout`, `switch`, `tag`, `status`, `diff`, `log`. `git commit` needs a single `-m` message because there is no editor. `git log` is capped at 40 commits unless you pass `-n` (max 100). `git checkout <commit>` detaches HEAD when that name is not a branch. User paths are passed to Git with `GIT_LITERAL_PATHSPECS=1`, and tokens that start with `:` or contain `*`, `?`, or `[` are rejected before Git sees them.

The bottom of the page shows three repository diffs for the selected side (before or after the command): working tree versus index, index versus HEAD, and the commit patch (against each parent for a merge). The fourth tab lists object-store and ref changes. Chips above the columns are the same delta in one line.

## Architecture

```
browser  →  Express (server/app.js)
              ├─ public/           single-page UI
              ├─ httpguard.js      same-origin header check and per-address rate limits
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

Objects are content-addressed, so the diff is “which ids appeared or disappeared”, plus which existing objects lost reachability from HEAD, refs (including a peeled tag), and the index. Reflogs are not a root of that walk: a commit that is only in the reflog is reported unreachable, which is what `git reset` leaves behind until garbage collection. Commit order comes from `git rev-list --topo-order --all`, then unreachable commits by committer date. When either snapshot hit the object cap, ids missing from the truncated list are not reported as removed.

### Sandbox boundaries

- The command string is never evaluated by a shell. Unquoted pipes, redirects, backticks, `$`, and `&&` are rejected. The same characters inside quotes are literal text, not shell syntax. `git commit -m "$(...)"` is a commit message, not a command.
- Mutating HTTP requests must send `X-BehindGit: 1` and `Content-Type: application/json`. If the browser sends `Sec-Fetch-Site`, it has to be `same-origin` or `none`.
- Subcommands and flags are allowlisted. Paths must be relative and stay inside the work tree. A path is not rewritten into a relative one: `/etc/passwd`, `a/../b`, and `.git` are rejected. Branch names and revisions have to match a narrow grammar, and revisions are checked with `git rev-parse --verify` before the mutating command runs.
- Each Git process gets `core.hooksPath=/dev/null`, `core.fsmonitor=false`, `gc.auto=0`, a private `HOME`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_NO_REPLACE_OBJECTS=1`, `GIT_ALLOW_PROTOCOL=file:https`, and `GIT_CEILING_DIRECTORIES` set to the sandbox root. When the command targets a session repo, `GIT_DIR` and `GIT_WORK_TREE` are set to that repo. The child is its own process group so a timeout kills the group. After clone, the sandbox’s `.git/config` is replaced so a sample cannot ship a hook, filter, or remote. User commands also set `GIT_LITERAL_PATHSPECS=1`.
- A sample has to be SHA-1. SHA-256 repositories are rejected. Symlinks in the work tree that resolve outside the repository abort sandbox creation, and so do symlink blobs (`mode 120000`) whose targets are absolute or contain `..`. The file API refuses to follow symlinks.
- Commands time out, and each HTTP request has its own deadline. A full server returns 503 rather than deleting a session that was used recently. Output captured for the page is size-capped, and a blob over the size cap is not passed to `git cat-file`.
- `SIGTERM` and `SIGINT` close the HTTP server. In the image, `tini` is the parent process so that signal reaches Node.

## License

See [LICENSE](LICENSE). Moon’s history in `samples/moon.bundle` is a snapshot of https://github.com/biswajitind/moon for offline sandboxes.
