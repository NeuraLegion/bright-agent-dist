# CI Integration Examples

Drop-in pipeline templates for running **Bright Agent** in your own CI. Each
example checks out your repository, downloads the prebuilt binary from
[Releases](https://github.com/NeuraLegion/bright-agent-dist/releases) (verifying
its checksum), and scans the checked-out tree. The agent opens a pull request
with verified fixes.

| Platform                       | File                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------- |
| GitHub Actions                 | [`github-actions.yml`](./github-actions.yml)                                     |
| GitHub Actions — CodeQL validation | [`github-actions-codeql-validation.yml`](./github-actions-codeql-validation.yml) |
| CircleCI                       | [`circleci-config.yml`](./circleci-config.yml)                                   |
| Jenkins                        | [`Jenkinsfile`](./Jenkinsfile)                                                   |

### Modes

The **GitHub Actions** example is a single workflow that drives the agent on
every entry point — manual (`workflow_dispatch`), nightly (`schedule`),
`pull_request`, and `issue_comment` (`/bright-agent` steering). The other
platforms (CircleCI, Jenkins) run the manual/scheduled scan; comment-based
steering is GitHub-specific. The **CodeQL validation** example instead runs
`RUN_MODE=validation`: it takes a CodeQL SARIF file and confirms which static
findings are actually exploitable against the live app (no fix loop), posting a
CodeQL → DAST summary to a PR.

**On a pull request**, the same full run is narrowed to the PR's diff: it scans
only the endpoints affected by the changed code, **bails immediately on a
docs-only PR**, and reacts into the PR it's testing — committing fixes to the
PR's head branch, posting a sticky summary comment, and setting a `Bright Agent`
commit status (**“Marked Safe by Bright Agent”** when nothing is left open).
Force a full-repo scan with `SCAN_SCOPE=full`.

**Steering (`/bright-agent`).** When a run can't finish (e.g. the app won't boot
without a value it can't guess), it posts a PR comment explaining why and
inviting a reply. A user whose GitHub `author_association` on the repo is
**OWNER, MEMBER, or COLLABORATOR** comments `/bright-agent <guidance>`
(lowercase) — e.g. `/bright-agent set AZURE_CLIENT_REDIRECT_URI=https://…` — and
the workflow re-runs that PR with the guidance routed to the relevant phase.
Notes:

- The workflow must be on your repo's **default branch** — GitHub only triggers
  `issue_comment` from there.
- The marker is **lowercase `/bright-agent`** and may appear at the start of the
  comment or after other text/newlines. (GitHub Actions `if:` expressions can't
  match case-insensitively, so a different casing won't trigger the workflow.)
- Only **OWNER / MEMBER / COLLABORATOR** comments are honored (the steering text
  becomes agent instructions), and **fork PRs are refused** before checkout so
  untrusted code never runs with your secrets.
- It needs `pull-requests: write` and `statuses: write` in addition to
  `contents: write` (all in the example's `permissions:` block).

## How it works

The CI job **checks out your repository** (e.g. `actions/checkout`), downloads
the binary, and runs it against that working copy — Bright Agent operates on the
checked-out tree (it does not clone). It detects the tech stack, builds and
starts the app, scans the live endpoints, commits fixes, and opens a PR.

The repository identity (for the PR) is taken from `REPOSITORY_URL` if set,
otherwise derived from the checkout's `origin` remote — so on most CI you don't
need to set it.

> **Keep the binary out of the checkout.** The agent commits with `git add -A`,
> so download the binary (and any CodeQL SARIF) to a directory **outside** the
> repository — the examples use the runner's temp dir — or it gets committed
> into the fix PR.

## Runner prerequisites

- **Docker** and **Docker Compose** — to build and run the target app and its services
- **Git** — to check out the repo and push the fix branch
- **curl** + **sha256sum** — to fetch and verify the binary

GitHub-hosted `ubuntu-latest` and the CircleCI `ubuntu-2404` machine image
include all of these. Self-hosted runners and Jenkins nodes must provide them.

> **CircleCI:** use the `machine` executor (a full VM). The `docker` executor
> with remote Docker can't reach the app on `localhost`, so scanning fails.

## Required secrets / environment variables

Store these in your CI's secret manager — never commit them.

| Variable            | Purpose                                                        |
| ------------------- | -------------------------------------------------------------- |
| `BRIGHT_TOKEN`      | Bright API token from https://app.brightsec.com                |
| `REPO_ACCESS_TOKEN` | Token that can push branches and open PRs on the repo          |
| `INFERENCE_TOKEN`   | API token for your OpenAI-compatible inference endpoint        |
| `INFERENCE_URL`     | That endpoint's base URL (OpenAI, GitHub Models, Ollama, a Bedrock-compatible gateway, …). Not secret — store as a CI variable |
| `LOCAL_REPO_PATH`   | Path to the checked-out repo to scan. Defaults to the current directory (the examples set it to the workspace) |
| `REPOSITORY_URL`    | Optional — repo identity for the PR. Derived from the checkout's `origin` remote if omitted |

Bring your own inference provider — anything exposing an OpenAI-compatible API.
If you use OpenAI directly, you may set `OPENAI_API_KEY` instead of `INFERENCE_TOKEN`.

> **GitHub Actions:** you can skip the `REPO_ACCESS_TOKEN` PAT and use the
> built-in `GITHUB_TOKEN` — set `REPO_ACCESS_TOKEN: ${{ secrets.GITHUB_TOKEN }}`
> and grant `contents: write` + `pull-requests: write` (see the example).
> Caveat: PRs opened with `GITHUB_TOKEN` won't trigger your other workflows, so
> use a PAT if you need the fix PR to run your CI.

The binary **redacts these from all log output**, including its log file.

## Choosing the binary

Pick the asset matching the runner OS/arch:

- `bright-agent-linux-x64` (most CI runners)
- `bright-agent-linux-arm64`
- `bright-agent-darwin-x64`, `bright-agent-darwin-arm64` (macOS runners)

The examples pull the **latest** release (`releases/latest/download/...`). For
reproducible runs, pin a specific version by swapping `latest/download` for
`download/<tag>` (e.g. `.../releases/download/v0.1.1`) — see the comment in each
example's download step.

## Scheduling

Scans build and run your whole app and can take many minutes. Run them
**on a schedule (nightly) or on demand**, not on every push.
