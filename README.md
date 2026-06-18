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
REPOSITORY_URL="https://github.com/owner/target-repo" \
REPO_ACCESS_TOKEN="your-git-pat" \
BRIGHT_TOKEN="your-bright-api-token" \
OPENAI_API_KEY="your-openai-key" \
./bright-agent-linux-x64
```

| Variable            | Required | Description                                              |
| ------------------- | -------- | -------------------------------------------------------- |
| `REPOSITORY_URL`    | **Yes**  | Repository to scan (GitHub or Azure DevOps, https form)  |
| `REPO_ACCESS_TOKEN` | **Yes**  | Token that can clone, push branches, and open PRs        |
| `BRIGHT_TOKEN`      | **Yes**  | Bright API token from https://app.brightsec.com          |
| `OPENAI_API_KEY`    | Varies   | AI provider key (or `INFERENCE_TOKEN`)                   |

The agent keeps the console quiet by default and writes a full, secret-redacted
diagnostic log to `~/.bright-agent/logs/run-<timestamp>.log`. Set `BRIGHT_DEBUG=1`
to mirror it to the console.

## CI Integration

Ready-to-copy pipeline templates live in [`examples/ci/`](./examples/ci/):

- [GitHub Actions](./examples/ci/github-actions.yml)
- [CircleCI](./examples/ci/circleci-config.yml)
- [Jenkins](./examples/ci/Jenkinsfile)

See [`examples/ci/README.md`](./examples/ci/README.md) for required secrets and
runner notes. Run scans on a schedule or on demand — not on every push.

## Links

- [Bright Security](https://www.brightsec.com)
- [Bright API Documentation](https://docs.brightsec.com)
