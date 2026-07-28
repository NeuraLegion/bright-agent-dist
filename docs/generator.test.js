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
  assert.match(G.generateGitHub(st()), new RegExp(`AI_MODEL: ${G.PROVIDERS.openai.model}`));
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
