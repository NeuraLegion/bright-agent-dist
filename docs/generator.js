/*
 * STAR Workflow Builder — pure generation logic.
 *
 * No DOM here: every function takes an explicit `s` (state) object and returns
 * a string (YAML / Groovy / HTML) or plain data. This is what the unit tests
 * exercise. The UMD footer exposes it as `window.StarGen` in the browser and as
 * CommonJS `module.exports` under Node (for `node --test`).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StarGen = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // -------------------------------------------------------------------------
  // Static metadata
  // -------------------------------------------------------------------------
  const PLATFORMS = {
    github:    { name: "GitHub Actions",     file: ".github/workflows/bright-agent.yml", prWord: "Pull request", triggers: ["pr","push","schedule","manual","steering"], builtinToken: true,  nativeSteering: true,  codeql: true },
    gitlab:    { name: "GitLab CI/CD",       file: ".gitlab-ci.yml",                     prWord: "Merge request", triggers: ["pr","schedule","manual","steering"],        builtinToken: false, nativeSteering: false, codeql: false },
    azure:     { name: "Azure Pipelines",    file: "azure-pipelines.yml",                prWord: "Pull request",  triggers: ["pr","schedule","manual","steering"],        builtinToken: true,  nativeSteering: false, codeql: false },
    bitbucket: { name: "Bitbucket Pipelines",file: "bitbucket-pipelines.yml",            prWord: "Pull request",  triggers: ["pr","schedule","manual","steering"],        builtinToken: false, nativeSteering: false, codeql: false },
    circleci:  { name: "CircleCI",           file: ".circleci/config.yml",               prWord: "Pull request",  triggers: ["schedule","manual"],                        builtinToken: false, nativeSteering: false, codeql: false },
    jenkins:   { name: "Jenkins",            file: "Jenkinsfile",                        prWord: "Pull request",  triggers: ["schedule","manual"],                        builtinToken: false, nativeSteering: false, codeql: false },
  };

  const TRIGGER_META = {
    pr:       { t: "Pull / merge request", d: "Diff-scoped scan on each PR; reacts into it (fixes, sticky comment, status)." },
    push:     { t: "Push to default branch", d: "Continuous scan of the commit diff after merge." },
    schedule: { t: "Nightly schedule", d: "Full-repo baseline every night." },
    manual:   { t: "Manual dispatch", d: "Run on demand from the CI UI." },
    steering: { t: "/bright-agent comment steering", d: "Re-run a PR with human guidance from a comment." },
  };

  const RUN_MODES = {
    full:       { t: "Full (recommended)", d: "Build & start the app; auto-fallback to a function harness if startup fails." },
    dynamic:    { t: "Dynamic (strict)", d: "Full startup only — fail the run if the app can't boot. No harness fallback." },
    function:   { t: "Function harness", d: "Skip full startup; wrap security-critical functions in a lightweight HTTP harness." },
    validation: { t: "SAST validation", d: "Confirm/dismiss SARIF findings against the live app. No fix loop." },
  };

  const SCOPES = {
    auto:    { t: "Auto (recommended)", d: "Diff-scoped on PR/MR when a base ref exists, else full." },
    changed: { t: "Force diff", d: "Always scope to the changed files; needs a base ref." },
    full:    { t: "Force full", d: "Scan the whole repository regardless of trigger." },
  };

  const PROVIDERS = {
    openai:      { t: "OpenAI", url: "https://api.openai.com/v1", model: "gpt-5.4-mini" },
    githubmodels:{ t: "GitHub Models", url: "https://models.github.ai/inference", model: "openai/gpt-4.1-mini" },
    anthropic:   { t: "Anthropic", url: "https://api.anthropic.com/v1", model: "claude-sonnet-5,claude-opus-4-8" },
    ollama:      { t: "Ollama (self-hosted)", url: "http://localhost:11434/v1", model: "llama3.1" },
    custom:      { t: "Custom OpenAI-compatible", url: "https://your-gateway.example.com/v1", model: "" },
  };

  const ARCHES = ["bright-agent-linux-x64","bright-agent-linux-arm64","bright-agent-darwin-x64","bright-agent-darwin-arm64"];

  const SETTINGS_LOC = {
    github: 'Settings → Secrets and variables → Actions (Secrets tab for secrets, Variables tab for INFERENCE_URL)',
    gitlab: 'Settings → CI/CD → Variables (tick Mask + Protect on secrets)',
    azure: 'Edit pipeline → Variables (tick "Keep secret" for tokens)',
    bitbucket: 'Repository settings → Pipelines → Repository variables (tick "Secured" for secrets)',
    circleci: 'Project Settings → Environment Variables (or a Context)',
    jenkins: 'Manage Jenkins → Credentials → add each as "Secret text"',
  };

  function defaultState() {
    return {
      platform: "github",
      triggers: { pr: true, push: false, schedule: true, manual: true, steering: true },
      runMode: "full",
      scope: "auto",
      provider: "openai",
      inferenceUrl: PROVIDERS.openai.url,
      useOpenAIKey: false,
      tokenMode: "builtin",
      defaultBranch: "main",
      version: "",
      asset: "bright-agent-linux-x64",
      aiModel: "",
      serviceRoot: "",
      sarifTool: "codeql",
      sarifLanguage: "javascript",
      sarifPath: "",
      debug: false,
      scmOverride: "",
      timeoutMinutes: "60",
    };
  }

  // -------------------------------------------------------------------------
  // Pure helpers
  // -------------------------------------------------------------------------
  const esc = (v) => String(v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  function dlBase(s) {
    return (s.version || "").trim()
      ? `https://github.com/NeuraLegion/bright-agent-dist/releases/download/${s.version.trim()}`
      : `https://github.com/NeuraLegion/bright-agent-dist/releases/latest/download`;
  }

  function activeTriggers(s) {
    return PLATFORMS[s.platform].triggers.filter((t) => s.triggers[t]);
  }
  const usesPR = (s) => activeTriggers(s).includes("pr");
  const usesSteering = (s) => activeTriggers(s).includes("steering");
  const usesOpenAIKey = (s) => s.provider === "openai" && s.useOpenAIKey;
  const inferenceSecretName = (s) => (usesOpenAIKey(s) ? "OPENAI_API_KEY" : "INFERENCE_TOKEN");
  const needsRepoToken = (s) => s.tokenMode === "pat" || !PLATFORMS[s.platform].builtinToken;

  /** Extra scan knobs shared across platforms (same env var names everywhere). */
  function scanKnobs(s) {
    const out = [];
    if (s.scope !== "auto" && s.runMode !== "validation") out.push({ k: "SCAN_SCOPE", v: s.scope });
    if (s.runMode !== "full") out.push({ k: "RUN_MODE", v: s.runMode });
    if (s.runMode === "validation") out.push({ k: "SARIF_PATH", v: s.sarifPath || "REPLACE_WITH_PATH_TO.sarif" });
    if ((s.aiModel || "").trim()) out.push({ k: "AI_MODEL", v: s.aiModel.trim() });
    if ((s.serviceRoot || "").trim()) out.push({ k: "BRIGHT_SERVICE_ROOT", v: s.serviceRoot.trim() });
    if ((s.scmOverride || "").trim()) out.push({ k: "BRIGHT_SCM_PLATFORM", v: s.scmOverride.trim() });
    if (s.debug) out.push({ k: "BRIGHT_DEBUG", v: "1" });
    return out;
  }

  function yamlScalar(v) {
    if (/^[0-9]+$/.test(v) || /[:#{}\[\],&*?|<>=!%@`"']/.test(v)) return `"${String(v).replace(/"/g, '\\"')}"`;
    return v;
  }

  function shellQuote(v) {
    if (/^[A-Za-z0-9_.,\/:-]+$/.test(v)) return v;
    return `'${String(v).replace(/'/g, `'\\''`)}'`;
  }

  function inferenceEnvLines(s, indent, prefix) {
    const lines = [];
    lines.push(`${indent}INFERENCE_URL: ${prefix.url("INFERENCE_URL")}`);
    if (usesOpenAIKey(s)) lines.push(`${indent}OPENAI_API_KEY: ${prefix.secret("OPENAI_API_KEY")}`);
    else lines.push(`${indent}INFERENCE_TOKEN: ${prefix.secret("INFERENCE_TOKEN")}`);
    return lines;
  }

  // -------------------------------------------------------------------------
  // YAML — GitHub Actions
  // -------------------------------------------------------------------------
  function generateGitHub(s) {
    const t = s.triggers;
    const L = [];
    L.push(`# Bright Agent (STAR) — GitHub Actions`);
    L.push(`# Generated by the STAR Workflow Builder. Commit to your repo's DEFAULT branch`);
    L.push(`# (required for /bright-agent comment steering to trigger).`);
    L.push(``);
    L.push(`name: Bright Agent (DAST)`);
    L.push(``);
    L.push(`on:`);
    if (t.pr) { L.push(`  pull_request:`); L.push(`    types: [opened, synchronize, reopened]`); }
    if (t.push) { L.push(`  push:`); L.push(`    branches: ["${s.defaultBranch}"]`); }
    if (t.steering) { L.push(`  issue_comment:`); L.push(`    types: [created]`); }
    if (t.manual) L.push(`  workflow_dispatch: {}`);
    if (t.schedule) { L.push(`  schedule:`); L.push(`    - cron: "0 3 * * *" # nightly 03:00 UTC`); }
    L.push(``);
    L.push(`permissions:`);
    L.push(`  contents: write        # commit fixes to the branch`);
    L.push(`  pull-requests: write   # open/update the PR + summary comment`);
    L.push(`  statuses: write        # set the "Bright Agent" commit status`);
    if (s.runMode === "validation" && s.sarifTool === "codeql") L.push(`  security-events: read`);
    L.push(``);
    L.push(`concurrency:`);
    L.push(`  group: bright-agent-\${{ github.event.pull_request.number || github.event.issue.number || github.ref }}`);
    L.push(`  cancel-in-progress: true`);
    L.push(``);
    L.push(`jobs:`);
    L.push(`  bright-agent:`);

    const gate = [];
    if (t.pr) gate.push(`(github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository)`);
    if (t.push) gate.push(`github.event_name == 'push'`);
    if (t.steering) gate.push(`(github.event_name == 'issue_comment' && github.event.issue.pull_request && contains(github.event.comment.body, '/bright-agent') && contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association))`);
    if (t.manual) gate.push(`github.event_name == 'workflow_dispatch'`);
    if (t.schedule) gate.push(`github.event_name == 'schedule'`);
    if (gate.length) {
      L.push(`    if: >-`);
      gate.forEach((g, i) => L.push(`      ${g}${i < gate.length - 1 ? " ||" : ""}`));
    }
    L.push(`    runs-on: ubuntu-latest`);
    L.push(`    env:`);
    L.push(`      ASSET: ${s.asset}`);
    L.push(`    steps:`);

    if (t.steering) {
      L.push(`      # Resolve the PR for a /bright-agent comment and REFUSE fork PRs before checkout`);
      L.push(`      # (issue_comment runs in the base repo with secrets in scope).`);
      L.push(`      - name: Resolve steering PR (refuse forks)`);
      L.push(`        id: steer`);
      L.push(`        if: github.event_name == 'issue_comment'`);
      L.push(`        uses: actions/github-script@v7`);
      L.push(`        with:`);
      L.push(`          script: |`);
      L.push(`            const { data: pr } = await github.rest.pulls.get({`);
      L.push(`              owner: context.repo.owner, repo: context.repo.repo,`);
      L.push(`              pull_number: context.issue.number,`);
      L.push(`            });`);
      L.push(`            const sameRepo = pr.head.repo && pr.head.repo.full_name === \`\${context.repo.owner}/\${context.repo.repo}\`;`);
      L.push(`            if (!sameRepo) {`);
      L.push(`              core.setFailed("Steering disabled on fork PRs."); return;`);
      L.push(`            }`);
      L.push(`            core.setOutput("head_ref", pr.head.ref);`);
      L.push(`            core.setOutput("base_ref", pr.base.ref);`);
    }

    L.push(`      - uses: actions/checkout@v5`);
    const refParts = [];
    if (t.steering) refParts.push(`(github.event_name == 'issue_comment' && steps.steer.outputs.head_ref)`);
    if (t.pr) refParts.push(`(github.event_name == 'pull_request' && github.event.pull_request.head.ref)`);
    if (refParts.length) {
      L.push(`        with:`);
      L.push(`          ref: >-`);
      refParts.forEach((p, i) => L.push(i === 0 ? `            \${{ ${p}` : `              || ${p}`));
      L.push(`              || github.ref }}`);
      L.push(`          fetch-depth: 0`);
    } else {
      L.push(`        with:`);
      L.push(`          fetch-depth: 0`);
    }

    if (s.runMode === "validation" && s.sarifTool === "codeql") {
      L.push(`      - name: Initialize CodeQL`);
      L.push(`        uses: github/codeql-action/init@v3`);
      L.push(`        with:`);
      L.push(`          languages: ${s.sarifLanguage}`);
      L.push(`      - name: Autobuild`);
      L.push(`        uses: github/codeql-action/autobuild@v3`);
      L.push(`      - name: Analyze (write SARIF to temp)`);
      L.push(`        uses: github/codeql-action/analyze@v3`);
      L.push(`        with:`);
      L.push(`          output: \${{ runner.temp }}/sarif`);
      L.push(`          upload: never`);
    }

    L.push(`      - name: Download & verify Bright Agent`);
    L.push(`        working-directory: \${{ runner.temp }}`);
    L.push(`        run: |`);
    L.push(`          base="${dlBase(s)}"`);
    L.push(`          curl -fsSL -o "\${ASSET}" "\${base}/\${ASSET}"`);
    L.push(`          curl -fsSL -o "\${ASSET}.sha256" "\${base}/\${ASSET}.sha256"`);
    L.push(`          sha256sum -c "\${ASSET}.sha256"`);
    L.push(`          chmod +x "\${ASSET}"`);

    L.push(`      - name: Run Bright Agent`);
    L.push(`        env:`);
    L.push(`          LOCAL_REPO_PATH: \${{ github.workspace }}`);
    const tokenRef = s.tokenMode === "pat" ? `\${{ secrets.REPO_ACCESS_TOKEN }}` : `\${{ secrets.GITHUB_TOKEN }}`;
    L.push(`          REPO_ACCESS_TOKEN: ${tokenRef}`);
    L.push(`          BRIGHT_TOKEN: \${{ secrets.BRIGHT_TOKEN }}`);
    inferenceEnvLines(s, "          ", { url: (n) => `\${{ vars.${n} }}`, secret: (n) => `\${{ secrets.${n} }}` }).forEach((x) => L.push(x));
    scanKnobs(s).forEach(({ k, v }) => {
      if (k === "SARIF_PATH" && s.runMode === "validation" && s.sarifTool === "codeql") {
        L.push(`          SARIF_PATH: \${{ runner.temp }}/sarif/${s.sarifLanguage}.sarif`);
      } else {
        L.push(`          ${k}: ${yamlScalar(v)}`);
      }
    });
    if (t.steering) {
      L.push(`          BRIGHT_STEERING_COMMENT: \${{ github.event_name == 'issue_comment' && github.event.comment.body || '' }}`);
      L.push(`          BRIGHT_STEERING_COMMENT_ID: \${{ github.event_name == 'issue_comment' && github.event.comment.id || '' }}`);
      L.push(`          BRIGHT_STEERING_AUTHOR: \${{ github.event_name == 'issue_comment' && github.event.comment.user.login || '' }}`);
      L.push(`          BRIGHT_STEERING_AUTHOR_ASSOCIATION: \${{ github.event_name == 'issue_comment' && github.event.comment.author_association || '' }}`);
      L.push(`          BRIGHT_STEERING_PR_NUMBER: \${{ github.event_name == 'issue_comment' && github.event.issue.number || '' }}`);
      L.push(`          BRIGHT_STEERING_PR_HEAD: \${{ steps.steer.outputs.head_ref }}`);
      L.push(`          BRIGHT_STEERING_PR_BASE: \${{ steps.steer.outputs.base_ref }}`);
    }
    L.push(`        run: "\${{ runner.temp }}/\${{ env.ASSET }}"`);
    if (s.tokenMode === "builtin") {
      L.push(``);
      L.push(`# NOTE: commits/PRs made with GITHUB_TOKEN don't trigger your other workflows.`);
      L.push(`# Use a PAT as REPO_ACCESS_TOKEN if you need fix commits to re-run CI.`);
    }
    return L.join("\n");
  }

  // -------------------------------------------------------------------------
  // YAML — GitLab CI/CD
  // -------------------------------------------------------------------------
  function generateGitLab(s) {
    const t = s.triggers;
    const L = [];
    L.push(`# Bright Agent (STAR) — GitLab CI/CD  (generated by the STAR Workflow Builder)`);
    L.push(`# CI/CD variables (Settings -> CI/CD -> Variables, mask & protect):`);
    L.push(`#   BRIGHT_TOKEN, REPO_ACCESS_TOKEN (PAT/Project token, api scope, Developer+),`);
    L.push(`#   ${inferenceSecretName(s)}, INFERENCE_URL`);
    L.push(``);
    L.push(`bright-agent:`);
    L.push(`  stage: test`);
    L.push(`  tags: [docker] # a Docker-capable runner that can reach the app on localhost`);
    L.push(`  variables:`);
    L.push(`    ASSET: ${s.asset}`);
    L.push(`    GIT_DEPTH: "0"`);
    L.push(`  rules:`);
    if (t.pr) L.push(`    - if: $CI_PIPELINE_SOURCE == "merge_request_event"`);
    if (t.schedule) L.push(`    - if: $CI_PIPELINE_SOURCE == "schedule"`);
    if (t.manual) L.push(`    - if: $CI_PIPELINE_SOURCE == "web"`);
    if (t.steering) L.push(`    - if: $CI_PIPELINE_SOURCE == "trigger" # /bright-agent via webhook relay`);
    L.push(`  script:`);
    L.push(`    - |`);
    L.push(`      set -eu`);
    L.push(`      base="${dlBase(s)}"`);
    L.push(`      tmp="$(mktemp -d)"`);
    L.push(`      curl -fsSL -o "$tmp/$ASSET" "$base/$ASSET"`);
    L.push(`      curl -fsSL -o "$tmp/$ASSET.sha256" "$base/$ASSET.sha256"`);
    L.push(`      ( cd "$tmp" && sha256sum -c "$ASSET.sha256" )`);
    L.push(`      chmod +x "$tmp/$ASSET"`);
    L.push(`      export LOCAL_REPO_PATH="$CI_PROJECT_DIR"`);
    L.push(`      export REPOSITORY_URL="$CI_PROJECT_URL"`);
    scanKnobs(s).forEach(({ k, v }) => L.push(`      export ${k}=${shellQuote(v)}`));
    L.push(`      export BRIGHT_CI_TIMEOUT_MINUTES=${shellQuote(s.timeoutMinutes)}`);
    L.push(`      "$tmp/$ASSET"`);
    return L.join("\n");
  }

  // -------------------------------------------------------------------------
  // YAML — Azure Pipelines
  // -------------------------------------------------------------------------
  function generateAzure(s) {
    const t = s.triggers;
    const L = [];
    L.push(`# Bright Agent (STAR) — Azure Pipelines  (generated by the STAR Workflow Builder)`);
    L.push(`# PR builds: add this pipeline as a Build Validation branch policy (YAML pr: is`);
    L.push(`# ignored on Azure Repos). Pipeline variables (tick "Keep secret" for tokens):`);
    L.push(`#   BRIGHT_TOKEN, ${inferenceSecretName(s)}, INFERENCE_URL${s.tokenMode === "pat" ? ", REPO_ACCESS_TOKEN" : ""}`);
    L.push(``);
    if (t.steering) {
      L.push(`parameters:`);
      ["steeringComment","steeringCommentId","steeringAuthor","steeringAuthorRole","steeringPrNumber","steeringPrHead","steeringPrBase"].forEach((p) => {
        L.push(`  - name: ${p}`); L.push(`    type: string`); L.push(`    default: ""`);
      });
      L.push(``);
    }
    L.push(`trigger: none`);
    L.push(``);
    if (t.schedule) {
      L.push(`schedules:`);
      L.push(`  - cron: "0 3 * * *"`);
      L.push(`    displayName: Nightly DAST`);
      L.push(`    branches: { include: ["${s.defaultBranch}"] }`);
      L.push(`    always: true`);
      L.push(``);
    }
    L.push(`pool:`);
    L.push(`  vmImage: ubuntu-latest`);
    L.push(``);
    L.push(`variables:`);
    L.push(`  ASSET: ${s.asset}`);
    L.push(``);
    L.push(`steps:`);
    L.push(`  - checkout: self`);
    L.push(`    fetchDepth: 0`);
    L.push(`    persistCredentials: true`);
    L.push(``);
    L.push(`  - script: |`);
    L.push(`      set -eu`);
    L.push(`      base="${dlBase(s)}"`);
    L.push(`      cd "$(Agent.TempDirectory)"`);
    L.push(`      curl -fsSL -o "$ASSET" "$base/$ASSET"`);
    L.push(`      curl -fsSL -o "$ASSET.sha256" "$base/$ASSET.sha256"`);
    L.push(`      sha256sum -c "$ASSET.sha256"`);
    L.push(`      chmod +x "$ASSET"`);
    L.push(`    displayName: Download & verify Bright Agent`);
    L.push(``);
    L.push(`  - script: "$(Agent.TempDirectory)/$ASSET"`);
    L.push(`    displayName: Run Bright Agent`);
    L.push(`    env:`);
    L.push(`      LOCAL_REPO_PATH: $(Build.SourcesDirectory)`);
    L.push(`      REPOSITORY_URL: $(Build.Repository.Uri)`);
    L.push(`      REPO_ACCESS_TOKEN: ${s.tokenMode === "pat" ? "$(REPO_ACCESS_TOKEN)" : "$(System.AccessToken)"}`);
    L.push(`      BRIGHT_TOKEN: $(BRIGHT_TOKEN)`);
    L.push(`      INFERENCE_URL: $(INFERENCE_URL)`);
    L.push(`      ${usesOpenAIKey(s) ? "OPENAI_API_KEY: $(OPENAI_API_KEY)" : "INFERENCE_TOKEN: $(INFERENCE_TOKEN)"}`);
    L.push(`      BRIGHT_CI_TIMEOUT_MINUTES: "${s.timeoutMinutes}"`);
    scanKnobs(s).forEach(({ k, v }) => L.push(`      ${k}: ${yamlScalar(v)}`));
    if (t.steering) {
      L.push(`      BRIGHT_STEERING_COMMENT: \${{ parameters.steeringComment }}`);
      L.push(`      BRIGHT_STEERING_COMMENT_ID: \${{ parameters.steeringCommentId }}`);
      L.push(`      BRIGHT_STEERING_AUTHOR: \${{ parameters.steeringAuthor }}`);
      L.push(`      BRIGHT_STEERING_AUTHOR_ASSOCIATION: \${{ parameters.steeringAuthorRole }}`);
      L.push(`      BRIGHT_STEERING_PR_NUMBER: \${{ parameters.steeringPrNumber }}`);
      L.push(`      BRIGHT_STEERING_PR_HEAD: \${{ parameters.steeringPrHead }}`);
      L.push(`      BRIGHT_STEERING_PR_BASE: \${{ parameters.steeringPrBase }}`);
    }
    return L.join("\n");
  }

  // -------------------------------------------------------------------------
  // YAML — Bitbucket Pipelines
  // -------------------------------------------------------------------------
  function generateBitbucket(s) {
    const t = s.triggers;
    const L = [];
    L.push(`# Bright Agent (STAR) — Bitbucket Pipelines  (generated by the STAR Workflow Builder)`);
    L.push(`# Repository variables (Settings -> Pipelines -> Repository variables; "Secured"):`);
    L.push(`#   BRIGHT_TOKEN, REPO_ACCESS_TOKEN (App Password: repositories:write + pullrequests:write),`);
    L.push(`#   ${inferenceSecretName(s)}, INFERENCE_URL`);
    L.push(``);
    L.push(`image: atlassian/default-image:4`);
    L.push(``);
    L.push(`definitions:`);
    L.push(`  steps:`);
    L.push(`    - step: &bright-agent-step`);
    L.push(`        name: Bright Agent Scan`);
    L.push(`        size: 2x`);
    L.push(`        services: [docker]`);
    L.push(`        script:`);
    L.push(`          - |`);
    L.push(`            set -eu`);
    L.push(`            ASSET="${s.asset}"`);
    L.push(`            base="${dlBase(s)}"`);
    L.push(`            curl -fsSL -o "/tmp/$ASSET" "$base/$ASSET"`);
    L.push(`            curl -fsSL -o "/tmp/$ASSET.sha256" "$base/$ASSET.sha256"`);
    L.push(`            ( cd /tmp && sha256sum -c "$ASSET.sha256" )`);
    L.push(`            chmod +x "/tmp/$ASSET"`);
    L.push(`            export LOCAL_REPO_PATH="$BITBUCKET_CLONE_DIR"`);
    L.push(`            export REPOSITORY_URL="https://bitbucket.org/\${BITBUCKET_WORKSPACE}/\${BITBUCKET_REPO_SLUG}"`);
    scanKnobs(s).forEach(({ k, v }) => L.push(`            export ${k}=${shellQuote(v)}`));
    L.push(`            export BRIGHT_CI_TIMEOUT_MINUTES=${shellQuote(s.timeoutMinutes)}`);
    L.push(`            "/tmp/$ASSET"`);
    L.push(`  services:`);
    L.push(`    docker:`);
    L.push(`      memory: 3072`);
    L.push(``);
    L.push(`pipelines:`);
    if (t.pr) {
      L.push(`  pull-requests:`);
      L.push(`    "**":`);
      L.push(`      - step: *bright-agent-step`);
    }
    if (t.schedule || t.manual || t.steering) {
      L.push(`  custom:`);
      if (t.schedule || t.manual) { L.push(`    bright-agent-scan:`); L.push(`      - step: *bright-agent-step`); }
      if (t.steering) { L.push(`    bright-agent-steering:`); L.push(`      - step: *bright-agent-step`); }
    }
    return L.join("\n");
  }

  // -------------------------------------------------------------------------
  // YAML — CircleCI
  // -------------------------------------------------------------------------
  function generateCircle(s) {
    const t = s.triggers;
    const L = [];
    L.push(`# Bright Agent (STAR) — CircleCI  (generated by the STAR Workflow Builder)`);
    L.push(`# Project env vars / Context: BRIGHT_TOKEN, REPO_ACCESS_TOKEN,`);
    L.push(`#   ${inferenceSecretName(s)}.`);
    L.push(`# Use the machine executor — the docker executor can't reach the app on localhost.`);
    L.push(``);
    L.push(`version: 2.1`);
    L.push(``);
    L.push(`jobs:`);
    L.push(`  bright-agent:`);
    L.push(`    machine:`);
    L.push(`      image: ubuntu-2404:current`);
    L.push(`    environment:`);
    L.push(`      ASSET: ${s.asset}`);
    L.push(`      INFERENCE_URL: ${s.inferenceUrl}`);
    L.push(`      BRIGHT_CI_TIMEOUT_MINUTES: "${s.timeoutMinutes}"`);
    scanKnobs(s).forEach(({ k, v }) => L.push(`      ${k}: ${yamlScalar(v)}`));
    L.push(`    steps:`);
    L.push(`      - checkout`);
    L.push(`      - run:`);
    L.push(`          name: Download & verify Bright Agent`);
    L.push(`          command: |`);
    L.push(`            base="${dlBase(s)}"`);
    L.push(`            curl -fsSL -o "/tmp/\${ASSET}" "\${base}/\${ASSET}"`);
    L.push(`            curl -fsSL -o "/tmp/\${ASSET}.sha256" "\${base}/\${ASSET}.sha256"`);
    L.push(`            ( cd /tmp && sha256sum -c "\${ASSET}.sha256" )`);
    L.push(`            chmod +x "/tmp/\${ASSET}"`);
    L.push(`      - run:`);
    L.push(`          name: Run Bright Agent`);
    L.push(`          command: LOCAL_REPO_PATH="$(pwd)" "/tmp/\${ASSET}"`);
    L.push(``);
    L.push(`workflows:`);
    if (t.schedule) {
      L.push(`  nightly-dast:`);
      L.push(`    triggers:`);
      L.push(`      - schedule:`);
      L.push(`          cron: "0 3 * * *"`);
      L.push(`          filters: { branches: { only: ["${s.defaultBranch}"] } }`);
      L.push(`    jobs:`);
      L.push(`      - bright-agent`);
    } else {
      L.push(`  on-demand:`);
      L.push(`    jobs:`);
      L.push(`      - bright-agent`);
    }
    return L.join("\n");
  }

  // -------------------------------------------------------------------------
  // Groovy — Jenkins
  // -------------------------------------------------------------------------
  function generateJenkins(s) {
    const t = s.triggers;
    const L = [];
    L.push(`// Bright Agent (STAR) — Jenkins declarative pipeline (generated by the STAR Workflow Builder)`);
    L.push(`// Secret text credentials: bright-token, repo-access-token,`);
    L.push(`//   ${usesOpenAIKey(s) ? "openai-api-key" : "inference-token"}.`);
    L.push(``);
    L.push(`pipeline {`);
    L.push(`  agent any`);
    L.push(`  environment {`);
    L.push(`    ASSET             = '${s.asset}'`);
    L.push(`    INFERENCE_URL     = '${s.inferenceUrl}'`);
    L.push(`    BRIGHT_TOKEN      = credentials('bright-token')`);
    L.push(`    REPO_ACCESS_TOKEN = credentials('repo-access-token')`);
    L.push(`    ${usesOpenAIKey(s) ? "OPENAI_API_KEY   = credentials('openai-api-key')" : "INFERENCE_TOKEN   = credentials('inference-token')"}`);
    L.push(`    BRIGHT_CI_TIMEOUT_MINUTES = '${s.timeoutMinutes}'`);
    scanKnobs(s).forEach(({ k, v }) => L.push(`    ${k} = '${v.replace(/'/g, "\\'")}'`));
    L.push(`  }`);
    L.push(`  options { timeout(time: 2, unit: 'HOURS') }`);
    if (t.schedule) { L.push(`  triggers { cron('H 3 * * *') }`); }
    L.push(`  stages {`);
    L.push(`    stage('Checkout') { steps { checkout scm } }`);
    L.push(`    stage('Download & verify Bright Agent') {`);
    L.push(`      steps {`);
    L.push(`        sh '''`);
    L.push(`          set -eu`);
    L.push(`          base="${dlBase(s)}"`);
    L.push(`          curl -fsSL -o "\${WORKSPACE_TMP}/\${ASSET}" "\${base}/\${ASSET}"`);
    L.push(`          curl -fsSL -o "\${WORKSPACE_TMP}/\${ASSET}.sha256" "\${base}/\${ASSET}.sha256"`);
    L.push(`          ( cd "\${WORKSPACE_TMP}" && sha256sum -c "\${ASSET}.sha256" )`);
    L.push(`          chmod +x "\${WORKSPACE_TMP}/\${ASSET}"`);
    L.push(`        '''`);
    L.push(`      }`);
    L.push(`    }`);
    L.push(`    stage('Run Bright Agent') {`);
    L.push(`      steps { sh 'LOCAL_REPO_PATH="\${WORKSPACE}" "\${WORKSPACE_TMP}/\${ASSET}"' }`);
    L.push(`    }`);
    L.push(`  }`);
    L.push(`}`);
    return L.join("\n");
  }

  function generateYaml(s) {
    switch (s.platform) {
      case "github": return generateGitHub(s);
      case "gitlab": return generateGitLab(s);
      case "azure": return generateAzure(s);
      case "bitbucket": return generateBitbucket(s);
      case "circleci": return generateCircle(s);
      case "jenkins": return generateJenkins(s);
    }
    return "";
  }

  function fileName(s) {
    return PLATFORMS[s.platform].file.split("/").pop();
  }
  function codeLang(s) {
    return s.platform === "jenkins" ? "groovy" : "yaml";
  }

  // -------------------------------------------------------------------------
  // Setup instructions (HTML)
  // -------------------------------------------------------------------------
  function secretRows(s) {
    const rows = [
      ["BRIGHT_TOKEN", "Secret", "Bright API token from app.brightsec.com"],
      [inferenceSecretName(s), "Secret", "API key for your inference endpoint"],
      ["INFERENCE_URL", "Variable", `Endpoint base URL (${s.inferenceUrl})${s.provider === "openai" ? " — optional, this is the default" : ""}`],
    ];
    if (needsRepoToken(s)) rows.push(["REPO_ACCESS_TOKEN", "Secret", "Token that can push branches and open PRs/MRs"]);
    return rows;
  }

  function summaryLine(s) {
    const P = PLATFORMS[s.platform];
    const trg = activeTriggers(s).map((t) => (t === "pr" ? P.prWord.toLowerCase() : t)).join(", ");
    const parts = [`On <b>${esc(P.name)}</b>, runs on <b>${esc(trg || "—")}</b>`];
    parts.push(`in <b>${esc(RUN_MODES[s.runMode].t.replace(/ \(.*\)/, "").toLowerCase())}</b> mode`);
    if (s.runMode !== "validation") parts.push(`with <b>${esc(SCOPES[s.scope].t.replace(/ \(.*\)/, "").toLowerCase())}</b> scope`);
    return parts.join(", ") + ".";
  }

  function docSection(title, kids) {
    return `<h3><span class="star">★</span> ${esc(title)}</h3>` + kids;
  }

  function repoAccessDoc(s) {
    if (s.platform === "github") {
      if (s.tokenMode === "builtin") {
        return `<p>Uses the built-in <code>GITHUB_TOKEN</code> — no PAT needed.</p>`
          + `<div class="callout warn"><span class="h">Allow Actions to create pull requests</span>Enable <b>Settings → Actions → General → Workflow permissions → "Allow GitHub Actions to create and approve pull requests"</b>, or the fix PR fails with a 403.</div>`
          + `<p>Caveat: commits made with <code>GITHUB_TOKEN</code> don't trigger your other workflows. Switch to a PAT if you need fix commits to re-run CI.</p>`;
      }
      return `<p>Create a <b>Personal Access Token</b> (classic: <code>repo</code> scope; fine-grained: Contents + Pull requests read/write) and store it as the <code>REPO_ACCESS_TOKEN</code> secret. Fix commits made with a PAT <b>do</b> re-trigger your other workflows.</p>`;
    }
    if (s.platform === "azure") {
      if (s.tokenMode === "builtin") {
        return `<p>Uses the built-in <code>System.AccessToken</code>. Grant the <b>&lt;Project&gt; Build Service</b> account these permissions under <b>Project Settings → Repositories → your repo → Security</b>: Contribute, Contribute to pull requests, and Create/Edit (commit) status.</p>`
          + `<p>Caveat: like GITHUB_TOKEN, its commits don't trigger other pipelines — use a PAT if you need that.</p>`;
      }
      return `<p>Create a PAT with <b>Code (R&W)</b>, <b>Pull Request Threads (R&W)</b>, and <b>Code Status (R&W)</b>, store it as a secret variable <code>REPO_ACCESS_TOKEN</code>. STAR auto-detects OAuth vs PAT tokens.</p>`;
    }
    if (s.platform === "gitlab") return `<p><code>REPO_ACCESS_TOKEN</code> must be a <b>Personal</b> or <b>Project/Group Access Token</b> with <code>api</code> scope and <b>Developer</b> role or higher. <code>CI_JOB_TOKEN</code> can't create MRs or notes, so it isn't sufficient.</p>`;
    if (s.platform === "bitbucket") return `<p><code>REPO_ACCESS_TOKEN</code> should be a Bitbucket <b>App Password</b> (or Repository/Workspace Access Token) with <code>repositories:write</code> and <code>pullrequests:write</code> scopes.</p>`;
    if (s.platform === "circleci") return `<p><code>REPO_ACCESS_TOKEN</code> is a PAT that can push branches and open PRs. <code>REPOSITORY_URL</code> is derived from the checkout's <code>origin</code> remote.</p>`;
    if (s.platform === "jenkins") return `<p><code>repo-access-token</code> is a PAT that can push branches and open PRs. <code>REPOSITORY_URL</code> is derived from the checkout's <code>origin</code> remote.</p>`;
    return "";
  }

  function platformExtraDoc(s) {
    const t = s.triggers;
    if (s.platform === "github") {
      let out = "";
      if (t.schedule || t.manual) out += `<p>Manual and nightly runs do a full baseline scan by design.</p>`;
      return out || `<p>No extra platform setup needed.</p>`;
    }
    if (s.platform === "gitlab") {
      let out = `<p>Use a runner that runs Docker on its host (shell executor on a Docker host, or a <code>docker</code> executor with docker-in-docker) so the started app is reachable on <code>localhost</code>.</p>`;
      if (t.schedule) out += `<p>Create the nightly run under <b>CI/CD → Schedules</b>.</p>`;
      if (t.manual) out += `<p>Manual runs: use <b>CI/CD → Pipelines → Run pipeline</b> (a <code>web</code> source).</p>`;
      return out;
    }
    if (s.platform === "azure") {
      let out = "";
      if (t.pr) out += `<div class="callout warn"><span class="h">PR builds need a Build Validation policy</span>Azure Repos ignores the YAML <code>pr:</code> trigger. Add this pipeline under <b>Project Settings → Repositories → your repo → Policies → (default branch) → Build Validation → "+"</b>. PR builds then scope to the diff automatically.</div>`;
      if (t.schedule) out += `<p>The nightly schedule is declared in the file.</p>`;
      return out || `<p>Run manually with "Run pipeline".</p>`;
    }
    if (s.platform === "bitbucket") {
      let out = `<p>Enable Pipelines (<b>Repository settings → Pipelines → Settings</b>).</p>`;
      if (t.schedule) out += `<p>Add a schedule under <b>Repository settings → Pipelines → Schedules</b> pointing at your branch and the custom pipeline <code>bright-agent-scan</code>.</p>`;
      if (t.manual) out += `<p>Manual runs: <b>Pipelines → Run pipeline</b> → custom → <code>bright-agent-scan</code>.</p>`;
      return out;
    }
    if (s.platform === "circleci") {
      let out = `<div class="callout warn"><span class="h">Use the machine executor</span>The template uses <code>machine: ubuntu-2404</code>. The <code>docker</code> executor with remote Docker can't reach the app on localhost.</div>`;
      if (t.pr) out += `<p>For PR-scoped runs, add a PR-triggered workflow and set <code>SCAN_SCOPE=changed</code> with <code>DIFF_BASE</code> (comment-based steering isn't wired for CircleCI out of the box).</p>`;
      return out;
    }
    if (s.platform === "jenkins") {
      let out = `<p>The executing node needs Docker, Docker Compose, Git and curl on <code>PATH</code>, and permission to run Docker.</p>`;
      if (t.pr) out += `<p>For PR-scoped runs, use a <b>Multibranch Pipeline</b> job so PR branches are built (comment-based steering isn't wired for Jenkins out of the box).</p>`;
      return out;
    }
    return "";
  }

  function steeringDoc(s) {
    const relayCommon = `<p>These platforms have no native "run pipeline on a PR comment" trigger, so bridge it with a webhook + a small relay. <b>The relay is your trust boundary</b> — look up the commenter's role and only forward <code>/bright-agent</code> comments from authorized (Developer+/member) users, setting <code>BRIGHT_STEERING_AUTHOR_ASSOCIATION=MEMBER</code>. Forward the <code>BRIGHT_STEERING_*</code> values (comment body/id, author, PR number, PR head/base branches).</p>`;
    if (s.platform === "gitlab") return relayCommon + `<ol><li>Create a pipeline trigger token (<b>Settings → CI/CD → Pipeline trigger tokens</b>).</li><li>Add a webhook on <b>Comments</b> (note events) pointing at your relay.</li><li>The relay calls <code>POST /projects/:id/trigger/pipeline</code> with <code>ref</code>=MR source branch and the <code>BRIGHT_STEERING_*</code> trigger variables. The <code>$CI_PIPELINE_SOURCE == "trigger"</code> rule runs the job.</li></ol>`;
    if (s.platform === "azure") return relayCommon + `<ol><li>Add an <b>Azure DevOps Service Hook</b> on "Pull request commented on".</li><li>Action: POST to the pipeline Runs API with a <code>templateParameters</code> body mapping the comment into the <code>steering*</code> parameters.</li></ol>`;
    if (s.platform === "bitbucket") return relayCommon + `<ol><li>Add a webhook on <b>Pull Request: Comment created</b>.</li><li>The relay calls the Bitbucket Pipelines API to trigger the <code>bright-agent-steering</code> custom pipeline on the PR source branch with the <code>BRIGHT_STEERING_*</code> variables.</li></ol>`;
    return relayCommon;
  }

  function validationDoc(s) {
    if (s.platform === "github" && s.sarifTool === "codeql") {
      return `<p>The workflow runs CodeQL for <code>${esc(s.sarifLanguage)}</code>, then STAR validates those findings against the live app (<code>RUN_MODE=validation</code>). Compiled languages (Java, Go, C#, C++) may need a real build step in place of <code>autobuild</code>.</p>`;
    }
    return `<p>Produce a SARIF file in an earlier job/stage (CodeQL, Semgrep, Snyk, …), write it <b>outside the checkout</b>, and point <code>SARIF_PATH</code> at it. STAR confirms or dismisses each finding against the running app — no fix loop.</p>`;
  }

  function generateDoc(s) {
    const P = PLATFORMS[s.platform];
    let h = "";
    h += `<div class="callout info"><span class="h">Summary</span>${summaryLine(s)}</div>`;
    h += docSection("1 · Add the workflow file",
      `<p>Save the generated file to this path in your application repository:</p><p><span class="path">${esc(P.file)}</span></p>`);
    if (s.platform === "github" && usesSteering(s)) {
      h += `<div class="callout"><span class="h">Commit to the default branch</span>GitHub only triggers <code>issue_comment</code> workflows from the default branch, so <code>/bright-agent</code> steering works only once this file is merged there.</div>`;
    }
    if (s.platform === "azure") {
      h += `<p>Then create a pipeline from it: <b>Pipelines → New pipeline → Azure Repos Git → Existing YAML</b>.</p>`;
    }
    let tbl = `<table><thead><tr><th>Name</th><th>Type</th><th>Purpose</th></tr></thead><tbody>`;
    secretRows(s).forEach(([n, ty, d]) => { tbl += `<tr><td><code>${esc(n)}</code></td><td>${esc(ty)}</td><td>${esc(d)}</td></tr>`; });
    tbl += `</tbody></table>`;
    h += docSection("2 · Add secrets & variables", `<p>Add these in <b>${esc(SETTINGS_LOC[s.platform])}</b>:</p>${tbl}`);
    if (s.platform === "jenkins") {
      h += `<p>Use these credential IDs: <code>bright-token</code>, <code>repo-access-token</code>, <code>${usesOpenAIKey(s) ? "openai-api-key" : "inference-token"}</code>.</p>`;
    }
    h += docSection("3 · Repository access", repoAccessDoc(s));
    const extra = platformExtraDoc(s);
    if (extra) h += docSection("4 · Platform setup", extra);
    if (usesSteering(s) && !P.nativeSteering) h += docSection("5 · Wire /bright-agent comment steering", steeringDoc(s));
    if (s.runMode === "validation") h += docSection("SAST validation", validationDoc(s));
    h += docSection("Runner prerequisites",
      `<p>The runner must have <b>Docker</b>, <b>Docker Compose</b>, <b>Git</b>, <code>curl</code> and <code>sha256sum</code>, and be able to reach the started app on <code>localhost</code>. A full scan builds and runs your whole app, so schedule baselines nightly rather than on every push.</p>`);
    return h;
  }

  // -------------------------------------------------------------------------
  // Lightweight syntax highlight
  // -------------------------------------------------------------------------
  function keyHighlight(str) {
    let out = str.replace(/^(\s*(?:-\s*)?)([A-Za-z0-9_.\-]+)(:)(\s|$)/, (m, a, k, c, e) => `${a}<span class="k">${k}</span>${c}${e}`);
    out = out.replace(/(&quot;[^&]*?&quot;|&#39;[^&]*?&#39;)/g, '<span class="s">$1</span>');
    return out;
  }
  function highlight(src, lang) {
    const commentChar = lang === "groovy" ? "//" : "#";
    return src.split("\n").map((line) => {
      const cIdx = line.indexOf(commentChar);
      const isComment = cIdx === 0
        || (lang === "groovy" && cIdx >= 0)
        || (lang !== "groovy" && cIdx > 0 && /\s#/.test(line));
      if (isComment) return keyHighlight(esc(line.slice(0, cIdx))) + `<span class="c">${esc(line.slice(cIdx))}</span>`;
      return keyHighlight(esc(line));
    }).join("\n");
  }

  // -------------------------------------------------------------------------
  return {
    PLATFORMS, TRIGGER_META, RUN_MODES, SCOPES, PROVIDERS, ARCHES, SETTINGS_LOC,
    defaultState,
    // helpers
    esc, dlBase, activeTriggers, usesPR, usesSteering, usesOpenAIKey,
    inferenceSecretName, needsRepoToken, scanKnobs, yamlScalar, shellQuote, inferenceEnvLines,
    // generators
    generateGitHub, generateGitLab, generateAzure, generateBitbucket, generateCircle, generateJenkins,
    generateYaml, fileName, codeLang,
    // docs
    secretRows, summaryLine, repoAccessDoc, platformExtraDoc, steeringDoc, validationDoc, generateDoc,
    // highlight
    highlight, keyHighlight,
  };
});
