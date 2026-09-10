"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const G = require("./generator.js");

// Helper: a fresh state with overrides applied.
function st(overrides = {}) {
  const s = G.defaultState();
  const { triggers, ...rest } = overrides;
  Object.assign(s, rest);
  if (triggers) Object.assign(s.triggers, triggers);
  return s;
}
// Helper: enable exactly the given triggers, disable the rest.
function only(...names) {
  const t = { pr: false, push: false, schedule: false, manual: false, steering: false };
  names.forEach((n) => (t[n] = true));
  return t;
}

// ---------------------------------------------------------------------------
// Metadata & defaults
// ---------------------------------------------------------------------------
test("defaultState is GitHub, sensible defaults", () => {
  const s = G.defaultState();
  assert.equal(s.platform, "github");
  assert.equal(s.runMode, "full");
  assert.equal(s.scope, "auto");
  assert.equal(s.tokenMode, "builtin");
  assert.deepEqual(Object.keys(s.triggers).sort(), ["manual","pr","push","schedule","steering"]);
});

test("defaultState returns a fresh object each call", () => {
  const a = G.defaultState();
  a.platform = "gitlab";
  a.triggers.pr = false;
  const b = G.defaultState();
  assert.equal(b.platform, "github");
  assert.equal(b.triggers.pr, true);
});

test("every platform has a file and at least one trigger", () => {
  for (const [id, p] of Object.entries(G.PLATFORMS)) {
    assert.ok(p.file, `${id} has file`);
    assert.ok(p.triggers.length > 0, `${id} has triggers`);
  }
});

// ---------------------------------------------------------------------------
// dlBase
// ---------------------------------------------------------------------------
test("dlBase uses latest by default", () => {
  assert.match(G.dlBase(st()), /releases\/latest\/download$/);
});
test("dlBase pins a version tag", () => {
  assert.equal(G.dlBase(st({ version: "v0.1.1" })), "https://github.com/NeuraLegion/bright-agent-dist/releases/download/v0.1.1");
});
test("dlBase trims whitespace in the tag", () => {
  assert.match(G.dlBase(st({ version: "  v2.0.0  " })), /download\/v2\.0\.0$/);
});

