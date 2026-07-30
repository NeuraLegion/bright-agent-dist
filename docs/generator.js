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
    azure:       { t: "Azure OpenAI / Foundry", url: "https://<resource>.openai.azure.com/openai/v1", model: "gpt-5.4-mini" },
    anthropic:   { t: "Anthropic", url: "https://api.anthropic.com/v1", model: "claude-sonnet-5,claude-opus-4-8" },
    ollama:      { t: "Ollama (self-hosted)", url: "http://localhost:11434/v1", model: "llama3.1" },
    custom:      { t: "Custom OpenAI-compatible", url: "https://your-gateway.example.com/v1", model: "" },
  };

  const ARCHES = ["bright-agent-linux-x64","bright-agent-linux-arm64","bright-agent-darwin-x64","bright-agent-darwin-arm64"];

  const SETTINGS_LOC = {
    github: 'Settings → Secrets and variables → Actions (Secrets tab)',
    gitlab: 'Settings → CI/CD → Variables (tick Mask; leave Protected off so merge-request pipelines receive them)',
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
  const needsRepoToken = (s) => s.tokenMode === "pat" || !PLATFORMS[s.platform].builtinToken;

  /** Extra scan knobs shared across platforms (same env var names everywhere). */
  function scanKnobs(s) {
    const out = [];
    if (s.scope !== "auto" && s.runMode !== "validation") out.push({ k: "SCAN_SCOPE", v: s.scope });
    if (s.runMode !== "full") out.push({ k: "RUN_MODE", v: s.runMode });
    if (s.runMode === "validation") out.push({ k: "SARIF_PATH", v: s.sarifPath || "REPLACE_WITH_PATH_TO.sarif" });
    // AI_MODEL is baked into the file: use the explicit value, else the
    // provider's default model, so the generated workflow is self-describing.
    const aiModel = (s.aiModel || "").trim() || (PROVIDERS[s.provider] && PROVIDERS[s.provider].model) || "";
    if (aiModel) out.push({ k: "AI_MODEL", v: aiModel });
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

  // Single-quoted Groovy string literal. Escape backslashes first, then quotes,
  // so user-editable values can't break out of the string or inject into the
  // generated Jenkinsfile.
  function groovyQuote(v) {
    return `'${String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  }

  function inferenceEnvLines(s, indent, prefix) {
    const lines = [];
    // INFERENCE_URL is hardcoded from the builder selection (it's a plain,
    // non-secret value), not read from a CI variable.
    lines.push(`${indent}INFERENCE_URL: ${yamlScalar(s.inferenceUrl)}`);
    lines.push(`${indent}INFERENCE_TOKEN: ${prefix.secret("INFERENCE_TOKEN")}`);
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
    inferenceEnvLines(s, "          ", { secret: (n) => `\${{ secrets.${n} }}` }).forEach((x) => L.push(x));
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
    if (s.debug) {
      // Verbose logging: keep the full run log (written to ~/.bright-agent/logs
      // regardless of console mirroring) as a CI artifact. `if: always()` so it
      // survives a failed run; upload-artifact expands `~` to the runner home.
      L.push(``);
      L.push(`      - name: Upload Bright Agent logs`);
      L.push(`        if: always()`);
      L.push(`        uses: actions/upload-artifact@v4`);
      L.push(`        with:`);
      L.push(`          name: bright-agent-logs`);
      L.push(`          path: ~/.bright-agent/logs/`);
      L.push(`          if-no-files-found: ignore`);
    }
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
    L.push(`# CI/CD variables (Settings -> CI/CD -> Variables):`);
    L.push(`#   BRIGHT_TOKEN, REPO_ACCESS_TOKEN (PAT/Project token, api scope, Developer+),`);
    L.push(`#   INFERENCE_TOKEN   (INFERENCE_URL is set in this file, below)`);
    L.push(`# Tick "Mask" on the secrets, but leave "Protected" UNCHECKED: protected`);
    L.push(`# variables are only exposed on protected branches/tags, so a merge-request`);
    L.push(`# pipeline from a feature branch would run WITHOUT them and the agent fails`);
    L.push(`# with 'Missing required environment variable: BRIGHT_TOKEN'.`);
    L.push(``);
    L.push(`bright-agent:`);
    L.push(`  stage: test`);
    L.push(`  tags: [docker] # a Docker-capable runner that can reach the app on localhost`);
    L.push(`  variables:`);
    L.push(`    ASSET: ${s.asset}`);
    L.push(`    GIT_DEPTH: "0"`);
    L.push(`  rules:`);
    if (t.pr) {
      L.push(`    # Guard: never run on the agent's own scan branches. An agent-created`);
      L.push(`    # "bright-scan-*" MR would otherwise trigger another merge_request`);
      L.push(`    # pipeline, which runs the agent again and opens yet another MR — an`);
      L.push(`    # exponential feedback loop.`);
      L.push(`    - if: '$CI_MERGE_REQUEST_SOURCE_BRANCH_NAME =~ /^bright-scan-/'`);
      L.push(`      when: never`);
      L.push(`    - if: '$CI_COMMIT_BRANCH =~ /^bright-scan-/'`);
      L.push(`      when: never`);
    }
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
    L.push(`      export INFERENCE_URL=${shellQuote(s.inferenceUrl)}`);
    scanKnobs(s).forEach(({ k, v }) => L.push(`      export ${k}=${shellQuote(v)}`));
    L.push(`      export BRIGHT_CI_TIMEOUT_MINUTES=${shellQuote(s.timeoutMinutes)}`);
    L.push(`      "$tmp/$ASSET"`);
    if (s.debug) {
      // GitLab only collects artifacts from inside $CI_PROJECT_DIR, and the run
      // log lives in ~/.bright-agent/logs. Copy it into the project dir in
      // after_script (runs even if the job fails) then upload it.
      L.push(`  after_script:`);
      L.push(`    - mkdir -p "$CI_PROJECT_DIR/bright-agent-logs"`);
      L.push(`    - cp -a ~/.bright-agent/logs/. "$CI_PROJECT_DIR/bright-agent-logs/" 2>/dev/null || true`);
      L.push(`  artifacts:`);
      L.push(`    name: bright-agent-logs`);
      L.push(`    when: always`);
      L.push(`    expire_in: 1 week`);
      L.push(`    paths:`);
      L.push(`      - bright-agent-logs/`);
    }
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
    L.push(`#   BRIGHT_TOKEN, INFERENCE_TOKEN${s.tokenMode === "pat" ? ", REPO_ACCESS_TOKEN" : ""}   (INFERENCE_URL is set in this file)`);
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
    L.push(`      INFERENCE_URL: ${yamlScalar(s.inferenceUrl)}`);
    L.push(`      INFERENCE_TOKEN: $(INFERENCE_TOKEN)`);
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
    if (s.debug) {
      // Stage the run log (~/.bright-agent/logs) into the artifact staging dir
      // with a bash step so `~` expands, then publish it. Both steps use
      // condition: always() so logs survive a failed run.
      L.push(``);
      L.push(`  - bash: |`);
      L.push(`      mkdir -p "$(Build.ArtifactStagingDirectory)/bright-agent-logs"`);
      L.push(`      cp -a ~/.bright-agent/logs/. "$(Build.ArtifactStagingDirectory)/bright-agent-logs/" 2>/dev/null || true`);
      L.push(`    displayName: Collect Bright Agent logs`);
      L.push(`    condition: always()`);
      L.push(``);
      L.push(`  - task: PublishPipelineArtifact@1`);
      L.push(`    displayName: Upload Bright Agent logs`);
      L.push(`    condition: always()`);
      L.push(`    inputs:`);
      L.push(`      targetPath: $(Build.ArtifactStagingDirectory)/bright-agent-logs`);
      L.push(`      artifact: bright-agent-logs`);
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
    L.push(`#   INFERENCE_TOKEN   (INFERENCE_URL is set in this file, below)`);
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
    L.push(`            export INFERENCE_URL=${shellQuote(s.inferenceUrl)}`);
    scanKnobs(s).forEach(({ k, v }) => L.push(`            export ${k}=${shellQuote(v)}`));
    L.push(`            export BRIGHT_CI_TIMEOUT_MINUTES=${shellQuote(s.timeoutMinutes)}`);
    L.push(`            "/tmp/$ASSET"`);
    if (s.debug) {
      // Bitbucket only uploads artifacts from inside $BITBUCKET_CLONE_DIR, so
      // copy the run log there in after-script (runs even when the step fails).
      L.push(`        after-script:`);
      L.push(`          - mkdir -p "$BITBUCKET_CLONE_DIR/bright-agent-logs"`);
      L.push(`          - cp -a ~/.bright-agent/logs/. "$BITBUCKET_CLONE_DIR/bright-agent-logs/" 2>/dev/null || true`);
      L.push(`        artifacts:`);
      L.push(`          - bright-agent-logs/**`);
    }
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
    L.push(`#   INFERENCE_TOKEN.`);
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
    L.push(`      INFERENCE_URL: ${yamlScalar(s.inferenceUrl)}`);
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
    if (s.debug) {
      // Stage the run log (~/.bright-agent/logs) with `when: always` so it is
      // captured on failure too, then store it as a downloadable artifact.
      L.push(`      - run:`);
      L.push(`          name: Collect Bright Agent logs`);
      L.push(`          when: always`);
      L.push(`          command: |`);
      L.push(`            mkdir -p /tmp/bright-agent-logs`);
      L.push(`            cp -a ~/.bright-agent/logs/. /tmp/bright-agent-logs/ 2>/dev/null || true`);
      L.push(`      - store_artifacts:`);
      L.push(`          path: /tmp/bright-agent-logs`);
      L.push(`          destination: bright-agent-logs`);
    }
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
    L.push(`//   inference-token.`);
    L.push(``);
    L.push(`pipeline {`);
    L.push(`  agent any`);
    L.push(`  environment {`);
    L.push(`    ASSET             = ${groovyQuote(s.asset)}`);
    L.push(`    INFERENCE_URL     = ${groovyQuote(s.inferenceUrl)}`);
    L.push(`    BRIGHT_TOKEN      = credentials('bright-token')`);
    L.push(`    REPO_ACCESS_TOKEN = credentials('repo-access-token')`);
    L.push(`    INFERENCE_TOKEN   = credentials('inference-token')`);
    L.push(`    BRIGHT_CI_TIMEOUT_MINUTES = ${groovyQuote(s.timeoutMinutes)}`);
    scanKnobs(s).forEach(({ k, v }) => L.push(`    ${k} = ${groovyQuote(v)}`));
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
    if (s.debug) {
      // archiveArtifacts can only see files under the workspace, so copy the
      // run log (~/.bright-agent/logs) in first. `post { always }` runs even
      // when a stage fails; allowEmptyArchive avoids failing on no logs.
      L.push(`  post {`);
      L.push(`    always {`);
      L.push(`      sh '''`);
      L.push(`        mkdir -p "\${WORKSPACE}/bright-agent-logs"`);
      L.push(`        cp -a ~/.bright-agent/logs/. "\${WORKSPACE}/bright-agent-logs/" 2>/dev/null || true`);
      L.push(`      '''`);
      L.push(`      archiveArtifacts artifacts: 'bright-agent-logs/**', allowEmptyArchive: true`);
      L.push(`    }`);
      L.push(`  }`);
    }
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
    // INFERENCE_URL and AI_MODEL are written into the workflow file itself, so
    // they are not listed here as CI secrets/variables.
    const rows = [
      ["BRIGHT_TOKEN", "Secret", "Bright API token from app.brightsec.com"],
      ["INFERENCE_TOKEN", "Secret", "API key for your inference endpoint"],
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
      let out = "";
      out += `<div class="callout warn"><span class="h">Do not mark the tokens "Protected"</span>Protected CI/CD variables are exposed only on protected branches/tags. A merge-request pipeline from a feature branch runs without them and the agent fails with <code>Missing required environment variable: BRIGHT_TOKEN</code>. Tick <b>Mask</b>, leave <b>Protected</b> off (or restrict the pipeline to protected branches).</div>`;
      if (t.pr) out += `<div class="callout warn"><span class="h">Avoid the scan-branch feedback loop</span>The generated <code>rules:</code> skip <code>bright-scan-*</code> branches so the agent's own fix/scan MRs don't re-trigger the pipeline. Keep that guard if you customize the rules.</div>`;
      out += `<p>Use a runner that runs Docker on its host (shell executor on a Docker host, or a <code>docker</code> executor with docker-in-docker) so the started app is reachable on <code>localhost</code>. GitLab.com shared SaaS runners don't carry a <code>docker</code> tag and need a dind service — adjust <code>tags:</code> accordingly.</p>`;
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
    const effModel = (s.aiModel || "").trim() || (PROVIDERS[s.provider] && PROVIDERS[s.provider].model) || "";
    h += `<div class="callout info"><span class="h">Inference is set in the file</span><code>INFERENCE_URL</code> (<code>${esc(s.inferenceUrl)}</code>)${effModel ? ` and <code>AI_MODEL</code> (<code>${esc(effModel)}</code>)` : ""} ${effModel ? "are" : "is"} written straight into the workflow from your selections above — no CI variable to add. Edit the file to change ${effModel ? "them" : "it"}.</div>`;
    if (s.platform === "jenkins") {
      h += `<p>Use these credential IDs: <code>bright-token</code>, <code>repo-access-token</code>, <code>inference-token</code>.</p>`;
    }
    h += docSection("3 · Repository access", repoAccessDoc(s));
    const extra = platformExtraDoc(s);
    if (extra) h += docSection("4 · Platform setup", extra);
    if (usesSteering(s) && !P.nativeSteering) h += docSection("5 · Wire /bright-agent comment steering", steeringDoc(s));
    if (s.runMode === "validation") h += docSection("SAST validation", validationDoc(s));
    h += docSection("Runner prerequisites",
      `<p>The runner must have <b>Docker</b>, <b>Docker Compose</b>, <b>Git</b>, <code>curl</code> and <code>sha256sum</code>, and be able to reach the started app on <code>localhost</code>. A full scan builds and runs your whole app, so schedule baselines nightly rather than on every push.</p>`);
    if (s.debug) {
      h += `<div class="callout info"><span class="h">Logs are uploaded as an artifact</span>Verbose logging is on, so the full run log (<code>~/.bright-agent/logs/</code>) is uploaded as the <code>bright-agent-logs</code> CI artifact — kept even if the run fails. Secrets are redacted from the log. ${s.platform === "gitlab" || s.platform === "bitbucket" || s.platform === "jenkins" ? "The workflow copies it into the build workspace first, since this platform only collects artifacts from there." : ""}</div>`;
    }
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
    esc, dlBase, activeTriggers, usesPR, usesSteering,
    needsRepoToken, scanKnobs, yamlScalar, shellQuote, groovyQuote, inferenceEnvLines,
    // generators
    generateGitHub, generateGitLab, generateAzure, generateBitbucket, generateCircle, generateJenkins,
    generateYaml, fileName, codeLang,
    // docs
    secretRows, summaryLine, repoAccessDoc, platformExtraDoc, steeringDoc, validationDoc, generateDoc,
    // highlight
    highlight, keyHighlight,
  };
});
