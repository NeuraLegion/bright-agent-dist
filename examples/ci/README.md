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
| Azure Pipelines                | [`azure-pipelines.yml`](./azure-pipelines.yml)                                   |
| GitLab CI/CD                   | [`.gitlab-ci.yml`](./.gitlab-ci.yml)                                             |
| CircleCI                       | [`circleci-config.yml`](./circleci-config.yml)                                   |
| Jenkins                        | [`Jenkinsfile`](./Jenkinsfile)                                                   |

### Modes

The **GitHub Actions** example is a single workflow that drives the agent on
every entry point — manual (`workflow_dispatch`), nightly (`schedule`),
`pull_request`, and `issue_comment` (`/bright-agent` steering). The **Azure
Pipelines** example reaches the same parity on Azure Repos — scheduled/manual,
PR-scoped runs (via a Build Validation branch policy), and `/bright-agent`
steering (via an Azure DevOps Service Hook, since Azure has no native
PR-comment trigger); the agent's PR reaction (fix commits, sticky comment,
commit status) works on Azure DevOps just like GitHub. The **GitLab CI/CD**
example reaches the same parity on GitLab (gitlab.com or self-managed) —
MR-scoped scans, scheduled/manual, and `/bright-agent` steering (via a comment
webhook → pipeline trigger); on GitLab the agent even adds an award-emoji to the
steering note, since GitLab notes support reactions. The other platforms
(CircleCI, Jenkins) run the manual/scheduled scan; comment-based steering there
would need equivalent webhook plumbing. The **CodeQL validation** example
instead runs `RUN_MODE=validation`: it takes a CodeQL SARIF file and confirms
which static findings are actually exploitable against the live app (no fix
loop), posting a CodeQL → DAST summary to a PR.

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

On **Azure DevOps**, steering works the same way, with two platform differences.
First, there's no native PR-comment trigger — wire an Azure DevOps **Service
Hook** on "Pull request commented on" that runs the pipeline with the
`steering*` parameters (see [`azure-pipelines.yml`](./azure-pipelines.yml)).
Second, Azure has no `author_association`, so the **service hook is the trust
boundary** — only forward `/bright-agent` comments from authorized users and set
the role to `MEMBER`. The agent reacts identically (fix commits, a single
summary comment thread, and a `Bright Agent` commit status). For repo access the
example uses the **built-in `System.AccessToken`** (the Azure equivalent of
GitHub's `GITHUB_TOKEN` — no PAT to create; grant the project's *Build Service*
account Contribute / Contribute to pull requests / status permissions). The
agent auto-detects the token type (OAuth → Bearer, PAT → Basic). To use a PAT
instead, it needs Code (Read & Write), Pull Request Threads (Read & Write), and
Code Status (Read & Write) — and note that, like `GITHUB_TOKEN`, fixes pushed
with `System.AccessToken` won't trigger your other pipelines (use a PAT if you
need that).

On **GitLab**, steering also works the same way (gitlab.com or self-managed). As
on Azure there's no native trigger on a comment, so wire a **webhook** on note
events to a small relay that fires a **pipeline trigger** with the
`BRIGHT_STEERING_*` variables (see [`.gitlab-ci.yml`](./.gitlab-ci.yml)). GitLab
note webhooks don't carry the commenter's role, so the **relay is the trust
boundary** — look up the member's access level and only forward Developer+
comments (set the role to `MEMBER`). Repo access uses a **PAT or Project/Group
Access Token** (`api` scope, Developer+) as `REPO_ACCESS_TOKEN` — `CI_JOB_TOKEN`
can't create merge requests or notes. Uniquely, GitLab notes support reactions,
so the agent adds an award-emoji to the steering note in addition to the sticky
note + commit status.

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

GitHub-hosted `ubuntu-latest`, the Azure Pipelines `ubuntu-latest` image, and
the CircleCI `ubuntu-2404` machine image include all of these. Self-hosted
runners and Jenkins nodes must provide them.

> **CircleCI:** use the `machine` executor (a full VM). The `docker` executor
> with remote Docker can't reach the app on `localhost`, so scanning fails.

> **GitLab:** use a runner that runs Docker on its host (a shell executor on a
> Docker host, or a `docker` executor with docker-in-docker set up so the app is
> reachable). A plain `docker` executor without dind/networking can't reach the
> app on `localhost`.

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