// ---------------------------------------------------------------------------
// scanKnobs
// ---------------------------------------------------------------------------
test("scanKnobs emits the provider default AI_MODEL for the default state", () => {
  const knobs = G.scanKnobs(st());
  assert.deepEqual(knobs.map((x) => x.k), ["AI_MODEL"]);
  assert.equal(knobs[0].v, G.PROVIDERS.openai.model);
});
test("scanKnobs includes SCAN_SCOPE (plus the default AI_MODEL) when not auto", () => {
  const knobs = G.scanKnobs(st({ scope: "changed" }));
  const map = Object.fromEntries(knobs.map((x) => [x.k, x.v]));
  assert.equal(map.SCAN_SCOPE, "changed");
  assert.equal(map.AI_MODEL, G.PROVIDERS.openai.model);
});
test("scanKnobs uses the provider default model per provider, custom stays unset", () => {
  assert.equal(G.scanKnobs(st({ provider: "anthropic" })).find((x) => x.k === "AI_MODEL").v, G.PROVIDERS.anthropic.model);
  assert.ok(!G.scanKnobs(st({ provider: "custom" })).some((x) => x.k === "AI_MODEL"));
});
test("scanKnobs suppresses SCAN_SCOPE in validation mode", () => {
  const keys = G.scanKnobs(st({ scope: "changed", runMode: "validation" })).map((x) => x.k);
  assert.ok(!keys.includes("SCAN_SCOPE"));
  assert.ok(keys.includes("RUN_MODE"));
  assert.ok(keys.includes("SARIF_PATH"));
});
test("scanKnobs emits RUN_MODE when not full", () => {
  assert.equal(G.scanKnobs(st({ runMode: "function" })).find((x) => x.k === "RUN_MODE").v, "function");
});
test("scanKnobs emits RUN_MODE=fuzzing in fuzzing mode", () => {
  assert.equal(G.scanKnobs(st({ runMode: "fuzzing" })).find((x) => x.k === "RUN_MODE").v, "fuzzing");
});
test("scanKnobs suppresses SCAN_SCOPE in fuzzing mode (self-contained, no scan)", () => {
  const keys = G.scanKnobs(st({ scope: "changed", runMode: "fuzzing" })).map((x) => x.k);
  assert.ok(!keys.includes("SCAN_SCOPE"));
  assert.ok(keys.includes("RUN_MODE"));
  // Fuzzing has no SARIF: that stays validation-only.
  assert.ok(!keys.includes("SARIF_PATH"));
});
test("scanKnobs SARIF_PATH placeholder when empty", () => {
  const v = G.scanKnobs(st({ runMode: "validation" })).find((x) => x.k === "SARIF_PATH").v;
  assert.match(v, /REPLACE_WITH_PATH/);
});
test("scanKnobs passes AI_MODEL, service root, scm override, debug", () => {
  const knobs = G.scanKnobs(st({ aiModel: " gpt-x ", serviceRoot: " apps/api ", scmOverride: " gitlab ", debug: true }));
  const map = Object.fromEntries(knobs.map((x) => [x.k, x.v]));
  assert.equal(map.AI_MODEL, "gpt-x");
  assert.equal(map.BRIGHT_SERVICE_ROOT, "apps/api");
  assert.equal(map.BRIGHT_SCM_PLATFORM, "gitlab");
  assert.equal(map.BRIGHT_DEBUG, "1");
});
test("scanKnobs omits BRIGHT_HOSTNAME by default, emits (trimmed) when set", () => {
  assert.ok(!G.scanKnobs(st()).some((x) => x.k === "BRIGHT_HOSTNAME"));
  const v = G.scanKnobs(st({ brightHostname: "  eu.brightsec.com  " })).find((x) => x.k === "BRIGHT_HOSTNAME");
  assert.equal(v.v, "eu.brightsec.com");
});

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------
test("yamlScalar quotes digits and special chars", () => {
  assert.equal(G.yamlScalar("60"), '"60"');
  assert.equal(G.yamlScalar("a:b"), '"a:b"');
  assert.equal(G.yamlScalar("changed"), "changed");
});
test("shellQuote leaves safe values, quotes the rest", () => {
  assert.equal(G.shellQuote("apps/api"), "apps/api");
  assert.equal(G.shellQuote("a b"), "'a b'");
  assert.equal(G.shellQuote("it's"), "'it'\\''s'");
});
test("groovyQuote escapes quotes and backslashes into a single-quoted literal", () => {
  assert.equal(G.groovyQuote("plain"), "'plain'");
  assert.equal(G.groovyQuote("it's"), "'it\\'s'");
  assert.equal(G.groovyQuote("a\\b"), "'a\\\\b'");
});
test("circleci: INFERENCE_URL is YAML-quoted (URL has a ':')", () => {
  const y = G.generateCircle(st({ platform: "circleci", inferenceUrl: "https://api.openai.com/v1" }));
  assert.match(y, /INFERENCE_URL: "https:\/\/api\.openai\.com\/v1"/);
});
test("jenkins: user-editable values are escaped in the Groovy string", () => {
  const y = G.generateJenkins(st({ platform: "jenkins", inferenceUrl: "http://x/'; sh 'evil", timeoutMinutes: "6'0" }));
  assert.match(y, /INFERENCE_URL     = 'http:\/\/x\/\\'; sh \\'evil'/);
  assert.match(y, /BRIGHT_CI_TIMEOUT_MINUTES = '6\\'0'/);
});
test("esc escapes HTML", () => {
  assert.equal(G.esc("<a & b>"), "&lt;a &amp; b&gt;");
});
test("the inference secret is always INFERENCE_TOKEN", () => {
  for (const platform of Object.keys(G.PLATFORMS)) {
    const y = G.generateYaml(st({ platform, triggers: only(...G.PLATFORMS[platform].triggers) }));
    assert.ok(/INFERENCE_TOKEN|inference-token/.test(y), `${platform} references INFERENCE_TOKEN`);
    assert.ok(!/OPENAI_API_KEY|openai-api-key/.test(y), `${platform} has no OPENAI_API_KEY`);
  }
});
test("needsRepoToken: PAT on github, always on non-builtin platforms", () => {
  assert.equal(G.needsRepoToken(st()), false);
  assert.equal(G.needsRepoToken(st({ tokenMode: "pat" })), true);
  assert.equal(G.needsRepoToken(st({ platform: "gitlab" })), true);
});
test("activeTriggers respects platform support", () => {
  const s = st({ platform: "circleci", triggers: only("pr", "schedule") });
  // circleci doesn't support pr → filtered out
  assert.deepEqual(G.activeTriggers(s), ["schedule"]);
});

// ---------------------------------------------------------------------------
// generateYaml dispatch
// ---------------------------------------------------------------------------
test("generateYaml dispatches per platform with correct headers", () => {
  assert.match(G.generateGitHub(st()), /GitHub Actions/);
  assert.match(G.generateYaml(st({ platform: "gitlab" })), /GitLab CI\/CD/);
  assert.match(G.generateYaml(st({ platform: "azure" })), /Azure Pipelines/);
  assert.match(G.generateYaml(st({ platform: "bitbucket" })), /Bitbucket Pipelines/);
  assert.match(G.generateYaml(st({ platform: "circleci" })), /CircleCI/);
  assert.match(G.generateYaml(st({ platform: "jenkins" })), /Jenkins/);
});
test("no generated file contains a tab character", () => {
  for (const platform of Object.keys(G.PLATFORMS)) {
    const s = st({ platform, triggers: only(...G.PLATFORMS[platform].triggers) });
    assert.ok(!/\t/.test(G.generateYaml(s)), `${platform} has no tabs`);
  }
});
test("every platform hardcodes INFERENCE_URL rather than reading a CI variable", () => {
  for (const platform of Object.keys(G.PLATFORMS)) {
    const s = st({ platform, triggers: only(...G.PLATFORMS[platform].triggers), inferenceUrl: "https://api.openai.com/v1" });
    const y = G.generateYaml(s);
    assert.match(y, /api\.openai\.com\/v1/, `${platform} contains the literal URL`);
    assert.ok(!/vars\.INFERENCE_URL/.test(y), `${platform} has no vars.INFERENCE_URL`);
    assert.ok(!/\$\(INFERENCE_URL\)/.test(y), `${platform} has no $(INFERENCE_URL)`);
  }
});
test("fileName and codeLang", () => {
  assert.equal(G.fileName(st()), "bright-agent.yml");
  assert.equal(G.fileName(st({ platform: "jenkins" })), "Jenkinsfile");
  assert.equal(G.codeLang(st()), "yaml");
  assert.equal(G.codeLang(st({ platform: "jenkins" })), "groovy");
});

// ---------------------------------------------------------------------------
// GitHub specifics
// ---------------------------------------------------------------------------
test("github: on-block reflects selected triggers only", () => {
  const y = G.generateGitHub(st({ triggers: only("pr") }));
  assert.match(y, /pull_request:/);
  assert.ok(!/issue_comment:/.test(y));
  assert.ok(!/schedule:/.test(y));
  assert.ok(!/workflow_dispatch/.test(y));
});
test("github: steering adds resolve step, issue_comment trigger, and steering env", () => {
  const y = G.generateGitHub(st({ triggers: only("pr", "steering") }));
  assert.match(y, /issue_comment:/);
  assert.match(y, /Resolve steering PR \(refuse forks\)/);
  assert.match(y, /BRIGHT_STEERING_COMMENT:/);
  assert.match(y, /BRIGHT_STEERING_PR_BASE:/);
});
test("github: steering sets DIFF_BASE from the resolved PR base (diff-scoped steered run)", () => {
  const y = G.generateGitHub(st({ triggers: only("pr", "steering") }));
  assert.match(
    y,
    /DIFF_BASE: \$\{\{ steps\.steer\.outputs\.base_ref && format\('origin\/\{0\}', steps\.steer\.outputs\.base_ref\) \|\| '' \}\}/,
  );
});
test("github: no steering → no steering plumbing and no DIFF_BASE", () => {
  const y = G.generateGitHub(st({ triggers: only("schedule", "manual") }));
  assert.ok(!/issue_comment/.test(y));
  assert.ok(!/BRIGHT_STEERING_/.test(y));
  assert.ok(!/Resolve steering PR/.test(y));
  assert.ok(!/DIFF_BASE/.test(y));
});
test("github: checkout ref is a wrapped expression when pr/steering present", () => {
  const y = G.generateGitHub(st({ triggers: only("pr", "steering") }));
  assert.match(y, /ref: >-/);
  assert.match(y, /\$\{\{ \(github\.event_name == 'issue_comment'/);
  assert.match(y, /\|\| github\.ref \}\}/);
});
test("github: push/schedule only → no ref override, just fetch-depth", () => {
  const y = G.generateGitHub(st({ triggers: only("schedule") }));
  assert.ok(!/ref: >-/.test(y));
  assert.match(y, /fetch-depth: 0/);
});
test("github: builtin token uses GITHUB_TOKEN and warns about re-triggering", () => {
  const y = G.generateGitHub(st());
  assert.match(y, /REPO_ACCESS_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(y, /commits\/PRs made with GITHUB_TOKEN don't trigger/);
});
test("github: PAT token uses REPO_ACCESS_TOKEN secret and drops the note", () => {
  const y = G.generateGitHub(st({ tokenMode: "pat" }));
  assert.match(y, /REPO_ACCESS_TOKEN: \$\{\{ secrets\.REPO_ACCESS_TOKEN \}\}/);
  assert.ok(!/don't trigger your other workflows/.test(y));
});
test("github: uses INFERENCE_TOKEN secret (no OPENAI_API_KEY option)", () => {
  const y = G.generateGitHub(st({ provider: "openai" }));
  assert.match(y, /INFERENCE_TOKEN: \$\{\{ secrets\.INFERENCE_TOKEN \}\}/);
  assert.ok(!/OPENAI_API_KEY/.test(y));
});
test("github: INFERENCE_URL is hardcoded, not read from a CI variable", () => {
  const y = G.generateGitHub(st({ inferenceUrl: "https://api.openai.com/v1" }));
  assert.match(y, /INFERENCE_URL: "https:\/\/api\.openai\.com\/v1"/);
  assert.ok(!/vars\.INFERENCE_URL/.test(y));
});
test("github: AI_MODEL is baked in (provider default when the field is blank)", () => {
  assert.match(G.generateGitHub(st()), new RegExp(`AI_MODEL: "?${G.PROVIDERS.openai.model.replace(/,/g, ",")}"?`));
  assert.match(G.generateGitHub(st({ aiModel: "gpt-x" })), /AI_MODEL: gpt-x/);
});
test("github: validation + codeql injects CodeQL steps and SARIF_PATH", () => {
  const y = G.generateGitHub(st({ runMode: "validation", sarifTool: "codeql", sarifLanguage: "python", triggers: only("manual") }));
  assert.match(y, /codeql-action\/init@v3/);
  assert.match(y, /languages: python/);
  assert.match(y, /SARIF_PATH: \$\{\{ runner\.temp \}\}\/sarif\/python\.sarif/);
  assert.match(y, /security-events: read/);
});
test("github: validation with external SARIF uses the provided path", () => {
  const y = G.generateGitHub(st({ runMode: "validation", sarifTool: "other", sarifPath: "x/results.sarif", triggers: only("manual") }));
  assert.ok(!/codeql-action/.test(y));
  assert.match(y, /SARIF_PATH: x\/results\.sarif/);
});
test("github: default branch flows into push trigger", () => {
  const y = G.generateGitHub(st({ triggers: only("push"), defaultBranch: "trunk" }));
  assert.match(y, /branches: \["trunk"\]/);
});

// ---------------------------------------------------------------------------
// GitLab specifics
// ---------------------------------------------------------------------------
test("gitlab: rules map to pipeline sources per trigger", () => {
  const y = G.generateGitLab(st({ platform: "gitlab", triggers: only("pr", "schedule", "manual", "steering") }));
  assert.match(y, /merge_request_event/);
  assert.match(y, /"schedule"/);
  assert.match(y, /"web"/);
  assert.match(y, /"trigger"/);
});
test("gitlab: exports scan knobs in the script", () => {
  const y = G.generateGitLab(st({ platform: "gitlab", scope: "changed", debug: true }));
  assert.match(y, /export SCAN_SCOPE=changed/);
  assert.match(y, /export BRIGHT_DEBUG=1/);
  assert.match(y, /export BRIGHT_CI_TIMEOUT_MINUTES=/);
});
test("gitlab: MR pipelines guard against the bright-scan feedback loop", () => {
  const y = G.generateGitLab(st({ platform: "gitlab", triggers: only("pr") }));
  assert.match(y, /CI_MERGE_REQUEST_SOURCE_BRANCH_NAME =~ \/\^bright-scan-\//);
  assert.match(y, /CI_COMMIT_BRANCH =~ \/\^bright-scan-\//);
  assert.match(y, /when: never/);
  // The guard must precede the merge_request_event rule.
  assert.ok(y.indexOf("bright-scan-") < y.indexOf("merge_request_event"));
});
test("gitlab: no scan-branch guard when merge requests aren't a trigger", () => {
  const y = G.generateGitLab(st({ platform: "gitlab", triggers: only("schedule", "manual") }));
  assert.ok(!/bright-scan-/.test(y));
});
test("gitlab: header warns not to mark variables Protected", () => {
  const y = G.generateGitLab(st({ platform: "gitlab" }));
  assert.match(y, /Protected/);
  assert.match(y, /Missing required environment variable: BRIGHT_TOKEN/);
  assert.ok(!/mask & protect/i.test(y));
});
test("gitlab doc: warns about Protected variables breaking MR pipelines", () => {
  const d = G.generateDoc(st({ platform: "gitlab", triggers: only("pr") }));
  assert.match(d, /Protected/);
  assert.match(d, /Missing required environment variable: BRIGHT_TOKEN/);
});

// ---------------------------------------------------------------------------
// Azure specifics
// ---------------------------------------------------------------------------
test("azure: parameters block only when steering is enabled", () => {
  assert.ok(!/^parameters:/m.test(G.generateAzure(st({ platform: "azure", triggers: only("schedule") }))));
  assert.match(G.generateAzure(st({ platform: "azure", triggers: only("pr", "steering") })), /^parameters:/m);
});
test("azure: schedule block present only with schedule trigger", () => {
  assert.match(G.generateAzure(st({ platform: "azure", triggers: only("schedule") })), /^schedules:/m);
  assert.ok(!/^schedules:/m.test(G.generateAzure(st({ platform: "azure", triggers: only("manual") }))));
});
test("azure: builtin token uses System.AccessToken, PAT uses the var", () => {
  assert.match(G.generateAzure(st({ platform: "azure", tokenMode: "builtin" })), /REPO_ACCESS_TOKEN: \$\(System\.AccessToken\)/);
  assert.match(G.generateAzure(st({ platform: "azure", tokenMode: "pat" })), /REPO_ACCESS_TOKEN: \$\(REPO_ACCESS_TOKEN\)/);
});

// ---------------------------------------------------------------------------
// Bitbucket specifics
// ---------------------------------------------------------------------------
test("bitbucket: pull-requests block only with pr trigger", () => {
  assert.match(G.generateBitbucket(st({ platform: "bitbucket", triggers: only("pr") })), /pull-requests:/);
  assert.ok(!/pull-requests:/.test(G.generateBitbucket(st({ platform: "bitbucket", triggers: only("schedule") }))));
});
test("bitbucket: steering adds the bright-agent-steering custom pipeline", () => {
  assert.match(G.generateBitbucket(st({ platform: "bitbucket", triggers: only("pr", "steering") })), /bright-agent-steering:/);
  assert.ok(!/bright-agent-steering:/.test(G.generateBitbucket(st({ platform: "bitbucket", triggers: only("pr", "schedule") }))));
});

// ---------------------------------------------------------------------------
// CircleCI / Jenkins specifics
// ---------------------------------------------------------------------------
test("circleci: schedule → nightly workflow, else on-demand", () => {
  assert.match(G.generateCircle(st({ platform: "circleci", triggers: only("schedule") })), /nightly-dast:/);
  assert.match(G.generateCircle(st({ platform: "circleci", triggers: only("manual") })), /on-demand:/);
});
test("jenkins: cron trigger only with schedule; knobs become groovy env", () => {
  const withSched = G.generateJenkins(st({ platform: "jenkins", triggers: only("schedule"), scope: "full" }));
  assert.match(withSched, /triggers \{ cron\('H 3 \* \* \*'\) \}/);
  assert.match(withSched, /SCAN_SCOPE = 'full'/);
  assert.ok(!/triggers \{ cron/.test(G.generateJenkins(st({ platform: "jenkins", triggers: only("manual") }))));
});
test("jenkins: always uses the inference-token credential id", () => {
  const y = G.generateJenkins(st({ platform: "jenkins", provider: "openai" }));
  assert.match(y, /credentials\('inference-token'\)/);
  assert.ok(!/openai-api-key/.test(y));
});

// ---------------------------------------------------------------------------
// Verbose logging → log artifact upload (per platform)
// ---------------------------------------------------------------------------
test("debug off: no platform uploads a log artifact", () => {
  for (const platform of Object.keys(G.PLATFORMS)) {
    const y = G.generateYaml(st({ platform, triggers: only(...G.PLATFORMS[platform].triggers), debug: false }));
    assert.ok(!/bright-agent-logs/.test(y), `${platform} has no log artifact when debug is off`);
  }
});
test("debug on: every platform captures ~/.bright-agent/logs as a bright-agent-logs artifact", () => {
  for (const platform of Object.keys(G.PLATFORMS)) {
    const y = G.generateYaml(st({ platform, triggers: only(...G.PLATFORMS[platform].triggers), debug: true }));
    assert.match(y, /bright-agent-logs/, `${platform} names the log artifact`);
    assert.match(y, /~\/\.bright-agent\/logs/, `${platform} references the log dir`);
  }
});
test("github: debug uploads logs with upload-artifact and if: always()", () => {
  const y = G.generateGitHub(st({ debug: true }));
  assert.match(y, /uses: actions\/upload-artifact@v4/);
  assert.match(y, /name: bright-agent-logs/);
  assert.match(y, /path: ~\/\.bright-agent\/logs\//);
  assert.match(y, /if-no-files-found: ignore/);
});
test("gitlab: debug copies logs into CI_PROJECT_DIR and declares when: always artifacts", () => {
  const y = G.generateGitLab(st({ platform: "gitlab", debug: true }));
  assert.match(y, /after_script:/);
  assert.match(y, /\$CI_PROJECT_DIR\/bright-agent-logs/);
  assert.match(y, /artifacts:/);
  assert.match(y, /when: always/);
});
test("azure: debug stages logs and publishes a pipeline artifact, always()", () => {
  const y = G.generateAzure(st({ platform: "azure", debug: true }));
  assert.match(y, /PublishPipelineArtifact@1/);
  assert.match(y, /artifact: bright-agent-logs/);
  assert.match(y, /condition: always\(\)/);
});
test("bitbucket: debug uses after-script + step artifacts relative to the clone dir", () => {
  const y = G.generateBitbucket(st({ platform: "bitbucket", debug: true }));
  assert.match(y, /after-script:/);
  assert.match(y, /\$BITBUCKET_CLONE_DIR\/bright-agent-logs/);
  assert.match(y, /- bright-agent-logs\/\*\*/);
});
test("circleci: debug collects logs (when: always) and stores them", () => {
  const y = G.generateCircle(st({ platform: "circleci", debug: true }));
  assert.match(y, /when: always/);
  assert.match(y, /store_artifacts:/);
  assert.match(y, /destination: bright-agent-logs/);
});
test("jenkins: debug archives logs in a post-always block", () => {
  const y = G.generateJenkins(st({ platform: "jenkins", debug: true }));
  assert.match(y, /post \{/);
  assert.match(y, /always \{/);
  assert.match(y, /archiveArtifacts artifacts: 'bright-agent-logs\/\*\*', allowEmptyArchive: true/);
});
test("doc: debug adds the log-artifact callout", () => {
  assert.match(G.generateDoc(st({ debug: true })), /Logs are uploaded as an artifact/);
  assert.ok(!/Logs are uploaded as an artifact/.test(G.generateDoc(st({ debug: false }))));
});

// ---------------------------------------------------------------------------
// BRIGHT_HOSTNAME (optional cluster override, baked into the file)
// ---------------------------------------------------------------------------
test("no platform emits BRIGHT_HOSTNAME when the field is blank", () => {
  for (const platform of Object.keys(G.PLATFORMS)) {
    const y = G.generateYaml(st({ platform, triggers: only(...G.PLATFORMS[platform].triggers) }));
    assert.ok(!/BRIGHT_HOSTNAME/.test(y), `${platform} has no BRIGHT_HOSTNAME by default`);
  }
});
test("every platform bakes BRIGHT_HOSTNAME into the file when set", () => {
  for (const platform of Object.keys(G.PLATFORMS)) {
    const y = G.generateYaml(st({ platform, triggers: only(...G.PLATFORMS[platform].triggers), brightHostname: "eu.brightsec.com" }));
    assert.match(y, /BRIGHT_HOSTNAME/, `${platform} references BRIGHT_HOSTNAME`);
    assert.match(y, /eu\.brightsec\.com/, `${platform} contains the hostname value`);
  }
});
test("doc: custom-cluster callout only when BRIGHT_HOSTNAME is set", () => {
  assert.ok(!/Custom Bright cluster/.test(G.generateDoc(st())));
  assert.match(G.generateDoc(st({ brightHostname: "eu.brightsec.com" })), /Custom Bright cluster/);
});

// ---------------------------------------------------------------------------
// Credential validation helpers
// ---------------------------------------------------------------------------
test("inferenceCheckPlan: OpenAI-compatible is a GET /models read check with Bearer auth", () => {
  const plan = G.inferenceCheckPlan(st({ provider: "openai", inferenceUrl: "https://api.openai.com/v1/", aiModel: "gpt-5.4-mini" }), "sk-test");
  assert.equal(plan.kind, "openai");
  assert.equal(plan.method, "GET");
  assert.equal(plan.url, "https://api.openai.com/v1/models");
  assert.equal(plan.headers.authorization, "Bearer sk-test");
  assert.equal(plan.model, "gpt-5.4-mini");
  assert.ok(!plan.body, "no body — read-only, no generation params");
});
test("inferenceCheckPlan: anthropic uses GET /models with the browser-access header", () => {
  const plan = G.inferenceCheckPlan(st({ provider: "anthropic", inferenceUrl: "https://api.anthropic.com/v1" }), "k");
  assert.equal(plan.kind, "anthropic");
  assert.equal(plan.method, "GET");
  assert.equal(plan.url, "https://api.anthropic.com/v1/models");
  assert.equal(plan.model, "claude-sonnet-5"); // first of "claude-sonnet-5,claude-opus-4-8"
  assert.equal(plan.headers["x-api-key"], "k");
  assert.equal(plan.headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.ok(!plan.headers.authorization);
});
test("inferenceCheckPlan: anthropic is detected by host even for provider=custom", () => {
  const plan = G.inferenceCheckPlan(st({ provider: "custom", inferenceUrl: "https://api.anthropic.com/v1", aiModel: "claude-x" }), "k");
  assert.equal(plan.kind, "anthropic");
  assert.equal(plan.url, "https://api.anthropic.com/v1/models");
});
test("modelInList matches exact and version-suffixed ids, avoids false prefixes", () => {
  assert.ok(G.modelInList(["gpt-5.4-mini"], "gpt-5.4-mini"));
  assert.ok(G.modelInList(["gpt-5.4-mini-2026-03-17"], "gpt-5.4-mini")); // dated variant
  assert.ok(G.modelInList(["gpt-5.4-mini"], "gpt-5.4-mini-2026-03-17")); // config pins a dated id
  assert.ok(!G.modelInList(["gpt-4o"], "gpt-4")); // must not treat gpt-4o as gpt-4
  assert.ok(!G.modelInList([], "gpt-4o"));
});
test("interpretModelsResponse: auth failures and model presence", () => {
  assert.equal(G.interpretModelsResponse(401, null, "m").level, "err");
  assert.equal(G.interpretModelsResponse(403, null, "m").level, "err");
  assert.equal(G.interpretModelsResponse(404, null, "m").level, "warn");
  assert.equal(G.interpretModelsResponse(429, null, "m").ok, true);
  const ok = G.interpretModelsResponse(200, { data: [{ id: "gpt-5.4-mini" }] }, "gpt-5.4-mini");
  assert.equal(ok.ok, true); assert.equal(ok.level, "ok");
  const missing = G.interpretModelsResponse(200, { data: [{ id: "gpt-4o" }, { id: "gpt-4.1" }] }, "gpt-5.4-mini");
  assert.equal(missing.ok, false); assert.equal(missing.level, "warn");
  assert.match(missing.msg, /isn't among the 2 available models/);
  const noModel = G.interpretModelsResponse(200, { data: [{ id: "a" }, { id: "b" }] }, "");
  assert.match(noModel.msg, /2 models available/);
  const emptyList = G.interpretModelsResponse(200, { data: [] }, "m");
  assert.equal(emptyList.ok, true);
});
test("brightHost defaults to app.brightsec.com, honors override", () => {
  assert.equal(G.brightHost(st()), "app.brightsec.com");
  assert.equal(G.brightHost(st({ brightHostname: " eu.brightsec.com " })), "eu.brightsec.com");
});
test("brightCheckUrl targets an authenticated endpoint on the chosen host", () => {
  assert.equal(G.brightCheckUrl(st()), "https://app.brightsec.com/api/v1/projects?limit=1");
  assert.equal(G.brightCheckUrl(st({ brightHostname: "eu.brightsec.com" })), "https://eu.brightsec.com/api/v1/projects?limit=1");
});
test("brightCurl emits a runnable Api-Key curl for the chosen host", () => {
  const c = G.brightCurl(st({ brightHostname: "eu.brightsec.com" }));
  assert.match(c, /export BRIGHT_TOKEN=/);
  assert.match(c, /Authorization: Api-Key \$BRIGHT_TOKEN/);
  assert.match(c, /https:\/\/eu\.brightsec\.com\/api\/v1\/projects\?limit=1/);
});

// ---------------------------------------------------------------------------
// Highlight
// ---------------------------------------------------------------------------
test("highlight wraps comments and keys and escapes HTML", () => {
  const h = G.highlight('name: "x"\n# a comment', "yaml");
  assert.match(h, /<span class="k">name<\/span>/);
  assert.match(h, /<span class="s">/);
  assert.match(h, /<span class="c"># a comment<\/span>/);
});
test("highlight treats // as a comment only for groovy", () => {
  assert.match(G.highlight("// hi", "groovy"), /<span class="c">\/\/ hi<\/span>/);
  assert.ok(!/class="c"/.test(G.highlight("a: http://x", "yaml")));
});
test("highlight escapes angle brackets in code", () => {
  assert.match(G.highlight("ref: <thing>", "yaml"), /&lt;thing&gt;/);
});

// ---------------------------------------------------------------------------
// Instructions (generateDoc)
// ---------------------------------------------------------------------------
test("generateDoc includes summary, file path, and prerequisites", () => {
  const d = G.generateDoc(st());
  assert.match(d, /Summary/);
  assert.match(d, /\.github\/workflows\/bright-agent\.yml/);
  assert.match(d, /Runner prerequisites/);
});
test("generateDoc lists REPO_ACCESS_TOKEN only when needed", () => {
  assert.ok(!/REPO_ACCESS_TOKEN/.test(G.generateDoc(st())));                       // github builtin
  assert.match(G.generateDoc(st({ tokenMode: "pat" })), /REPO_ACCESS_TOKEN/);       // github pat
  assert.match(G.generateDoc(st({ platform: "gitlab" })), /REPO_ACCESS_TOKEN/);     // non-builtin
});
test("generateDoc shows the right settings location per platform", () => {
  assert.match(G.generateDoc(st()), /Secrets and variables/);
  assert.match(G.generateDoc(st({ platform: "gitlab" })), /CI\/CD → Variables/);
  assert.match(G.generateDoc(st({ platform: "jenkins" })), /Manage Jenkins → Credentials/);
});
test("generateDoc wires steering only for non-native platforms with steering on", () => {
  // github steering is native → no relay section
  assert.ok(!/webhook \+ a small relay/.test(G.generateDoc(st({ triggers: only("pr", "steering") }))));
  // gitlab steering → relay section
  assert.match(G.generateDoc(st({ platform: "gitlab", triggers: only("pr", "steering") })), /Wire \/bright-agent comment steering/);
});
test("generateDoc shows validation guidance in validation mode", () => {
  assert.match(G.generateDoc(st({ runMode: "validation", sarifTool: "codeql", triggers: only("manual") })), /SAST validation/);
});
test("generateDoc shows a self-contained fuzzing section in fuzzing mode", () => {
  const d = G.generateDoc(st({ runMode: "fuzzing", triggers: only("manual") }));
  assert.match(d, /Fuzzing/);
  assert.match(d, /evolutionary fuzzer/);
  assert.match(d, /no app startup/i);
  // No SARIF/validation guidance leaks into a fuzzing doc.
  assert.ok(!/SAST validation/.test(d));
});
test("generateDoc always lists INFERENCE_TOKEN and never OPENAI_API_KEY", () => {
  const d = G.generateDoc(st({ provider: "openai" }));
  assert.match(d, /INFERENCE_TOKEN/);
  assert.ok(!/OPENAI_API_KEY/.test(d));
});

// ---------------------------------------------------------------------------
// secretRows / summaryLine
// ---------------------------------------------------------------------------
test("secretRows has BRIGHT_TOKEN + an inference secret, but not INFERENCE_URL (baked into the file)", () => {
  const names = G.secretRows(st()).map((r) => r[0]);
  assert.ok(names.includes("BRIGHT_TOKEN"));
  assert.ok(names.includes("INFERENCE_TOKEN"));
  assert.ok(!names.includes("INFERENCE_URL"));
});
test("summaryLine mentions platform, trigger, mode", () => {
  const line = G.summaryLine(st({ triggers: only("pr") }));
  assert.match(line, /GitHub Actions/);
  assert.match(line, /pull request/);
  assert.match(line, /full/);
});
test("summaryLine omits scope wording in validation mode", () => {
  const line = G.summaryLine(st({ runMode: "validation", triggers: only("manual") }));
  assert.ok(!/scope/.test(line));
});
test("summaryLine omits scope wording in fuzzing mode", () => {
  const line = G.summaryLine(st({ runMode: "fuzzing", triggers: only("manual") }));
  assert.ok(!/scope/.test(line));
  assert.match(line, /fuzzing/);
});

// ---------------------------------------------------------------------------
// Architecture diagram
//
// The directions here are the point of these tests. A diagram that is subtly
// wrong is worse than none, because readers trust it over the YAML. The two
// facts that must never regress: test traffic is driven locally by the agent
// (the Bright cloud never reaches the app), and every outbound connection is
// initiated from inside the runner.
// ---------------------------------------------------------------------------

const edgeBetween = (m, from, to) => m.edges.find((e) => e.from === from && e.to === to);

test("diagram: the cloud never connects to the target app", () => {
  for (const provider of Object.keys(G.PROVIDERS)) {
    for (const runMode of Object.keys(G.RUN_MODES)) {
      const m = G.diagramModel({ ...G.defaultState(), provider, runMode });
      assert.equal(edgeBetween(m, "cloud", "target"), undefined,
        `cloud must not reach the target (${provider}/${runMode})`);
      assert.equal(m.edges.some((e) => e.to === "target" && e.from !== "agent"), false,
        "only the agent drives traffic at the target");
    }
  }
});

test("diagram: test traffic is a local edge from the agent to the app", () => {
  const m = G.diagramModel(G.defaultState());
  const e = edgeBetween(m, "agent", "target");
  assert.ok(e, "agent -> target edge exists");
  assert.equal(e.kind, "attack");
  assert.ok(!e.crosses, "test traffic must never cross the runner boundary");
  assert.match(e.label, /Bright test traffic/,
    "the traffic hitting the app is Bright's testing, not the agent's own");
});

test("diagram: every outbound edge starts inside the runner", () => {
  const m = G.diagramModel(G.defaultState());
  const inside = new Set(m.nodes.filter((n) => n.zone === "in").map((n) => n.id));
  m.edges.filter((e) => e.crosses).forEach((e) => {
    assert.ok(inside.has(e.from), `${e.from} -> ${e.to} must be initiated from inside`);
  });
});

test("diagram: the outbound edge to Bright is labelled outbound-only", () => {
  const e = edgeBetween(G.diagramModel(G.defaultState()), "agent", "cloud");
  assert.equal(e.kind, "tunnel");
  assert.ok(e.crosses);
  assert.match(e.label, /outbound only/);
});

test("diagram: a self-hosted model keeps inference inside the boundary", () => {
  const remote = G.diagramModel({ ...G.defaultState(), provider: "openai" });
  assert.equal(remote.nodes.find((n) => n.id === "llm").zone, "out");
  assert.equal(edgeBetween(remote, "agent", "llm").crosses, true);

  const local = G.diagramModel({ ...G.defaultState(), provider: "ollama" });
  assert.equal(local.nodes.find((n) => n.id === "llm").zone, "in");
  assert.equal(edgeBetween(local, "agent", "llm").crosses, false);
  assert.match(G.diagramCaption({ ...G.defaultState(), provider: "ollama" }),
    /no code or findings reach a third-party model/);
});

test("diagram: validation mode writes nothing back and has no floating nodes", () => {
  const m = G.diagramModel({ ...G.defaultState(), runMode: "validation" });
  assert.equal(m.edges.some((e) => e.kind === "write"), false, "no write-back in validation mode");
  assert.equal(m.nodes.some((n) => n.id === "scm"), false, "the SCM node is omitted, not left unconnected");
  assert.ok(m.nodes.some((n) => n.id === "sarif"), "SARIF input is shown");
  const touched = new Set(m.edges.flatMap((e) => [e.from, e.to]));
  m.nodes.forEach((n) => assert.ok(touched.has(n.id), `${n.id} must be connected`));
});

test("diagram: the write edge names the credential actually used", () => {
  assert.match(edgeBetween(G.diagramModel(G.defaultState()), "agent", "scm").label, /GITHUB_TOKEN/);
  assert.match(edgeBetween(G.diagramModel({ ...G.defaultState(), tokenMode: "pat" }), "agent", "scm").label,
    /REPO_ACCESS_TOKEN/);
  assert.match(edgeBetween(G.diagramModel({ ...G.defaultState(), platform: "gitlab" }), "agent", "scm").label,
    /REPO_ACCESS_TOKEN/);
});

test("diagram: the harness replaces the booted app", () => {
  const h = G.diagramModel({ ...G.defaultState(), runMode: "function" });
  const target = h.nodes.find((n) => n.id === "target");
  assert.match(target.t, /harness/i);
  assert.match(target.d, /wrapped functions/);
  assert.equal(edgeBetween(h, "agent", "target").kind, "attack",
    "Bright still drives the testing against the harness");
});

test("diagram: fuzzing is a self-contained flow with no scan and no write-back to a running app", () => {
  const m = G.diagramModel({ ...G.defaultState(), runMode: "fuzzing" });

  // No Bright cloud scan: the DAST engine node is omitted entirely.
  assert.equal(m.nodes.some((n) => n.id === "cloud"), false, "no Bright DAST engine node in fuzzing");
  // No SARIF input (that is validation-only).
  assert.equal(m.nodes.some((n) => n.id === "sarif"), false, "no SARIF node in fuzzing");
  // The functions are wrapped, and the fuzzer node drives them.
  const target = m.nodes.find((n) => n.id === "target");
  assert.match(target.t, /harness/i);
  assert.match(target.d, /wrapped functions/);
  assert.ok(m.nodes.some((n) => n.id === "fuzzer"), "the fuzzer node is shown");

  // No outbound scan tunnel to the cloud, and nothing crosses the boundary to a
  // running app: the fuzz loop is entirely inside the runner.
  assert.equal(edgeBetween(m, "agent", "cloud"), undefined, "no outbound tunnel to Bright in fuzzing");
  m.edges.forEach((e) => {
    if (e.to === "target" || e.from === "target" || e.to === "fuzzer" || e.from === "fuzzer") {
      assert.ok(!e.crosses, `${e.from}->${e.to} must stay inside the runner`);
    }
  });
  // The only crossing writes are code/analysis to the LLM and the PR write-back
  // to the SCM: never to a running app or a Bright scan.
  m.edges.filter((e) => e.crosses).forEach((e) => {
    assert.ok(["llm", "scm"].includes(e.to), `unexpected crossing edge to ${e.to}`);
  });

  // Every node is connected (no floating nodes) and no dangling edges.
  const ids = new Set(m.nodes.map((n) => n.id));
  const touched = new Set(m.edges.flatMap((e) => [e.from, e.to]));
  m.edges.forEach((e) => assert.ok(ids.has(e.from) && ids.has(e.to), `dangling ${e.from}->${e.to}`));
  m.nodes.forEach((n) => assert.ok(touched.has(n.id), `${n.id} must be connected`));

  // The model exposes the fuzzing flag next to validation/harness.
  assert.equal(m.fuzzing, true);
  assert.equal(m.validation, false);
});

test("diagram: no node overlaps or dangling edges in any combination", () => {
  const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  for (const platform of Object.keys(G.PLATFORMS)) {
    for (const runMode of Object.keys(G.RUN_MODES)) {
      for (const provider of Object.keys(G.PROVIDERS)) {
        const m = G.diagramModel({ ...G.defaultState(), platform, runMode, provider });
        const ids = new Set(m.nodes.map((n) => n.id));
        m.edges.forEach((e) => {
          assert.ok(ids.has(e.from) && ids.has(e.to), `dangling ${e.from}->${e.to}`);
        });
        for (let i = 0; i < m.nodes.length; i++) {
          for (let j = i + 1; j < m.nodes.length; j++) {
            assert.equal(hit(m.nodes[i], m.nodes[j]), false,
              `${m.nodes[i].id} overlaps ${m.nodes[j].id} (${platform}/${runMode}/${provider})`);
          }
        }
      }
    }
  }
});

test("diagram: renders standalone SVG with no external references", () => {
  const svg = G.generateDiagram(G.defaultState());
  assert.ok(svg.startsWith("<svg") && svg.endsWith("</svg>"));
  assert.equal(/<image|xlink:href|https?:\/\//.test(svg), false, "no external assets or URLs");
  assert.match(svg, /<title id="arch-t">/, "has an accessible title");
  assert.match(svg, /<desc id="arch-d">/, "has an accessible description");
  assert.match(svg, /role="img"/);
});

test("diagram: labels are anchored so they cannot run into the destination node", () => {
  const s = G.defaultState();
  const m = G.diagramModel(s);
  const byId = Object.fromEntries(m.nodes.map((n) => [n.id, n]));
  m.edges.filter((e) => e.label && e.crosses).forEach((e) => {
    const g = G.edgeGeometry(byId[e.from], byId[e.to], e.lane, e.dy);
    assert.equal(g.anchor, "end", `${e.from}->${e.to} label must end before the node`);
    assert.ok(g.lx < byId[e.to].x, "label anchor sits left of the destination box");
  });
});

test("diagram: caption states the local-traffic and outbound-only guarantees", () => {
  const cap = G.diagramCaption(G.defaultState());
  assert.match(cap, /never leaves your network/);
  assert.match(cap, /no inbound firewall port/);
});

test("diagram: attribution — Bright finds, the model engineers", () => {
  const m = G.diagramModel(G.defaultState());
  const agent = m.nodes.find((n) => n.id === "agent");
  const cloud = m.nodes.find((n) => n.id === "cloud");

  // The agent must not claim the scanning; that is the engine's job.
  assert.equal(/scan|attack|find/i.test(agent.d), false,
    `agent subtitle must not claim scanning: ${agent.d}`);
  assert.match(agent.d, /build|discover|fix/);

  // The engine must be named as the source of attacks and findings.
  assert.match(cloud.t, /DAST/);
  assert.match(cloud.d, /attacks/);
  assert.match(cloud.d, /findings/);

  // The model receives findings, it does not produce them.
  const llm = edgeBetween(m, "agent", "llm");
  assert.equal(/findings\b/.test(llm.label) && !/code/.test(llm.label), false);

  const cap = G.diagramCaption(G.defaultState());
  assert.match(cap, /found, exploited and re-validated by Bright/);
  assert.match(cap, /model's job is the engineering/);
});

test("diagram: the engine node shows the cluster the workflow actually targets", () => {
  const host = (s) => G.diagramModel(s).nodes.find((n) => n.id === "cloud").d2;

  assert.equal(host(G.defaultState()), "app.brightsec.com");
  assert.equal(host({ ...G.defaultState(), brightHostname: "eu.brightsec.com" }), "eu.brightsec.com");
  assert.equal(host({ ...G.defaultState(), brightHostname: "  dedicated.brightsec.com  " }),
    "dedicated.brightsec.com", "whitespace is trimmed, as brightHost does");

  // The label is a boundary claim, so it must agree with the workflow file.
  const s = { ...G.defaultState(), brightHostname: "eu.brightsec.com" };
  assert.match(G.generateYaml(s), /BRIGHT_HOSTNAME/);
  assert.match(G.generateDiagram(s), /eu\.brightsec\.com/);
  assert.equal(/app\.brightsec\.com/.test(G.generateDiagram(s)), false,
    "the default host must not appear once a cluster is set");

  // No self-hosted Bright option exists, so the engine is always outside.
  assert.equal(G.diagramModel(s).nodes.find((n) => n.id === "cloud").zone, "out");
});

// ---------------------------------------------------------------------------
// AWS Bedrock IAM via GitHub OIDC
// ---------------------------------------------------------------------------
function bedrockOidc(overrides = {}) {
  return st({
    platform: "github",
    provider: "bedrock",
    inferenceAuth: "aws-oidc",
    awsRoleArn: "arn:aws:iam::123456789012:role/BrightAgentRole",
    awsRegion: "us-east-1",
    aiModel: G.BEDROCK_OIDC_MODEL_EXAMPLE,
    ...overrides,
  });
}

function errorsFor(overrides) {
  return G.configurationErrors(bedrockOidc(overrides)).join(" ");
}

test("bedrock provider and OIDC state have safe defaults", () => {
  assert.equal(G.PROVIDERS.bedrock.url, "https://bedrock-mantle.us-east-1.api.aws/v1");
  assert.equal(G.PROVIDERS.bedrock.model, "");
  assert.equal(G.BEDROCK_OIDC_MODEL_EXAMPLE, "anthropic.claude-sonnet-4-20250514-v1:0");
  const s = G.defaultState();
  assert.equal(s.inferenceAuth, "token");
  assert.equal(s.awsRegion, "us-east-1");
  assert.equal(s.awsRoleArn, "");
});

test("bedrockInferenceUrl derives the exact AWS-owned endpoint from region", () => {
  assert.equal(G.bedrockInferenceUrl("eu-west-1"), "https://bedrock-mantle.eu-west-1.api.aws/v1");
  assert.equal(G.effectiveInferenceUrl(bedrockOidc({ awsRegion: "ap-southeast-2" })),
    "https://bedrock-mantle.ap-southeast-2.api.aws/v1");
});

test("configurationErrors validates OIDC platform, provider, commercial role, and region", () => {
  assert.deepEqual(G.configurationErrors(bedrockOidc()), []);
  assert.match(errorsFor({ platform: "gitlab" }), /only for GitHub Actions/);
  assert.match(errorsFor({ provider: "openai" }), /requires the AWS Bedrock provider/);
  assert.match(errorsFor({ awsRoleArn: "not-an-arn" }), /commercial-partition AWS IAM role ARN/);
  assert.match(errorsFor({ awsRoleArn: "arn:aws:iam::123456789012:role/" }), /commercial-partition AWS IAM role ARN/);
  assert.match(errorsFor({ awsRoleArn: "arn:aws:iam::123456789012:role/path/" }), /commercial-partition AWS IAM role ARN/);
  assert.match(errorsFor({ awsRoleArn: "arn:aws:iam::123456789012:role/path//name" }), /commercial-partition AWS IAM role ARN/);
  assert.match(errorsFor({ awsRegion: "xx-evil-1" }), /supported commercial AWS region/);
  assert.match(errorsFor({ awsRegion: "us-central-1" }), /supported commercial AWS region/);
  assert.match(errorsFor({ awsRegion: "eu-northwest-9" }), /supported commercial AWS region/);
  assert.match(errorsFor({ awsRegion: "ap-east-999" }), /supported commercial AWS region/);
  assert.match(errorsFor({
    awsRoleArn: "arn:aws-cn:iam::123456789012:role/BrightAgentRole",
    awsRegion: "cn-north-1",
  }), /commercial-partition AWS IAM role ARN/);
  assert.match(errorsFor({
    awsRoleArn: "arn:aws-us-gov:iam::123456789012:role/BrightAgentRole",
    awsRegion: "us-gov-west-1",
  }), /commercial-partition AWS IAM role ARN/);
});

test("configurationErrors accepts Claude with OIDC and rejects expressions, control characters, and malformed models", () => {
  assert.match(errorsFor({ awsRoleArn: "arn:aws:iam::123456789012:role/name\nINFERENCE_TOKEN: stolen" }), /commercial-partition AWS IAM role ARN/);
  assert.match(errorsFor({ awsRegion: "${{ github.token }}" }), /supported commercial AWS region/);
  assert.match(errorsFor({ aiModel: "${{ github.token }}" }), /comma-separated Bedrock/);
  assert.match(errorsFor({ aiModel: "openai.gpt-oss-120b-1:0\nINFERENCE_TOKEN: stolen" }), /comma-separated Bedrock/);
  assert.match(errorsFor({ aiModel: "" }), /Enter an AWS Bedrock model/);
  assert.deepEqual(G.configurationErrors(bedrockOidc({ aiModel: "anthropic.claude-sonnet-4-20250514-v1:0" })), []);
  assert.deepEqual(G.configurationErrors(bedrockOidc({ aiModel: "us.anthropic.claude-sonnet-4-20250514-v1:0" })), []);
  assert.match(errorsFor({ aiModel: "amazon.nova-pro-v1:0" }), /Use only OpenAI/);
  assert.match(errorsFor({ aiModel: "openai." }), /Use only OpenAI/);
  assert.match(errorsFor({ aiModel: "us.openai." }), /Use only OpenAI/);
  assert.match(errorsFor({ aiModel: "openai..gpt" }), /Use only OpenAI/);
  assert.match(errorsFor({ aiModel: "openai.gpt-oss-120b-1:0,anthropic.claude-sonnet-4-v1:0" }), /do not mix API families/);
});

test("github Bedrock OIDC YAML selects the Anthropic bearer route and omits static tokens", () => {
  const y = G.generateGitHub(bedrockOidc());
  assert.match(y, /id-token: write/);
  assert.match(y, /uses: aws-actions\/configure-aws-credentials@v4/);
  assert.match(y, /role-to-assume: "arn:aws:iam::123456789012:role\/BrightAgentRole"/);
  assert.match(y, /aws-region: us-east-1/);
  assert.match(y, /role-session-name: bright-agent-\$\{\{ github\.run_id \}\}/);
  assert.match(y, /INFERENCE_URL: "https:\/\/bedrock-mantle\.us-east-1\.api\.aws\/v1"/);
  assert.match(y, /INFERENCE_PROVIDER: anthropic/);
  assert.match(y, /AI_MODEL: "anthropic\.claude-sonnet-4-20250514-v1:0"/);
  assert.ok(!/AI_API_MODE/.test(y));
  assert.ok(!/INFERENCE_TOKEN/.test(y));
  assert.ok(!/OPENAI_API_KEY/.test(y));
});

test("github Bedrock OIDC YAML keeps OpenAI models on Chat Completions", () => {
  const y = G.generateGitHub(bedrockOidc({ aiModel: "openai.gpt-oss-120b-1:0" }));
  assert.match(y, /INFERENCE_PROVIDER: openai/);
  assert.match(y, /AI_API_MODE: chat/);
  assert.match(y, /AI_MODEL: "openai\.gpt-oss-120b-1:0"/);
  assert.ok(!/INFERENCE_TOKEN/.test(y));
  assert.ok(!/OPENAI_API_KEY/.test(y));
});

test("AWS credentials are configured after analysis and download, immediately before STAR", () => {
  const y = G.generateGitHub(bedrockOidc({
    runMode: "validation",
    sarifTool: "codeql",
    sarifLanguage: "javascript",
  }));
  const analyze = y.indexOf("Analyze (write SARIF to temp)");
  const download = y.indexOf("Download & verify Bright Agent");
  const credentials = y.indexOf("Configure AWS credentials through GitHub OIDC");
  const run = y.indexOf("Run Bright Agent");
  assert.ok(analyze < download);
  assert.ok(download < credentials);
  assert.ok(credentials < run);
  const nextNamedStep = y.indexOf("      - name:", credentials + 1);
  const runStep = y.lastIndexOf("      - name:", run);
  assert.equal(nextNamedStep, runStep);
  assert.equal((y.match(/if: \$\{\{ github\.event_name != 'workflow_dispatch' \|\| inputs\.preflight != true \}\}/g) || []).length, 3);
});

test("manual OIDC workflow exposes and maps a preflight input", () => {
  const y = G.generateGitHub(bedrockOidc());
  assert.match(y, /workflow_dispatch:\n    inputs:\n      preflight:/);
  assert.match(y, /type: boolean\n        default: false/);
  assert.match(y, /BRIGHT_PREFLIGHT_ONLY: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.preflight && '1' \|\| '0' \}\}/);

  const withoutManual = G.generateGitHub(bedrockOidc({
    triggers: { pr: true, push: false, schedule: false, manual: false, steering: false },
  }));
  assert.ok(!/workflow_dispatch/.test(withoutManual));
  assert.ok(!/BRIGHT_PREFLIGHT_ONLY/.test(withoutManual));
});

test("Bedrock API-key mode pins regional Anthropic profiles to the native client", () => {
  const s = st({
    provider: "bedrock",
    inferenceAuth: "token",
    inferenceUrl: G.PROVIDERS.bedrock.url,
    aiModel: "us.anthropic.claude-sonnet-4-20250514-v1:0",
  });
  assert.deepEqual(G.configurationErrors(s), []);
  assert.equal(G.bedrockModelFamily(s), "anthropic");
  const y = G.generateGitHub(s);
  assert.match(y, /INFERENCE_PROVIDER: anthropic/);
  assert.match(y, /INFERENCE_TOKEN: \$\{\{ secrets\.INFERENCE_TOKEN \}\}/);
  assert.ok(!/id-token: write/.test(y));
  assert.ok(!/configure-aws-credentials/.test(y));
  assert.ok(!/AI_API_MODE: chat/.test(y));
});

test("OIDC secret summary and setup docs explain trust, IAM permissions, API families, and preflight", () => {
  const s = bedrockOidc();
  assert.deepEqual(G.secretRows(s).map((r) => r[0]), ["BRIGHT_TOKEN"]);
  const d = G.generateDoc(s);
  assert.match(d, /No static inference secret/);
  assert.match(d, /sts\.amazonaws\.com/);
  assert.match(d, /bedrock-mantle:CallWithBearerToken/);
  assert.match(d, /bedrock-mantle:CreateInference/);
  assert.ok(!/bedrock-mantle:ListModels/.test(d), "Anthropic preflight does not list models");
  assert.match(d, /bedrock:InvokeModel/);
  assert.match(d, /no unrelated AWS permissions/i);
  assert.match(d, /native Anthropic Messages route/);
  assert.match(d, /OpenAI-compatible Chat Completions route/);
  assert.match(d, /enable the <code>preflight<\/code> input/);
  assert.ok(!/BRIGHT_PREFLIGHT_ONLY=1/.test(d));

  const openAiDoc = G.generateDoc(bedrockOidc({ aiModel: "openai.gpt-oss-120b-1:0" }));
  assert.match(openAiDoc, /bedrock-mantle:ListModels/);
});

test("OIDC browser validation returns a non-network AWS setup plan", () => {
  const plan = G.inferenceCheckPlan(bedrockOidc(), "");
  assert.equal(plan.kind, "aws-oidc");
  assert.equal(plan.method, null);
  assert.deepEqual(plan.headers, {});
  assert.equal(plan.url, "https://bedrock-mantle.us-east-1.api.aws/v1");
  assert.equal(plan.model, G.BEDROCK_OIDC_MODEL_EXAMPLE);
});

test("non-GitHub stale OIDC state falls back to token generation and is blocked by validation", () => {
  const s = bedrockOidc({ platform: "gitlab" });
  assert.equal(G.usesBedrockOidc(s), false);
  assert.ok(G.configurationErrors(s).length > 0);
  assert.match(G.generateGitLab(s), /INFERENCE_TOKEN/);
});
