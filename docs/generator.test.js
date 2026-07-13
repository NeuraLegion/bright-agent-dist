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
test("scanKnobs is empty for the default (auto scope, full mode)", () => {
  assert.deepEqual(G.scanKnobs(st()), []);
});
test("scanKnobs includes SCAN_SCOPE only when not auto", () => {
  const keys = G.scanKnobs(st({ scope: "changed" })).map((x) => x.k);
  assert.deepEqual(keys, ["SCAN_SCOPE"]);
  assert.equal(G.scanKnobs(st({ scope: "changed" }))[0].v, "changed");
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
test("esc escapes HTML", () => {
  assert.equal(G.esc("<a & b>"), "&lt;a &amp; b&gt;");
});
test("inferenceSecretName / usesOpenAIKey", () => {
  assert.equal(G.inferenceSecretName(st()), "INFERENCE_TOKEN");
  assert.equal(G.inferenceSecretName(st({ provider: "openai", useOpenAIKey: true })), "OPENAI_API_KEY");
  assert.equal(G.usesOpenAIKey(st({ provider: "custom", useOpenAIKey: true })), false);
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
test("github: no steering → no steering plumbing", () => {
  const y = G.generateGitHub(st({ triggers: only("schedule", "manual") }));
  assert.ok(!/issue_comment/.test(y));
  assert.ok(!/BRIGHT_STEERING_/.test(y));
  assert.ok(!/Resolve steering PR/.test(y));
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
test("github: OPENAI_API_KEY variant", () => {
  const y = G.generateGitHub(st({ provider: "openai", useOpenAIKey: true }));
  assert.match(y, /OPENAI_API_KEY: \$\{\{ secrets\.OPENAI_API_KEY \}\}/);
  assert.ok(!/INFERENCE_TOKEN:/.test(y));
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
test("jenkins: openai key variant swaps the credential id", () => {
  assert.match(G.generateJenkins(st({ platform: "jenkins", provider: "openai", useOpenAIKey: true })), /credentials\('openai-api-key'\)/);
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
test("generateDoc includes the OPENAI_API_KEY row when selected", () => {
  assert.match(G.generateDoc(st({ provider: "openai", useOpenAIKey: true })), /OPENAI_API_KEY/);
});

// ---------------------------------------------------------------------------
// secretRows / summaryLine
// ---------------------------------------------------------------------------
test("secretRows always has BRIGHT_TOKEN + an inference secret + INFERENCE_URL", () => {
  const names = G.secretRows(st()).map((r) => r[0]);
  assert.ok(names.includes("BRIGHT_TOKEN"));
  assert.ok(names.includes("INFERENCE_TOKEN"));
  assert.ok(names.includes("INFERENCE_URL"));
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
