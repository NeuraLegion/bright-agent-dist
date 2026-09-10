# Bright Agent — Downloads

Official distribution channel for **[Bright Agent](https://www.brightsec.com/)**,
an agentic DAST solution by [Bright Security](https://www.brightsec.com/) that
autonomously analyzes, builds, scans, validates, and fixes security
vulnerabilities in your applications.

This repository hosts the **prebuilt binaries** only. Grab the latest from the
[Releases page](https://github.com/NeuraLegion/bright-agent-dist/releases/latest).

## Download

Pick the binary for your platform:

| Platform        | Asset                          |
| --------------- | ------------------------------ |
| Linux x86-64    | `bright-agent-linux-x64`       |
| Linux ARM64     | `bright-agent-linux-arm64`     |
| macOS Apple Si. | `bright-agent-darwin-arm64`    |
| macOS Intel     | `bright-agent-darwin-x64`      |

Each binary ships with a matching `.sha256` checksum file.

```bash
VERSION=v0.1.0
ASSET=bright-agent-linux-x64
base="https://github.com/NeuraLegion/bright-agent-dist/releases/download/${VERSION}"

curl -fsSL -o "$ASSET"        "$base/$ASSET"
curl -fsSL -o "$ASSET.sha256" "$base/$ASSET.sha256"
sha256sum -c "$ASSET.sha256"   # verify integrity
chmod +x "$ASSET"
```

> macOS binaries are not yet code-signed; you may need to clear the Gatekeeper
> quarantine attribute: `xattr -d com.apple.quarantine ./bright-agent-darwin-arm64`.

## Prerequisites

Bright Agent drives your local toolchain to build and run the target app, so the
following must be installed and on `PATH`:

- **Docker** and **Docker Compose** — to build and run the target app and its services
- **Git** — to clone the repository and push fixes

These are **not** bundled in the binary.

## Run

```bash
# Run from inside a checkout of the repo you want to scan
# (LOCAL_REPO_PATH defaults to the current directory):
cd /path/to/your/repo-checkout
REPO_ACCESS_TOKEN="your-git-pat" \
BRIGHT_TOKEN="your-bright-api-token" \
INFERENCE_URL="https://api.openai.com/v1" \
INFERENCE_TOKEN="your-inference-token" \
/path/to/bright-agent-linux-x64
```

| Variable            | Required | Description                                                                                  |
| ------------------- | -------- | -------------------------------------------------------------------------------------------- |
| `LOCAL_REPO_PATH`   | No       | Path to the checked-out repo to scan. Defaults to the current directory. Bright Agent runs against this working copy — it does not clone |
| `REPO_ACCESS_TOKEN` | **Yes**  | Token that can push branches and open PRs                                                    |
| `BRIGHT_TOKEN`      | **Yes**  | Bright API token from https://app.brightsec.com                                              |
| `INFERENCE_TOKEN`   | Varies   | API token for your inference endpoint. **Not needed for AWS Bedrock with IAM** — the agent generates a token from ambient AWS credentials when this is unset and the URL points to Bedrock. See [`examples/ci/README.md`](./examples/ci/README.md#aws-bedrock-with-iam-no-static-api-key) |
| `INFERENCE_URL`     | No       | Your inference endpoint. Default: `https://api.openai.com/v1` (OpenAI). Also works with Anthropic (`https://api.anthropic.com`), AWS Bedrock (`https://bedrock-mantle.<region>.api.aws/v1`), Azure OpenAI / Foundry (`https://<resource>.openai.azure.com/openai/v1`), Ollama, or any OpenAI-compatible gateway |
| `REPOSITORY_URL`    | No       | Repo identity for the PR. Derived from the checkout's `origin` remote if omitted             |
| `AI_MODEL`          | No       | Model name or comma-separated escalation chain. Default: `gpt-5.4-mini`                      |
| `RUN_MODE`          | No       | `full` (default): build and start the app and scan, falling back to function-harness mode if startup fails. `dynamic`: full startup only, no harness fallback, fails hard. `function`: skip startup, wrap security-critical functions in a lightweight HTTP harness and scan those. `validation`: validate CodeQL/SARIF findings against live DAST, no fix loop. `fuzzing`: drive the external evolutionary fuzzer against generated per-function harnesses to find crashes, hangs, and memory bugs, with no app startup and no Bright cloud scan. See [Fuzzing mode](#fuzzing-mode) |

> The `FUZZER_*` variables below apply only when `RUN_MODE=fuzzing`.

| Variable            | Required | Description                                                                                  |
| ------------------- | -------- | -------------------------------------------------------------------------------------------- |
| `FUZZER_BIN`        | No       | Explicit path to a `fuzzer` binary. If unset, the agent looks for `fuzzer` on `PATH`, then downloads the static linux-x64 release from `NeuraLegion/fuzzer-dist` (sha256-verified) |
| `FUZZER_VERSION`    | No       | Fuzzer release to download. Defaults to `latest`; set e.g. `0.2.2` to pin                    |
| `FUZZER_EPOCHS`     | No       | Max evolution epochs per fuzzed function. If unset, sized per-function from the LLM complexity rating (about 150 to 800); setting it overrides that |
| `FUZZER_TIMEOUT`    | No       | Per-input timeout in seconds; a hang past this is a finding (default: `5`)                   |
| `FUZZER_MAX_MEMORY` | No       | Per-input peak-memory budget (e.g. `512MB`); exceeding it is a finding. Unset by default     |

Bring your own inference provider — **OpenAI**, **Azure OpenAI / Foundry**,
**Anthropic (Claude)**, **AWS Bedrock**, **Ollama**, or any OpenAI-compatible
gateway. (If you use OpenAI directly you can also set `OPENAI_API_KEY` instead
of `INFERENCE_TOKEN`.)

The agent auto-detects the provider from the URL:
- `api.openai.com` → OpenAI
- `api.anthropic.com` → Anthropic (Claude)
- `bedrock-mantle.<region>.api.aws` → AWS Bedrock (OpenAI-compatible, plus the native Claude Messages API for `anthropic.*` models)
- `*.openai.azure.com` / `*.services.ai.azure.com` → Azure OpenAI / Foundry
- `localhost:11434` → Ollama
- Anything else → OpenAI-compatible

The agent keeps the console quiet by default and writes a full, secret-redacted
diagnostic log to `~/.bright-agent/logs/run-<timestamp>.log`. Set `BRIGHT_DEBUG=1`
to mirror it to the console.

## CI Integration

Ready-to-copy pipeline templates live in [`examples/ci/`](./examples/ci/):

- [GitHub Actions](./examples/ci/github-actions.yml)
- [GitHub Actions — CodeQL SARIF validation](./examples/ci/github-actions-codeql-validation.yml)
- [Azure Pipelines](./examples/ci/azure-pipelines.yml)
- [GitLab CI/CD](./examples/ci/.gitlab-ci.yml)
- [Bitbucket Pipelines](./examples/ci/bitbucket-pipelines.yml)
- [CircleCI](./examples/ci/circleci-config.yml)
- [Jenkins](./examples/ci/Jenkinsfile)

The GitHub Actions, Azure Pipelines, GitLab CI/CD, and Bitbucket Pipelines templates cover
manual/nightly scans, **pull-request/merge-request-scoped** runs (reacting into
the PR/MR with fixes + a status), and **`/bright-agent` comment steering** —
re-run with guidance when a scan can't finish (on Azure via a Build Validation
policy + Service Hook; on GitLab via a note webhook + pipeline trigger; on
Bitbucket via PR comments).
See [`examples/ci/README.md`](./examples/ci/README.md) for required secrets and
runner notes. Run scans on a schedule or on demand — not on every push.

## Fuzzing mode

`RUN_MODE=fuzzing` hunts non-DAST robustness bugs (crashes, hangs, and memory
blow-ups) in code reachable past input validation. It is self-contained: no app
startup, no Bright cloud, no repeater, no auth, and no scan loop. It resolves the
evolutionary fuzzer binary (`FUZZER_BIN`, then `fuzzer` on `PATH`, then downloads
the static linux-x64 release from `NeuraLegion/fuzzer-dist`, sha256-verified),
builds a per-function Docker harness, and security-triages the faults so the PR
carries genuine risks with a reproducing payload. Requires Docker and a Linux x64
host.

```bash
# Run from inside a checkout of the repo you want to scan:
RUN_MODE=fuzzing FUZZER_EPOCHS=500 /path/to/bright-agent-linux-x64
```

## Links

- [Bright Security](https://www.brightsec.com)
- [Bright API Documentation](https://docs.brightsec.com)
