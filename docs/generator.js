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
    push:     { t: "Branch push", d: "Diff-scoped scan of every regular branch push against its previous tip; bright-scan-* branches are excluded." },
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
    auto:    { t: "Auto (recommended)", d: "Diff-scoped on PR/MR, steering, and branch-push events; full on manual and scheduled runs." },
    changed: { t: "Force diff", d: "Always scope to the changed files; needs a base ref." },
    full:    { t: "Force full", d: "Scan the whole repository regardless of trigger." },
  };

  const PROVIDERS = {
    openai:      { t: "OpenAI", url: "https://api.openai.com/v1", model: "gpt-5.4-mini,gpt-5.4" },
    azure:       { t: "Azure OpenAI / Foundry", url: "https://<resource>.openai.azure.com/openai/v1", model: "gpt-5.4-mini,gpt-5.4" },
    anthropic:   { t: "Anthropic", url: "https://api.anthropic.com/v1", model: "claude-sonnet-5,claude-opus-4-8" },
    bedrock:     { t: "AWS Bedrock", url: "https://bedrock-mantle.us-east-1.api.aws/v1", model: "" },
    ollama:      { t: "Ollama (self-hosted)", url: "http://localhost:11434/v1", model: "llama3.1" },
    custom:      { t: "Custom OpenAI-compatible", url: "https://your-gateway.example.com/v1", model: "" },
  };

  // Known Anthropic Messages-compatible Bedrock model ID. This is an
  // example/placeholder rather than an implicit default: availability varies
  // by AWS account and region, so the user must explicitly confirm AI_MODEL.
  const BEDROCK_OIDC_MODEL_EXAMPLE = "anthropic.claude-sonnet-4-20250514-v1:0";

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
      inferenceAuth: "token",
      awsRoleArn: "",
      awsRegion: "us-east-1",
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
      brightHostname: "",
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

  /**
   * Compact, safe HTML summary of the effective coverage for each trigger.
   * Keep this separate from workflow generation so the browser can render it
   * directly and tests can exercise the behavior without a DOM.
   */
  function workflowBehavior(s) {
    const triggers = activeTriggers(s);
    const title = `<span class="h">Scan behavior by trigger</span>`;
    const intro = `<p><code>RUN_MODE</code> controls target startup; <code>SCAN_SCOPE</code> controls repository coverage. <code>RUN_MODE=full</code> does not mean a full repository scan.</p>`;
    if (!triggers.length) return `${title}${intro}<p>No triggers selected.</p>`;

    const validation = s.runMode === "validation";
    const externalSarifPath = String(s.sarifPath || "").trim();
    const generatedCodeqlSarif = s.platform === "github" && s.sarifTool === "codeql";
    const githubEvents = {
      manual: "Manual dispatch — <code>workflow_dispatch</code>",
      schedule: "Nightly schedule — <code>schedule</code>",
      pr: "Pull request — <code>pull_request</code>",
      push: "Branch push — <code>push</code>",
      steering: "Comment steering — <code>issue_comment /bright-agent</code>",
    };
    const genericLabels = {
      manual: "Manual run",
      schedule: "Scheduled run",
      pr: PLATFORMS[s.platform].prWord,
      push: "Branch push",
      steering: "/bright-agent comment steering",
    };
    const effectiveScope = (trigger) => {
      if (validation) return null;
      if (s.scope === "full") return "full";
      if (s.scope === "changed") return "changed";
      return trigger === "manual" || trigger === "schedule" ? "full" : "changed";
    };

    const rows = triggers.map((trigger) => {
      const scope = effectiveScope(trigger);
      const label = s.platform === "github" ? githubEvents[trigger] : esc(genericLabels[trigger]);
      const parts = [];

      if (s.platform === "circleci" && trigger === "manual" && s.triggers.schedule) {
        parts.push(`Not emitted separately. When schedule is selected, the CircleCI generator emits only the <code>nightly-dast</code> workflow.`);
        return `<li><strong>${label}</strong>: ${parts.join(" ")}</li>`;
      }

      if (validation) {
        if (generatedCodeqlSarif) {
          parts.push(`Runs SARIF validation with no fix loop, using CodeQL results generated by this workflow.`);
        } else if (externalSarifPath) {
          parts.push(`Runs SARIF validation from <code>${esc(externalSarifPath)}</code> with no fix loop.`);
        } else {
          parts.push(`<code>SARIF_PATH</code> is emitted as <code>REPLACE_WITH_PATH_TO.sarif</code>; replace it before this validation can run.`);
        }
        parts.push(`<code>SCAN_SCOPE</code> and <code>DIFF_BASE</code> are not generated, so this event is not classified as full or changed.`);
      } else {
        parts.push(scope === "full" ? `Full repository scan.` : `Changed-files scan.`);
      }

      if (s.platform === "github") {
        if (trigger === "pr") {
          parts.push(`The trigger filters PRs targeting <code>${esc(s.defaultBranch)}</code>.`);
        }
        if (!validation && scope === "changed") {
          if (trigger === "pr") parts.push(`Diff source: actual PR base branch <code>origin/&lt;base&gt;</code>, not the configured default branch.`);
          if (trigger === "steering") parts.push(`Diff source: resolved commented PR base <code>origin/&lt;base&gt;</code>.`);
          if (trigger === "push") parts.push(`Diff source: <code>github.event.before</code>, the previous branch tip.`);
          if (trigger === "manual" || trigger === "schedule") {
            parts.push(`The generated workflow has no event-specific <code>DIFF_BASE</code>; add <code>DIFF_BASE: ...</code> to the <code>Run Bright Agent</code> step's <code>env</code> block to guarantee a diff.`);
          }
        }
        if (trigger === "push") {
          parts.push(`Initial branch-creation and branch-deletion pushes are skipped; <code>bright-scan-*</code> branches are excluded.`);
        }
        if (trigger === "manual" && usesBedrockOidc(s)) {
          parts.push(validation
            ? `<code>preflight=true</code> performs only the access/model check and skips SARIF preparation and validation; <code>preflight=false</code> is the default and follows the validation path described above.`
            : `<code>preflight=true</code> validates access and model availability without a scan; <code>preflight=false</code> is the default and performs the configured scan.`);
        }
      } else {
        if (trigger === "pr") {
          parts.push(`The PR/MR base comes from the CI context for changed-file coverage.`);
        }
        if (!validation && scope === "changed" && (trigger === "manual" || trigger === "schedule")) {
          parts.push(`Provide a base reference through the CI configuration to guarantee a diff.`);
        }
      }

      return `<li><strong>${label}</strong>: ${parts.join(" ")}</li>`;
    });

    return `${title}${intro}<ul>${rows.join("")}</ul>`;
  }
  const usesPR = (s) => activeTriggers(s).includes("pr");
  const usesSteering = (s) => activeTriggers(s).includes("steering");
  const needsRepoToken = (s) => s.tokenMode === "pat" || !PLATFORMS[s.platform].builtinToken;
  const wantsAwsOidc = (s) => s.inferenceAuth === "aws-oidc";
  const usesBedrockOidc = (s) => s.platform === "github" && s.provider === "bedrock" && wantsAwsOidc(s);

  function bedrockInferenceUrl(region) {
    return `https://bedrock-mantle.${String(region || "").trim() || "us-east-1"}.api.aws/v1`;
  }

  function effectiveInferenceUrl(s) {
    return usesBedrockOidc(s) ? bedrockInferenceUrl(s.awsRegion) : s.inferenceUrl;
  }

  function effectiveAiModel(s) {
    return (s.aiModel || "").trim() || (PROVIDERS[s.provider] && PROVIDERS[s.provider].model) || "";
  }

  const bedrockModelIds = (s) => String(s.aiModel || "").split(",").map((model) => model.trim()).filter(Boolean);
  const bedrockFamilyPattern = (family) => new RegExp(
    `^(?:(?:us|eu|apac|global)\\.)?${family}\\.[A-Za-z0-9][A-Za-z0-9_-]*(?:[.:][A-Za-z0-9][A-Za-z0-9_-]*)*$`,
    "i",
  );
  const isBedrockAnthropicModel = (model) => bedrockFamilyPattern("anthropic").test(model);
  const isBedrockOpenAiModel = (model) => bedrockFamilyPattern("openai").test(model);
  function bedrockModelFamily(s) {
    const models = bedrockModelIds(s);
    if (!models.length) return null;
    if (models.every(isBedrockAnthropicModel)) return "anthropic";
    if (models.every(isBedrockOpenAiModel)) return "openai";
    return null;
  }

  /** Blocking configuration errors surfaced by the browser before copy/download. */
  function configurationErrors(s) {
    const oidc = wantsAwsOidc(s);
    const bedrock = s.provider === "bedrock";
    if (!oidc && !bedrock) return [];

    const errors = [];
    if (oidc && s.platform !== "github") errors.push("AWS Bedrock OIDC generation is currently supported only for GitHub Actions.");
    if (oidc && !bedrock) errors.push("AWS OIDC authentication requires the AWS Bedrock provider.");

    if (oidc) {
      const role = String(s.awsRoleArn || "").trim();
      const roleMatch = /^arn:aws:iam::\d{12}:role\/(?:[A-Za-z0-9+=,.@_-]+\/)*[A-Za-z0-9+=,.@_-]+$/.exec(role);
      if (!roleMatch || role.includes("${{") || /[\x00-\x1F\x7F]/.test(role)) {
        errors.push("Enter a valid commercial-partition AWS IAM role ARN (arn:aws:iam::…), including the 12-digit account ID and a non-empty role name.");
      }

      const region = String(s.awsRegion || "").trim();
      // Commercial regions supported by the generated .api.aws endpoint.
      // Keep this compact list current when AWS launches another region.
      const commercialRegion = /^(?:us-(?:east|west)-[12]|af-south-1|ap-(?:east-[12]|northeast-[123]|south-[12]|southeast-[1-7])|ca-(?:central|west)-1|eu-(?:central-[12]|north-1|south-[12]|west-[123])|il-central-1|me-(?:central|south)-1|mx-central-1|sa-east-1)$/;
      if (!commercialRegion.test(region) || region.includes("${{") || /[\x00-\x1F\x7F]/.test(region)) {
        errors.push("Enter a supported commercial AWS region such as us-east-1; China and GovCloud endpoints are not generated.");
      }
    }

    if (bedrock) {
      const modelChain = String(s.aiModel || "").trim();
      const models = bedrockModelIds(s);
      const safeModel = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
      if (!modelChain) {
        errors.push("Enter an AWS Bedrock model or inference-profile ID in AI_MODEL.");
      } else if (
        modelChain.includes("${{") ||
        /[\x00-\x1F\x7F]/.test(modelChain) ||
        models.length === 0 ||
        models.some((model) => !safeModel.test(model))
      ) {
        errors.push("AI_MODEL must contain only comma-separated Bedrock model or inference-profile IDs.");
      } else if (!bedrockModelFamily(s)) {
        errors.push("Use only OpenAI (openai.*) or Anthropic (anthropic.*) Bedrock IDs, and do not mix API families in one escalation chain.");
      }
    }
    return errors;
  }

  /** Extra scan knobs shared across platforms (same env var names everywhere). */
  function scanKnobs(s) {
    const out = [];
    if (s.scope !== "auto" && s.runMode !== "validation") out.push({ k: "SCAN_SCOPE", v: s.scope });
    if (s.runMode !== "full") out.push({ k: "RUN_MODE", v: s.runMode });
    if (s.runMode === "validation") out.push({ k: "SARIF_PATH", v: s.sarifPath || "REPLACE_WITH_PATH_TO.sarif" });
    // AI_MODEL is baked into the file: use the explicit value, else the
    // provider's default model, so the generated workflow is self-describing.
    const aiModel = effectiveAiModel(s);
    if (aiModel) out.push({ k: "AI_MODEL", v: aiModel });
    if ((s.serviceRoot || "").trim()) out.push({ k: "BRIGHT_SERVICE_ROOT", v: s.serviceRoot.trim() });
    if ((s.scmOverride || "").trim()) out.push({ k: "BRIGHT_SCM_PLATFORM", v: s.scmOverride.trim() });
    // BRIGHT_HOSTNAME overrides the default Bright cluster host (app.brightsec.com)
    // for EU/dedicated/self-hosted clusters. Non-secret, so baked into the file.
    if ((s.brightHostname || "").trim()) out.push({ k: "BRIGHT_HOSTNAME", v: s.brightHostname.trim() });
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
    // non-secret value), not read from a CI variable. Bedrock OIDC derives the
    // exact AWS-owned hostname from the selected region.
    lines.push(`${indent}INFERENCE_URL: ${yamlScalar(effectiveInferenceUrl(s))}`);
    if (s.provider === "bedrock") {
      const family = bedrockModelFamily(s);
      if (family) {
        // Pin the API client explicitly for both OIDC and API-key modes.
        // This is required for regional profiles such as us.anthropic.* and
        // ensures Bedrock bearer tokens use the Anthropic Messages client for
        // Claude models and the Chat Completions client for OpenAI models.
        lines.push(`${indent}INFERENCE_PROVIDER: ${family}`);
        if (family === "openai") lines.push(`${indent}AI_API_MODE: chat`);
      }
    }
    if (!usesBedrockOidc(s)) {
      lines.push(`${indent}INFERENCE_TOKEN: ${prefix.secret("INFERENCE_TOKEN")}`);
    }
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
    if (t.pr) {
      L.push(`  pull_request:`);
      L.push(`    branches: ["${s.defaultBranch}"]`);
      L.push(`    types: [opened, synchronize, reopened]`);
    }
    if (t.push) {
      L.push(`  push:`);
      L.push(`    branches-ignore: ["bright-scan-*"]`);
    }
    if (t.steering) { L.push(`  issue_comment:`); L.push(`    types: [created]`); }
    if (t.manual) {
      L.push(`  workflow_dispatch:`);
      if (usesBedrockOidc(s)) {
        L.push(`    inputs:`);
        L.push(`      preflight:`);
        L.push(`        description: Validate credentials and model without scanning`);
        L.push(`        required: false`);
        L.push(`        type: boolean`);
        L.push(`        default: false`);
      }
    }
    if (t.schedule) { L.push(`  schedule:`); L.push(`    - cron: "0 3 * * *" # nightly 03:00 UTC`); }
    L.push(``);
    L.push(`permissions:`);
    if (usesBedrockOidc(s)) L.push(`  id-token: write       # request a GitHub OIDC token for AWS`);
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
    if (t.pr) gate.push(`(github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository && !startsWith(github.event.pull_request.head.ref, 'bright-scan-'))`);
    if (t.push) gate.push(`(github.event_name == 'push' && github.event.created == false && github.event.deleted == false)`);
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
    if (t.push) refParts.push(`(github.event_name == 'push' && github.sha)`);
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

    if (t.push && s.runMode !== "validation" && s.scope !== "full") {
      L.push(`      - name: Ensure push base commit is available`);
      L.push(`        if: github.event_name == 'push'`);
      L.push(`        env:`);
      L.push(`          BEFORE_SHA: \${{ github.event.before }}`);
      L.push(`        run: |`);
      L.push(`          if ! git cat-file -e "\${BEFORE_SHA}^{commit}" 2>/dev/null; then`);
      L.push(`            git fetch --no-tags origin "\${BEFORE_SHA}"`);
      L.push(`          fi`);
      L.push(`          git cat-file -e "\${BEFORE_SHA}^{commit}"`);
    }

    if (s.runMode === "validation" && s.sarifTool === "codeql") {
      L.push(`      - name: Initialize CodeQL`);
      if (usesBedrockOidc(s) && t.manual) L.push(`        if: \${{ github.event_name != 'workflow_dispatch' || inputs.preflight != true }}`);
      L.push(`        uses: github/codeql-action/init@v3`);
      L.push(`        with:`);
      L.push(`          languages: ${s.sarifLanguage}`);
      L.push(`      - name: Autobuild`);
      if (usesBedrockOidc(s) && t.manual) L.push(`        if: \${{ github.event_name != 'workflow_dispatch' || inputs.preflight != true }}`);
      L.push(`        uses: github/codeql-action/autobuild@v3`);
      L.push(`      - name: Analyze (write SARIF to temp)`);
      if (usesBedrockOidc(s) && t.manual) L.push(`        if: \${{ github.event_name != 'workflow_dispatch' || inputs.preflight != true }}`);
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

    // Configure exported AWS_* credentials as late as possible to shorten their
    // lifetime in later steps. This is not a trust boundary: id-token: write is
    // job-wide, so every same-repository process in this job must be trusted.
    if (usesBedrockOidc(s)) {
      const roleArn = String(s.awsRoleArn || "").trim() || "REPLACE_WITH_AWS_ROLE_ARN";
      const region = String(s.awsRegion || "").trim() || "us-east-1";
      L.push(`      - name: Configure AWS credentials through GitHub OIDC`);
      L.push(`        uses: aws-actions/configure-aws-credentials@v4`);
      L.push(`        with:`);
      L.push(`          role-to-assume: ${yamlScalar(roleArn)}`);
      L.push(`          aws-region: ${yamlScalar(region)}`);
      L.push(`          role-session-name: bright-agent-\${{ github.run_id }}`);
    }

    L.push(`      - name: Run Bright Agent`);
    L.push(`        env:`);
    L.push(`          LOCAL_REPO_PATH: \${{ github.workspace }}`);
    const tokenRef = s.tokenMode === "pat" ? `\${{ secrets.REPO_ACCESS_TOKEN }}` : `\${{ secrets.GITHUB_TOKEN }}`;
    L.push(`          REPO_ACCESS_TOKEN: ${tokenRef}`);
    L.push(`          BRIGHT_TOKEN: \${{ secrets.BRIGHT_TOKEN }}`);
    inferenceEnvLines(s, "          ", { secret: (n) => `\${{ secrets.${n} }}` }).forEach((x) => L.push(x));
    if (usesBedrockOidc(s) && t.manual) {
      L.push(`          BRIGHT_PREFLIGHT_ONLY: \${{ github.event_name == 'workflow_dispatch' && inputs.preflight && '1' || '0' }}`);
    }
    const hasFullTrigger = t.manual || t.schedule;
    const hasDiffTrigger = t.pr || t.push || t.steering;
    if (s.runMode !== "validation") {
      let scanScope = s.scope;
      if (s.scope === "auto") {
        const fullEvents = [];
        if (t.manual) fullEvents.push("github.event_name == 'workflow_dispatch'");
        if (t.schedule) fullEvents.push("github.event_name == 'schedule'");
        scanScope = hasFullTrigger && hasDiffTrigger
          ? `\${{ (${fullEvents.join(" || ")}) && 'full' || 'changed' }}`
          : (hasFullTrigger ? "full" : "changed");
      }
      L.push(`          SCAN_SCOPE: ${scanScope}`);
    }
    scanKnobs(s).filter(({ k }) => k !== "SCAN_SCOPE").forEach(({ k, v }) => {
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
    if (s.runMode !== "validation" && s.scope !== "full") {
      const diffBases = [];
      if (t.steering) diffBases.push({
        event: "issue_comment",
        value: "steps.steer.outputs.base_ref && format('origin/{0}', steps.steer.outputs.base_ref) || ''",
      });
      if (t.pr) diffBases.push({
        event: "pull_request",
        value: "format('origin/{0}', github.event.pull_request.base.ref)",
      });
      if (t.push) diffBases.push({ event: "push", value: "github.event.before" });
      if (diffBases.length) {
        const diffBase = diffBases.length === 1 && !hasFullTrigger
          ? diffBases[0].value
          : diffBases.map(({ event, value }) => `(github.event_name == '${event}' && (${value}) || '')`).join(" || ");
        L.push(`          DIFF_BASE: \${{ ${diffBase} }}`);
      }
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
    // they are not listed here as CI secrets/variables. Bedrock OIDC obtains
    // temporary AWS credentials at runtime and therefore needs no inference secret.
    const rows = [
      ["BRIGHT_TOKEN", "Secret", "Bright API token from app.brightsec.com"],
    ];
    if (!usesBedrockOidc(s)) rows.push(["INFERENCE_TOKEN", "Secret", "API key for your inference endpoint"]);
    if (needsRepoToken(s)) rows.push(["REPO_ACCESS_TOKEN", "Secret", "Token that can push branches and open PRs/MRs"]);
    return rows;
  }

  function summaryLine(s) {
    const P = PLATFORMS[s.platform];
    const trg = activeTriggers(s).map((t) => (t === "pr" ? P.prWord.toLowerCase() : t)).join(", ");
    const parts = [`On <b>${esc(P.name)}</b>, runs on <b>${esc(trg || "—")}</b>`];
    parts.push(`in <b>${esc(RUN_MODES[s.runMode].t.replace(/ \(.*\)/, "").toLowerCase())}</b> mode`);
    if (s.runMode !== "validation") parts.push(`with <b>${esc(SCOPES[s.scope].t.replace(/ \(.*\)/, "").toLowerCase())}</b> scope`);
    if (usesBedrockOidc(s)) parts.push(`using <b>AWS Bedrock IAM/OIDC</b>`);
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
      if (usesBedrockOidc(s)) {
        const family = bedrockModelFamily(s);
        const modelListPermission = family === "openai"
          ? ` Grant <code>bedrock-mantle:ListModels</code> when preflight should verify model availability.`
          : "";
        out += `<div class="callout info"><span class="h">AWS role trust and permissions</span>The workflow adds job-wide <code>id-token: write</code> and uses <code>aws-actions/configure-aws-credentials@v4</code>. Configure the IAM role trust policy with audience <code>sts.amazonaws.com</code> and restrict the GitHub <code>sub</code> claim to this repository's pull-request, branch, or protected environment context. Any same-repository code executing in this job — including build tools and the application STAR starts — can request or use this role. For the Bedrock Mantle endpoint, grant <code>bedrock-mantle:CallWithBearerToken</code> so the short-term token can be used and <code>bedrock-mantle:CreateInference</code> on the intended Mantle project.${modelListPermission} Also grant <code>bedrock:InvokeModel</code> and, when needed, <code>bedrock:InvokeModelWithResponseStream</code> for the selected models or inference profiles. Grant no unrelated AWS permissions, and keep the workflow disabled for fork PRs.</div>`;
        out += `<div class="callout info"><span class="h">Model API family</span>The generated workflow selects the API client from <code>AI_MODEL</code>: <code>anthropic.*</code> models use Bedrock's native Anthropic Messages route with IAM Bearer authentication, while <code>openai.*</code> models use the OpenAI-compatible Chat Completions route. Keep every model in an escalation chain within the same API family.</div>`;
        out += t.manual
          ? `<p>The browser cannot test GitHub OIDC or assume the AWS role. Commit the workflow, choose <b>Run workflow</b>, enable the <code>preflight</code> input, and run it to validate credentials and model access without scanning.</p>`
          : `<p>The browser cannot test GitHub OIDC or assume the AWS role. Enable the <b>Manual</b> trigger to generate a <code>preflight</code> workflow input for credential and model validation.</p>`;
      }
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
    const effModel = effectiveAiModel(s);
    const effUrl = effectiveInferenceUrl(s);
    h += `<div class="callout info"><span class="h">Inference is set in the file</span><code>INFERENCE_URL</code> (<code>${esc(effUrl)}</code>)${effModel ? ` and <code>AI_MODEL</code> (<code>${esc(effModel)}</code>)` : ""} ${effModel ? "are" : "is"} written straight into the workflow from your selections above — no CI variable to add. Edit the file to change ${effModel ? "them" : "it"}.</div>`;
    if (usesBedrockOidc(s)) {
      h += `<div class="callout info"><span class="h">No static inference secret</span>The workflow requests a GitHub OIDC token, assumes <code>${esc(String(s.awsRoleArn || "").trim())}</code> in <code>${esc(String(s.awsRegion || "").trim())}</code>, and lets STAR generate a short-lived Bedrock token. Do not add <code>INFERENCE_TOKEN</code> or <code>OPENAI_API_KEY</code>.</div>`;
    }
    if ((s.brightHostname || "").trim()) {
      h += `<div class="callout info"><span class="h">Custom Bright cluster</span><code>BRIGHT_HOSTNAME</code> (<code>${esc(s.brightHostname.trim())}</code>) is written into the workflow, pointing STAR at your cluster instead of the default <code>app.brightsec.com</code>. Leave the field blank to use the default.</div>`;
    }
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
  // Credential validation (pure helpers)
  //
  // These build the request specs and interpret the responses; the actual
  // fetch()/DOM wiring lives in index.html. Everything runs in the user's
  // browser and talks straight to the chosen endpoint — nothing is stored or
  // proxied. CORS reality (verified): OpenAI and Anthropic (with its
  // browser-access header) allow direct browser calls; other OpenAI-compatible
  // endpoints work when they send CORS headers. The Bright API does not expose
  // responses to a third-party origin, so the Bright check degrades to a
  // copy-paste curl command.
  // -------------------------------------------------------------------------

  const BRIGHT_DEFAULT_HOST = "app.brightsec.com";

  function brightHost(s) {
    return (s.brightHostname || "").trim() || BRIGHT_DEFAULT_HOST;
  }

  /**
   * Read-only inference probe: list the models the endpoint serves. No
   * generation, so it costs no tokens and is independent of per-model
   * generation params (e.g. gpt-5.x rejects `max_tokens` and wants
   * `max_completion_tokens`). Confirms the endpoint, the token, and — via
   * interpretModelsResponse — whether the configured model is available.
   */
  function inferenceCheckPlan(s, token) {
    const base = (effectiveInferenceUrl(s) || "").trim().replace(/\/+$/, "");
    const model = effectiveAiModel(s).split(",")[0].trim();
    if (usesBedrockOidc(s)) {
      return {
        kind: "aws-oidc",
        model,
        method: null,
        url: base,
        headers: {},
      };
    }
    let host = "";
    try { host = new URL(base).host.toLowerCase(); } catch (e) { host = ""; }
    const isAnthropic = s.provider === "anthropic" || /(^|\.)anthropic\.com$/.test(host);

    if (isAnthropic) {
      return {
        kind: "anthropic",
        model,
        method: "GET",
        url: base + "/models",
        headers: {
          "x-api-key": token,
          "anthropic-version": "2023-06-01",
          // Required for direct browser calls (Anthropic gates CORS behind it).
          "anthropic-dangerous-direct-browser-access": "true",
        },
      };
    }
    // OpenAI-compatible (OpenAI, Azure OpenAI/Foundry, Ollama, custom gateways).
    return {
      kind: "openai",
      model,
      method: "GET",
      url: base + "/models",
      headers: { "authorization": `Bearer ${token}` },
    };
  }

  /** True if `model` matches an id in the returned list (exact or version-suffixed). */
  function modelInList(ids, model) {
    if (!model) return false;
    return ids.some((id) => id === model || id.startsWith(model + "-") || model.startsWith(id + "-"));
  }

  /**
   * Interpret a GET /models response. `body` is the parsed JSON (or null);
   * OpenAI/Anthropic both return `{ data: [{ id }] }`.
   */
  function interpretModelsResponse(status, body, model) {
    if (status === 401 || status === 403) return { ok: false, level: "err", msg: `Auth rejected (HTTP ${status}) — check INFERENCE_TOKEN.` };
    if (status === 404 || status === 405) return { ok: false, level: "warn", msg: `HTTP ${status} — this endpoint doesn't expose a model list to the browser; couldn't verify the model here.` };
    if (status === 429) return { ok: true, level: "warn", msg: "HTTP 429 — reachable and authorized, but rate-limited right now." };
    if (status < 200 || status >= 300) return { ok: false, level: "warn", msg: `HTTP ${status} from the endpoint.` };

    const ids = Array.isArray(body && body.data) ? body.data.map((m) => m && m.id).filter(Boolean) : [];
    if (!ids.length) return { ok: true, level: "ok", msg: `Reachable and authorized${model ? ` (no model list returned to check "${model}" against)` : ""}.` };
    if (!model) return { ok: true, level: "ok", msg: `Reachable and authorized — ${ids.length} models available.` };
    if (modelInList(ids, model)) return { ok: true, level: "ok", msg: `Reachable, authorized, and model "${model}" is available.` };
    return { ok: false, level: "warn", msg: `Authorized, but "${model}" isn't among the ${ids.length} available models — check AI_MODEL.` };
  }

  /** A lightweight authenticated Bright endpoint used to prove token + host. */
  function brightCheckUrl(s) {
    return `https://${brightHost(s)}/api/v1/projects?limit=1`;
  }

  /**
   * Copy-paste curl for validating a Bright token from a terminal. The Bright
   * API can't be checked from the browser (its CORS policy blocks third-party
   * origins and the Authorization header), so the UI shows this command
   * instead. Uses the $BRIGHT_TOKEN env var rather than inlining the secret.
   */
  function brightCurl(s) {
    return [
      `export BRIGHT_TOKEN=...   # your Bright API token`,
      `curl -sS -o /dev/null -w "%{http_code}\\n" \\`,
      `  -H "Authorization: Api-Key $BRIGHT_TOKEN" \\`,
      `  "${brightCheckUrl(s)}"`,
    ].join("\n");
  }

  // -------------------------------------------------------------------------
  // Lightweight syntax highlight
  // -------------------------------------------------------------------------
  function keyHighlight(str) {
    let out = str.replace(/^(\s*(?:-\s*)?)([A-Za-z0-9_.\-]+)(:)(\s|$)/, (m, a, k, c, e) => `${a}<span class="k">${k}</span>${c}${e}`);
    out = out.replace(/(&quot;[^&]*?&quot;|&#39;[^&]*?&#39;)/g, '<span class="s">$1</span>');
    return out;
  }
  // -------------------------------------------------------------------------
  // Architecture diagram
  //
  // A pure state -> inline SVG renderer. No external assets and no layout
  // engine: the node set is small and fixed, so positions are hand-placed on a
  // grid and only visibility, labels and edges vary with the selection.
  //
  // The diagram exists to answer one question the YAML cannot: what crosses the
  // boundary of your CI runner. Everything inside the dashed box stays on your
  // infrastructure. Getting an edge direction wrong here would misinform, so the
  // directions are asserted in generator.test.js.
  //
  // Reference: https://docs.brightsec.com/docs/on-premises-repeater-local-agent
  //   "The Repeater is using WebSocket and HTTPS (443) ... without having to
  //    allowlist the Bright IP address in your firewall for incoming traffic"
  //   "all requests are sent from the Bright cloud through a Repeater to the
  //    local target"
  // -------------------------------------------------------------------------

  const DIAGRAM_W = 900;
  const DIAGRAM_H = 400;

  /** Short label for the node representing the LLM endpoint. */
  function providerLabel(s) {
    const p = PROVIDERS[s.provider];
    if (!p) return "LLM endpoint";
    if (s.provider === "custom") return "Your LLM gateway";
    return p.t.replace(" / Foundry", "").replace(" (self-hosted)", "");
  }

  /**
   * Builds the node/edge model for the current state. Returned separately from
   * the SVG so tests can assert on structure rather than parsing markup.
   */
  function diagramModel(s) {
    const P = PLATFORMS[s.platform];
    const selfHostedLlm = s.provider === "ollama";
    const validation = s.runMode === "validation";
    const harness = s.runMode === "function";
    const trig = activeTriggers(s);

    // Abbreviated so the text fits the node box; the summary line above the
    // diagram carries the full wording.
    const TRIG_SHORT = { pr: P.prWord === "Merge request" ? "MR" : "PR", push: "push",
      schedule: "nightly", manual: "manual", steering: "comment" };
    const trigShort = (trig.length ? trig : ["manual"]).map((t) => TRIG_SHORT[t] || t);
    const trigLine1 = trigShort.slice(0, 2).join(" · ");
    const trigLine2 = trigShort.slice(2).join(" · ");

    const nodes = [
      // --- inside the runner boundary
      { id: "trigger", zone: "in", x: 34, y: 36, w: 150, h: 56, kind: "trigger",
        t: "Trigger", d: trigLine1, d2: trigLine2 },
      { id: "ci", zone: "in", x: 34, y: 116, w: 150, h: 52, kind: "ci",
        t: P.name, d: "runner" },
      { id: "repo", zone: "in", x: 34, y: 200, w: 150, h: 52, kind: "repo",
        t: "Repo checkout", d: s.scope === "full" ? "full repo" : (s.scope === "changed" ? "changed files" : "diff or full") },
      { id: "agent", zone: "in", x: 236, y: 116, w: 166, h: 52, kind: "agent",
        t: "Bright Agent", d: "build · discover · fix", d2: "AI-driven" },
      { id: "target", zone: "in", x: 236, y: 200, w: 166, h: 52, kind: "app",
        t: harness ? "Function harness" : "Target app", d: harness ? "wrapped functions" : "Docker Compose" },

      // --- outside
      { id: "cloud", zone: "out", x: 610, y: 184, w: 190, h: 66, kind: "cloud",
        // brightHost(s) resolves BRIGHT_HOSTNAME, so a custom cluster (EU,
        // dedicated) is shown here rather than the default. The engine is always
        // outside the runner, so its zone never changes.
        t: "Bright DAST engine", d: "attacks · findings · retest", d2: brightHost(s) },
    ];

    // Validation mode has no fix loop, so nothing is written back and the SCM
    // node would sit unconnected. Omit it rather than imply a link.
    if (!validation) {
      nodes.push({ id: "scm", zone: "out", x: 610, y: 296, w: 190, h: 56, kind: "scm",
        t: P.name.replace(" Actions", "").replace(" CI/CD", "").replace(" Pipelines", "")
             .replace("CircleCI", "Your SCM").replace("Jenkins", "Your SCM"),
        d: "branch · PR · status" });
    }

    // The LLM node sits inside the boundary when self-hosted — the visual point
    // of the whole diagram for regulated environments.
    nodes.push(selfHostedLlm
      ? { id: "llm", zone: "in", x: 34, y: 284, w: 150, h: 52, kind: "llm",
          t: providerLabel(s), d: "on your network" }
      : { id: "llm", zone: "out", x: 610, y: 78, w: 190, h: 56, kind: "llm",
          t: providerLabel(s), d: "inference API" });

    if (validation) {
      // Placed above the agent rather than in the lower-left slot, which the
      // self-hosted LLM node occupies when provider=ollama.
      nodes.push({ id: "sarif", zone: "in", x: 236, y: 40, w: 166, h: 52, kind: "sarif",
        t: "SARIF findings", d: s.sarifTool === "codeql" && PLATFORMS[s.platform].codeql ? "from CodeQL" : "from your SAST" });
    }

    // Internal orchestration edges are unlabelled: the legend colour already
    // says what they are, and labels there crowd the boundary box. Only edges
    // whose detail is not obvious from position carry text.
    //
    // Note on the scan path: the agent spawns a local scan proxy (the Bright
    // Repeater) which opens the outbound connection and drives test traffic at
    // the target. The proxy is an implementation detail of the agent, so it is
    // folded into the agent node here — what matters is that the outbound
    // connection is initiated from inside your runner, and that test traffic
    // reaches the app locally and never traverses the internet.
    const edges = [
      { from: "trigger", to: "ci", kind: "control" },
      { from: "ci", to: "agent", kind: "control" },
      { from: "repo", to: "agent", kind: "data" },
      { from: "agent", to: "target", kind: "attack",
        label: "Bright test traffic" },
      { from: "agent", to: "cloud", kind: "tunnel", crosses: true, lane: 500,
        label: "outbound only · findings" },
      { from: "agent", to: "llm", kind: "llm", crosses: !selfHostedLlm, lane: 578,
        label: selfHostedLlm ? "inference" : "code · analysis" },
    ];

    if (validation) edges.push({ from: "sarif", to: "agent", kind: "data", label: "to confirm" });
    // No fix loop in validation mode, so nothing is written back.
    if (!validation) {
      edges.push({ from: "agent", to: "scm", kind: "write", crosses: true, lane: 452,
        label: needsRepoToken(s) ? "REPO_ACCESS_TOKEN" : (s.platform === "github" ? "GITHUB_TOKEN" : "System.AccessToken") });
    }

    return { nodes, edges, selfHostedLlm, validation, harness };
  }

  /** Node glyphs, drawn inline. No third-party icon requests. */
  const GLYPHS = {
    trigger: '<path d="M6 1 1 8h4l-1 6 6-8H6l1-5Z"/>',
    ci:      '<path d="M1 3.5A2.5 2.5 0 0 1 3.5 1h9A2.5 2.5 0 0 1 15 3.5v9A2.5 2.5 0 0 1 12.5 15h-9A2.5 2.5 0 0 1 1 12.5v-9Zm3 3 3 2.5-3 2.5M8.5 11.5h4"/>',
    repo:    '<path d="M3 1.5h7.5L13 4v10.5H3V1.5Zm7 0V4h3M5.5 7h5M5.5 10h5"/>',
    agent:   '<path d="M8 1v2M4.5 3.5h7A1.5 1.5 0 0 1 13 5v5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 10V5a1.5 1.5 0 0 1 1.5-1.5ZM6 6.5v1.5M10 6.5v1.5M2 13.5h12"/>',
    app:     '<path d="M2 5.5h12v8H2v-8Zm0 0L4 2h8l2 3.5M5.5 9h5"/>',
    repeater:'<path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM3.5 3a7 7 0 0 0 0 10M12.5 3a7 7 0 0 1 0 10"/>',
    cloud:   '<path d="M4.5 12.5h7a3 3 0 0 0 .3-6A4 4 0 0 0 4 5.6 2.9 2.9 0 0 0 4.5 12.5Z"/>',
    llm:     '<path d="M8 1.5 14 5v6l-6 3.5L2 11V5l6-3.5Zm0 0v13M2 5l6 3.5L14 5"/>',
    scm:     '<path d="M4.5 2.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm0 4v7M11.5 9.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm0 0v-3a2 2 0 0 0-2-2h-3"/>',
    sarif:   '<path d="M8 1.5 14.5 13H1.5L8 1.5Zm0 4v4m0 1.8v.2"/>',
  };

  /** Centre-right / centre-left anchor points for orthogonal routing. */
  function anchors(n) {
    return {
      l: { x: n.x, y: n.y + n.h / 2 },
      r: { x: n.x + n.w, y: n.y + n.h / 2 },
      t: { x: n.x + n.w / 2, y: n.y },
      b: { x: n.x + n.w / 2, y: n.y + n.h },
      cx: n.x + n.w / 2,
      cy: n.y + n.h / 2,
    };
  }

  /**
   * Orthogonal path between two nodes, plus the point at which to place the
   * edge label. `lane` gives an edge its own vertical corridor in the gap
   * between the runner boundary and the outside column, so crossing edges do
   * not stack their elbows on the same x.
   *
   * The label sits on the final horizontal run, just before the destination,
   * which keeps it clear of the source cluster where several edges share a y.
   */
  function edgeGeometry(a, b, lane, dy) {
    const A = anchors(a), B = anchors(b);
    // Shift the destination entry point so several edges into one node do not
    // land on the same pixel (and neither do their labels).
    if (dy) { B.l.y += dy; B.r.y += dy; }

    // Same column: straight vertical, label beside the midpoint.
    if (Math.abs(A.cx - B.cx) < 4) {
      const down = B.cy > A.cy;
      const from = down ? A.b : A.t, to = down ? B.t : B.b;
      return {
        d: `M${from.x} ${from.y} L${to.x} ${to.y}`,
        lx: from.x + 8, ly: (from.y + to.y) / 2, anchor: "start",
      };
    }

    const leftToRight = A.cx < B.cx;
    const from = leftToRight ? A.r : A.l;
    const to = leftToRight ? B.l : B.r;
    const midX = lane != null ? lane : (from.x + to.x) / 2;
    return {
      d: `M${from.x} ${from.y} H${midX} V${to.y} H${to.x}`,
      // Anchored against the destination edge: the label always sits in the
      // clear run just before the node, never across it.
      lx: leftToRight ? to.x - 10 : to.x + 10,
      ly: to.y - 7,
      anchor: leftToRight ? "end" : "start",
    };
  }

  function diagramCaption(s) {
    const m = diagramModel(s);
    const bits = [];
    bits.push("Your application and its source stay on the runner. The agent drives test traffic at the app locally — that traffic never leaves your network.");
    bits.push("Every connection outward is initiated from inside your runner over WSS/443, so no inbound firewall port is opened and no address needs allowlisting.");
    bits.push("Vulnerabilities are found, exploited and re-validated by Bright's DAST engine. "
      + "The model's job is the engineering around it: understanding the stack, building and booting the app, "
      + "discovering endpoints, and writing the fixes.");
    bits.push(m.selfHostedLlm
      ? `That inference runs on ${providerLabel(s)} inside your network, so no code or findings reach a third-party model.`
      : `Code and findings are sent to ${providerLabel(s)} for that reasoning.`);
    if (m.validation) bits.push("Validation mode confirms SARIF findings against the live app and writes nothing back.");
    return bits.join(" ");
  }

  /** Renders the architecture diagram for `s` as a standalone inline <svg>. */
  function generateDiagram(s) {
    const { nodes, edges } = diagramModel(s);
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    const out = [];

    out.push(`<svg class="arch" viewBox="0 0 ${DIAGRAM_W} ${DIAGRAM_H}" role="img" `
      + `aria-labelledby="arch-t arch-d" preserveAspectRatio="xMidYMid meet">`);
    out.push(`<title id="arch-t">Bright Agent architecture for ${esc(PLATFORMS[s.platform].name)}</title>`);
    out.push(`<desc id="arch-d">${esc(diagramCaption(s))}</desc>`);

    // Arrowheads, one per edge kind so colour follows the line.
    out.push("<defs>");
    ["control", "data", "api", "llm", "write", "tunnel", "attack"].forEach((k) => {
      out.push(`<marker id="ah-${k}" class="ah ah-${k}" viewBox="0 0 8 8" refX="7" refY="4" `
        + `markerWidth="7" markerHeight="7" orient="auto-start-reverse">`
        + `<path d="M0 0.5 L7.5 4 L0 7.5 z"/></marker>`);
    });
    out.push("</defs>");

    // Runner boundary.
    out.push(`<g class="zone">`
      + `<rect class="zone-box" x="16" y="16" width="410" height="340" rx="14"/>`
      + `<text class="zone-lbl" x="30" y="${DIAGRAM_H - 34}">Your CI runner — your infrastructure</text>`
      + `</g>`);
    out.push(`<g class="zone out">`
      + `<text class="zone-lbl" x="${DIAGRAM_W - 16}" y="${DIAGRAM_H - 34}" text-anchor="end">Outside your network</text>`
      + `</g>`);

    // Edges first so nodes paint over the line ends.
    edges.forEach((e) => {
      const a = byId[e.from], b = byId[e.to];
      if (!a || !b) return;
      const g = edgeGeometry(a, b, e.lane, e.dy);
      const cls = `edge e-${e.kind}${e.crosses ? " crosses" : ""}`;
      out.push(`<path class="${cls}" d="${g.d}" marker-end="url(#ah-${e.kind})"/>`);
      if (e.label) {
        out.push(`<text class="edge-lbl e-${e.kind}" x="${g.lx.toFixed(0)}" y="${g.ly.toFixed(0)}" `
          + `text-anchor="${g.anchor}">${esc(e.label)}</text>`);
      }
    });

    // Nodes.
    nodes.forEach((n) => {
      const g = GLYPHS[n.kind] || GLYPHS.agent;
      const shift = n.d2 ? 7 : 0;
      out.push(`<g class="node n-${n.kind} z-${n.zone}" transform="translate(${n.x} ${n.y})">`
        + `<rect class="node-box" width="${n.w}" height="${n.h}" rx="10"/>`
        + `<g class="glyph" transform="translate(12 ${(n.h - 16) / 2}) scale(1)">${g}</g>`
        + `<text class="node-t" x="38" y="${n.h / 2 - 3 - shift}">${esc(n.t)}</text>`
        + `<text class="node-d" x="38" y="${n.h / 2 + 12 - shift}">${esc(n.d)}</text>`
        + (n.d2 ? `<text class="node-d" x="38" y="${n.h / 2 + 25 - shift}">${esc(n.d2)}</text>` : "")
        + `</g>`);
    });

    out.push("</svg>");
    return out.join("");
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
    PLATFORMS, TRIGGER_META, RUN_MODES, SCOPES, PROVIDERS, BEDROCK_OIDC_MODEL_EXAMPLE, ARCHES, SETTINGS_LOC,
    defaultState,
    // helpers
    esc, dlBase, activeTriggers, workflowBehavior, usesPR, usesSteering,
    needsRepoToken, wantsAwsOidc, usesBedrockOidc, bedrockInferenceUrl,
    effectiveInferenceUrl, effectiveAiModel, bedrockModelIds, bedrockModelFamily, configurationErrors,
    scanKnobs, yamlScalar, shellQuote, groovyQuote, inferenceEnvLines,
    // generators
    generateGitHub, generateGitLab, generateAzure, generateBitbucket, generateCircle, generateJenkins,
    generateYaml, fileName, codeLang,
    // docs
    secretRows, summaryLine, repoAccessDoc, platformExtraDoc, steeringDoc, validationDoc, generateDoc,
    // credential validation
    brightHost, inferenceCheckPlan, modelInList, interpretModelsResponse, brightCheckUrl, brightCurl,
    // diagram
    diagramModel, generateDiagram, diagramCaption, providerLabel, edgeGeometry, DIAGRAM_W, DIAGRAM_H,
    // highlight
    highlight, keyHighlight,
  };
});
