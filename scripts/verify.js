#!/usr/bin/env node

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const ARTIFACTS_ROOT = path.join(ROOT, ".artifacts");
const DEFAULT_SMOKE_ROOT = path.join(ARTIFACTS_ROOT, "verify-smoke-default");
const CUSTOM_SMOKE_ROOT = path.join(ARTIFACTS_ROOT, "verify-smoke-custom");
const DEFAULT_PACKAGE_SOURCE = "github:ihorleleka/Local-Rag-Wiki";
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const DSH_BUNDLE_ROOT = path.join(ROOT, "packages", "dsh-local-rag-wiki");
const PACKAGE_METADATA = require(path.join(ROOT, "package.json"));
const {
  DEFAULT_IMAGE,
  COMPATIBILITY,
  SERVICE_COMPATIBILITY,
  classifyCompatibility,
} = require(path.join(
  ROOT,
  "templates",
  "root",
  ".agents",
  "wiki-manager-contract.js"
));

function fail(message) {
  console.error(`verify: ${message}`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
    ...options,
  });

  if (result.status !== 0) {
    process.stdout.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    if (result.error) {
      console.error(result.error.message);
    }
    fail(`${command} ${args.join(" ")} exited with ${result.status}`);
  }

  return result;
}

function expectFailure(command, args, expectedMessage, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
    ...options,
  });

  if (result.status === 0) {
    fail(`${command} ${args.join(" ")} succeeded unexpectedly`);
  }

  const output = `${result.stdout || ""}${result.stderr || ""}`;
  assert(
    output.includes(expectedMessage),
    `${command} ${args.join(" ")} failed without expected message: ${expectedMessage}`
  );
}

function runNpm(args) {
  const npmCache = path.join(ARTIFACTS_ROOT, ".npm-cache");
  fs.mkdirSync(npmCache, { recursive: true });
  const options = {
    env: {
      ...process.env,
      npm_config_cache: npmCache,
    },
  };

  if (process.env.npm_execpath) {
    return run(process.execPath, [process.env.npm_execpath, ...args], options);
  }
  return run(NPM, args, options);
}

function prepareScratch(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file) {
  const content = fs.readFileSync(file, "utf8");
  let stripped = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];
    if (lineComment) {
      if (char === "\n" || char === "\r") {
        lineComment = false;
        stripped += char;
      }
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (!inString && char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (!inString && char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    stripped += char;
    if (escaped) escaped = false;
    else if (char === "\\") escaped = true;
    else if (char === '"') inString = !inString;
  }
  return JSON.parse(stripped.replace(/,\s*([}\]])/g, "$1"));
}

function collectJsonStrings(value, output = []) {
  if (typeof value === "string") {
    output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectJsonStrings(item, output);
    return output;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectJsonStrings(item, output);
  }
  return output;
}

function collectTomlStrings(file) {
  const content = fs.readFileSync(file, "utf8");
  return [...content.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function assertReferencedJsTargetsExist(targetRoot, agentsDir) {
  const configFiles = [
    [".claude/settings.local.json", collectJsonStrings(readJson(path.join(targetRoot, ".claude", "settings.local.json")))],
    [".vscode/mcp.json", collectJsonStrings(readJson(path.join(targetRoot, ".vscode", "mcp.json")))],
    ["opencode.jsonc", collectJsonStrings(readJson(path.join(targetRoot, "opencode.jsonc")))],
    [".codex/config.toml", collectTomlStrings(path.join(targetRoot, ".codex", "config.toml"))],
  ];

  const expectedSegment = `${agentsDir.replace(/\\/g, "/")}/`;
  for (const [configFile, strings] of configFiles) {
    const jsTargets = strings.filter((value) => {
      const portable = value.replace(/\\/g, "/");
      // Accept both bare-relative (`<agentsDir>/...`) and workspace-prefixed
      // (`${workspaceFolder}/<agentsDir>/...`) forms.
      const segment = portable.startsWith(expectedSegment)
        ? portable
        : portable.replace(/^\$\{[^}]+\}\//, "");
      return segment.startsWith(expectedSegment) && portable.endsWith(".js");
    });
    assert(jsTargets.length > 0, `${configFile} does not reference a ${expectedSegment}*.js MCP runner`);

    for (const jsTarget of jsTargets) {
      // Strip any leading `${...}/` placeholder before resolving to disk.
      const resolvable = jsTarget.replace(/^\$\{[^}]+\}\//, "");
      const resolved = path.join(targetRoot, resolvable);
      assert(fs.existsSync(resolved), `${configFile} references missing file: ${jsTarget}`);
    }
  }
}

function assertDeliveredSurface(targetRoot, agentsDir) {
  const consumerAgentsPath = path.join(targetRoot, "AGENTS.md");
  const wikiSkillPath = path.join(targetRoot, agentsDir, "skills", "wiki", "SKILL.md");
  const integrationManifestPath = path.join(
    targetRoot,
    agentsDir,
    "integrations",
    "local-rag-wiki.integration.json"
  );
  const marketplacePath = path.join(targetRoot, agentsDir, "plugins", "marketplace.json");
  const dshMcpPath = path.join(targetRoot, ".dsh", "mcp.servers.yml");
  const dshMcpClientPath = path.join(targetRoot, ".dsh", ".dsh-mcp-client.js");
  const dshModulePath = path.join(targetRoot, ".dsh", "package.json");
  assert(fs.existsSync(consumerAgentsPath), "consumer AGENTS.md missing");
  assert(fs.existsSync(wikiSkillPath), "managed wiki skill missing");
  assert(fs.existsSync(integrationManifestPath), "integration manifest missing");
  assert(fs.existsSync(marketplacePath), "plugin marketplace metadata missing");
  assert(fs.existsSync(dshMcpPath), "DeepSeek Harness MCP configuration missing");
  assert(fs.existsSync(dshMcpClientPath), "agent-scoped DSH MCP client missing from .dsh");
  assert(!fs.existsSync(path.join(targetRoot, ".dsh-mcp-client.js")), "DSH MCP client leaked into repository root");
  assert(readJson(dshModulePath).type === "module", ".dsh MCP client is not in an ESM package scope");
  const dshMcp = fs.readFileSync(dshMcpPath, "utf8");
  assert(dshMcp.includes("wiki-manager:"), "DSH wiki-manager entry missing");
  assert(dshMcp.includes(`args: [\"${agentsDir}/run-wiki-manager.mcp.js\"]`), "DSH runner path is incorrect");

}

function assertDshBundleSource() {
  const source = fs.readFileSync(path.join(DSH_BUNDLE_ROOT, "index.mjs"), "utf8");
  assert(
    source.includes("|| agentOrSession?.session?.cwd") && source.includes("|| agentOrSession?.cwd"),
    "DSH bundle does not retain legacy workspace cwd compatibility"
  );
  assert(source.includes("loadWorkspaceWikiMcp(workspace)"), "DSH bundle does not load workspace mcp.servers.yml");
  assert(source.includes("agent.ctx.plugin(mcpClient"), "DSH bundle does not mount MCP through the agent scope");
  assert(source.includes("subprocess.resolveExecutable(discovered.server.command"), "DSH bundle does not resolve the configured Node executable through DSH");
  assert(!source.includes("process.execPath"), "DSH bundle would launch the runner through Electron process.execPath");
  assert(source.includes("ctx.on('agent/created', ({ agent }) => mountWikiMcp(agent))"), "DSH bundle does not mount on agent creation");
  assert(source.includes("ctx.on('agent/session-start', ({ agent }) => mountWikiMcp(agent))"), "DSH bundle does not retry mounting at session start");
  assert(source.includes("const existing = mcpReady.get(agent.id)"), "DSH bundle does not deduplicate lifecycle mounts");
  assert(source.includes("if (ready) await ready"), "DSH bundle does not await MCP discovery before model tool projection");
  assert(source.includes("tools.execute({"), "DSH recall does not dispatch through the native tool registry");
  assert(!source.includes("updateState"), "DSH lifecycle still uses local prompt-history state");
  assert(!fs.existsSync(path.join(DSH_BUNDLE_ROOT, "state.mjs")), "obsolete DSH prompt-history module still ships");
  run(process.execPath, ["--check", path.join(DSH_BUNDLE_ROOT, "index.mjs")]);
  run(process.execPath, ["--check", path.join(DSH_BUNDLE_ROOT, "workspace-mcp.mjs")]);
  run(process.execPath, ["--check", path.join(ROOT, "templates", "root", ".dsh", ".dsh-mcp-client.js")]);
}

function assertRepositoryUniqueResourceNames() {
  const runnerPath = path.join(
    ROOT,
    "templates",
    "root",
    ".agents",
    "run-wiki-manager.mcp.js"
  );
  const { deriveResourceNames } = require(runnerPath);
  const firstRoot = path.join(ARTIFACTS_ROOT, "identity-a", "same-repo");
  const secondRoot = path.join(ARTIFACTS_ROOT, "identity-b", "same-repo");
  fs.mkdirSync(firstRoot, { recursive: true });
  fs.mkdirSync(secondRoot, { recursive: true });

  const first = deriveResourceNames(firstRoot, {});
  const firstAgain = deriveResourceNames(firstRoot, {});
  const second = deriveResourceNames(secondRoot, {});

  assert(first.containerName === firstAgain.containerName, "container name is not stable for the same root");
  assert(first.kbVolume === firstAgain.kbVolume, "KB volume name is not stable for the same root");
  assert(first.containerName !== second.containerName, "same-basename roots share a container name");
  assert(first.kbVolume !== second.kbVolume, "same-basename roots share a KB volume name");
  assert(first.hfCacheVolume === "hf-cache", "default Hugging Face cache is not shared");
  assert(second.hfCacheVolume === "hf-cache", "Hugging Face cache differs between repositories");

  const overrides = deriveResourceNames(firstRoot, {
    KB_CONTAINER_NAME: "explicit-container",
    KB_VOLUME: "explicit-kb-volume",
    HF_CACHE_VOLUME: "explicit-hf-cache",
  });
  assert(overrides.containerName === "explicit-container", "KB_CONTAINER_NAME override was not preserved");
  assert(overrides.kbVolume === "explicit-kb-volume", "KB_VOLUME override was not preserved");
  assert(overrides.hfCacheVolume === "explicit-hf-cache", "HF_CACHE_VOLUME override was not preserved");
}

function assertInstall(targetRoot, agentsDir, expectedPackageSource = null) {
  const packageJson = readJson(path.join(ROOT, "package.json"));
  const marker = readJson(path.join(targetRoot, agentsDir, ".wiki-kit-install.json"));

  const expectedSource = expectedPackageSource || DEFAULT_PACKAGE_SOURCE;
  assert(marker.package === expectedSource, "install marker package source changed unexpectedly");
  assert(marker.packageName === packageJson.name, "install marker packageName does not match package.json");
  assert(marker.version === packageJson.version, "install marker version does not match package.json");
  assert(marker.agentsDir === agentsDir, "install marker agentsDir does not match install option");
  assert(marker.defaultImage === DEFAULT_IMAGE, "install marker does not record the pinned image");
  assert(Boolean(marker.containerName), "install marker does not record the repository container name");

  assertReferencedJsTargetsExist(targetRoot, agentsDir);
  assertDeliveredSurface(targetRoot, agentsDir);

  const codexConfig = fs.readFileSync(path.join(targetRoot, ".codex", "config.toml"), "utf8");
  assert(codexConfig.includes("startup_timeout_sec = 75.0"), "Codex startup timeout is missing");
  assert(codexConfig.includes("tool_timeout_sec = 120.0"), "Codex tool timeout is missing");
  const opencodeConfig = readJson(path.join(targetRoot, "opencode.jsonc"));
  assert(opencodeConfig.mcp["wiki-manager"].timeout === 75000, "OpenCode MCP timeout is missing");
}

function assertDshBundle() {
  const manifest = readJson(path.join(ROOT, "package.json"));
  assert(
    manifest.dsh?.bundle?.patch === "./packages/dsh-local-rag-wiki/cordis.patch.yml",
    "package.json does not expose the DSH bundle patch"
  );
  assert(manifest.main === "./packages/dsh-local-rag-wiki/index.mjs", "package.json does not declare the DSH entry artifact");
  assert(manifest.exports?.["."] === "./packages/dsh-local-rag-wiki/index.mjs", "package.json does not export the DSH entry artifact");
  assert(
    manifest.exports?.["./dsh"] === "./packages/dsh-local-rag-wiki/index.mjs",
    "package.json does not export the DSH lifecycle plugin"
  );
  assert(
    manifest.exports?.["./dsh-mcp-client"] === "./templates/root/.dsh/.dsh-mcp-client.js",
    "package.json does not export the scoped DSH MCP client"
  );
  assert(
    manifest.exports?.["./dsh-runner"] === "./packages/dsh-local-rag-wiki/workspace-runner.cjs",
    "package.json does not export the DSH workspace runner"
  );
  assert(
    manifest.files.includes("packages/dsh-local-rag-wiki/"),
    "published package would omit the DSH bundle files"
  );
  const recallCoordinator = fs.readFileSync(path.join(DSH_BUNDLE_ROOT, "recall.mjs"), "utf8");
  assert(recallCoordinator.includes("depth: 'abstract'"), "DSH recall coordinator does not request L0 abstracts");
  assert(recallCoordinator.includes("depth: 'packet'"), "DSH recall coordinator does not request L1 packets");
  assert(recallCoordinator.includes("inFlight"), "DSH recall coordinator lacks in-flight deduplication");
  assert(recallCoordinator.includes("PACKET_WINDOW_MS"), "DSH recall coordinator lacks an L1 packet budget");
  assert(!recallCoordinator.includes("spawn(") && !recallCoordinator.includes("process.execPath"), "DSH recall still launches a second MCP runner");
  const lifecyclePlugin = fs.readFileSync(path.join(DSH_BUNDLE_ROOT, "index.mjs"), "utf8");
  assert(lifecyclePlugin.includes("agent.ctx.plugin(mcpClient"), "DSH bundle does not mount MCP per agent workspace");
  assert(lifecyclePlugin.includes("loadWorkspaceWikiMcp(workspace)"), "DSH bundle does not gate MCP tools through workspace config");
  assert(lifecyclePlugin.includes("../../templates/root/.dsh/.dsh-mcp-client.js"), "DSH bundle does not use the delivered scoped MCP client");
  const patch = fs.readFileSync(path.join(DSH_BUNDLE_ROOT, "cordis.patch.yml"), "utf8");
  assert(patch.includes("name: '@ihorleleka/wiki-kit/dsh'"), "DSH bundle does not mount the lifecycle plugin");
  assert(!patch.includes("@deepseek-ai/dsh-mcp-client"), "DSH bundle must not mount MCP globally outside an agent workspace");
  const { findAgentsRoot } = require(path.join(DSH_BUNDLE_ROOT, "workspace-runner.cjs"));
  const root = path.join(ARTIFACTS_ROOT, "dsh-bundle-marker-test");
  prepareScratch(root);
  const customAgentsRoot = path.join(root, "custom-wiki-kit");
  fs.mkdirSync(customAgentsRoot, { recursive: true });
  fs.writeFileSync(path.join(customAgentsRoot, ".wiki-kit-install.json"), "{}\n", "utf8");
  assert(findAgentsRoot(root) === customAgentsRoot, "DSH runner did not discover custom wiki-kit installation");
}

function assertCompatibilityClassification() {
  const current = COMPATIBILITY.currentServiceVersion;
  const currentSchema = SERVICE_COMPATIBILITY[current].indexSchemaVersion;
  const currentTool = SERVICE_COMPATIBILITY[current].minimumMcpToolContractVersion;
  assert(
    classifyCompatibility({ serviceVersion: current, indexSchemaVersion: currentSchema, mcpToolContractVersion: currentTool }) === "current",
    "current image metadata was not classified as current"
  );

  // Find an older supported version to assert "outdated"
  const outdatedVersion = Object.keys(SERVICE_COMPATIBILITY)
    .filter(v => v !== current)
    .sort()
    .pop();
  if (outdatedVersion) {
    const outdatedSchema = SERVICE_COMPATIBILITY[outdatedVersion].indexSchemaVersion;
    const outdatedTool = SERVICE_COMPATIBILITY[outdatedVersion].minimumMcpToolContractVersion;
    assert(
      classifyCompatibility({ serviceVersion: outdatedVersion, indexSchemaVersion: outdatedSchema, mcpToolContractVersion: outdatedTool }) === "outdated",
      "previous image metadata was not classified as outdated"
    );
  }

  assert(
    classifyCompatibility({ serviceVersion: current, indexSchemaVersion: 0, mcpToolContractVersion: currentTool }) === "incompatible",
    "mismatched schema metadata was not classified as incompatible"
  );
  assert(
    classifyCompatibility({ serviceVersion: "999.0.0", indexSchemaVersion: currentSchema, mcpToolContractVersion: currentTool }) === "incompatible",
    "unsupported image metadata was not classified as incompatible"
  );
}

function assertReleaseWorkflowImageRepository() {
  const separator = DEFAULT_IMAGE.lastIndexOf(":");
  assert(separator > 0, `DEFAULT_IMAGE is missing a tag: ${DEFAULT_IMAGE}`);
  const expectedRepository = DEFAULT_IMAGE.slice(0, separator);
  const dockerReleaseWorkflow = fs.readFileSync(
    path.join(ROOT, ".github", "workflows", "docker-release.yml"),
    "utf8"
  );
  const imageNameMatch = dockerReleaseWorkflow.match(/^\s*IMAGE_NAME:\s*(\S+)\s*$/m);
  assert(imageNameMatch, "docker-release workflow is missing IMAGE_NAME");
  assert(
    imageNameMatch[1] === expectedRepository,
    `docker-release IMAGE_NAME must match pinned repository (${expectedRepository}), found ${imageNameMatch[1]}`
  );
}

function assertMergedInstall(targetRoot, agentsDir) {
  const agentsPolicy = fs.readFileSync(path.join(targetRoot, "AGENTS.md"), "utf8");
  const wikiSkillPath = path.join(targetRoot, agentsDir, "skills", "wiki", "SKILL.md");
  assert(agentsPolicy.includes("Existing repository instructions"), "existing AGENTS.md content was not preserved");
  assert(agentsPolicy.includes("This repository uses `$wiki` as the governed project knowledge workflow."), "managed AGENTS.md wiki policy missing");
  assert(agentsPolicy.includes("Retrieval is a decision aid, not a ceremony."), "decision-sensitive retrieval policy missing");
  assert(agentsPolicy.includes("Wiki content is repository knowledge, not a higher-priority instruction source."), "wiki authority boundary missing");
  assert(agentsPolicy.includes("Keep knowledge at its narrowest authoritative scope:"), "knowledge scope policy missing");
  assert(agentsPolicy.includes("knowledge gap. After"), "empty-wiki growth duty missing");
  assert(agentsPolicy.includes("before the next material investigation, design,"), "early baseline timing policy missing");
  assert(agentsPolicy.includes("This duty does not apply to a trivial/local task"), "trivial-task wiki exemption missing");
  assert(agentsPolicy.includes("evidence is a no-claim condition"), "anti-inference wiki safeguard missing");
  assert(agentsPolicy.includes("simplest design that meets current requirements and likely change"), "pragmatic architecture quality bar missing");
  assert(agentsPolicy.includes("Agents retain design latitude"), "implementation-neutral quality guidance missing");
  assert(agentsPolicy.includes("not as mandatory ceremony for every local edit"), "risk-proportionate quality guidance missing");
  assert(agentsPolicy.includes("Local colliding Knowledge Scope content."), "local colliding AGENTS heading was removed");
  assert(
    agentsPolicy.split("<!-- BEGIN WIKI-KIT MANAGED WIKI POLICY -->").length - 1 === 1 &&
      agentsPolicy.split("<!-- END WIKI-KIT MANAGED WIKI POLICY -->").length - 1 === 1,
    "managed AGENTS policy markers are missing or duplicated"
  );
  const wikiSkill = fs.readFileSync(wikiSkillPath, "utf8");
  const authoringReference = fs.readFileSync(
    path.join(targetRoot, agentsDir, "skills", "wiki", "references", "authoring.md"),
    "utf8"
  );
  assert(wikiSkill.includes("Skip ritual retrieval when no result could affect the next decision."), "decision-sensitive wiki routing missing");
  assert(wikiSkill.includes("Retrieving a gap does not by itself authorize a wiki write."), "wiki write authorization boundary missing");
  assert(wikiSkill.includes("On an explicit miss, continue with code inspection"), "explicit wiki gap handling missing");
  assert(wikiSkill.includes("A valid outcome is no wiki write."), "valid no-write outcome missing");
  assert(wikiSkill.includes("Apply the normal instruction hierarchy."), "wiki instruction hierarchy missing");
  assert(wikiSkill.includes("After a mutation, use the smallest useful"), "post-write verification missing");
  assert(wikiSkill.includes("before the next material decision"), "empty-wiki initialization timing missing");
  assert(wikiSkill.includes("do not initialize for trivial/local work"), "trivial-task initialization exemption missing");
  assert(wikiSkill.includes("whole baseline merely because coverage is incomplete"), "partial-evidence baseline guidance missing");
  assert(wikiSkill.includes("## Continuous Knowledge Loop"), "continuous knowledge loop missing");
  assert(authoringReference.includes("## Specificity And Generalization"), "specificity reference missing");
  assert(authoringReference.includes("smallest authoritative owner"), "canonical note ownership missing");
  assert(authoringReference.includes("## Change Artifacts And Durable Ownership"), "generic change-artifact lifecycle guidance missing");
  assert(authoringReference.includes("not evidence of coverage"), "initial-index coverage safeguard missing");
  assert(authoringReference.includes("## Empty-Wiki Baseline"), "empty-wiki baseline authoring guidance missing");
  assert(authoringReference.includes("no durable write-back is warranted"), "explicit archive write-back decision missing");

  const vscodeConfig = readJson(path.join(targetRoot, ".vscode", "mcp.json"));
  assert(vscodeConfig.servers["other-wiki-kit"], "existing VS Code MCP server was not preserved");
  assert(vscodeConfig.servers["wiki-manager"], "wiki-manager VS Code MCP server was not merged");
  assert(vscodeConfig.servers["wiki-manager"].type === "stdio", "VS Code MCP type was not refreshed");
  assert(
    vscodeConfig.servers["wiki-manager"].cwd === "${workspaceFolder}",
    "VS Code MCP working directory was not refreshed"
  );
  assert(
    vscodeConfig.servers["wiki-manager"].args[0] === "${workspaceFolder}/.agents/run-wiki-manager.mcp.js",
    "VS Code MCP runner path was not refreshed"
  );

  const claudeConfig = readJson(path.join(targetRoot, ".claude", "settings.local.json"));
  assert(claudeConfig.mcpServers["other-wiki-kit"], "existing Claude MCP server was not preserved");
  assert(claudeConfig.mcpServers["wiki-manager"], "wiki-manager Claude MCP server was not merged");
  assert(JSON.stringify(claudeConfig.hooks || {}).includes("node user-hook.js"), "unrelated Claude hook was not preserved");
  assert(JSON.stringify(claudeConfig.hooks || {}).includes("auto-capture.js"), "existing Claude hooks were unexpectedly removed");

  const opencodeConfig = readJson(path.join(targetRoot, "opencode.jsonc"));
  assert(opencodeConfig.mcp["other-wiki-kit"], "existing OpenCode MCP server was not preserved");
  assert(opencodeConfig.mcp["wiki-manager"], "wiki-manager OpenCode MCP server was not merged");
  assert(opencodeConfig.instructions.includes("OTHER.md"), "existing OpenCode instructions were not preserved");
  assert(opencodeConfig.instructions.includes("AGENTS.md"), "AGENTS.md instruction was not merged");
  const opencodeText = fs.readFileSync(path.join(targetRoot, "opencode.jsonc"), "utf8");
  assert(opencodeText.includes("// Existing wiki-kit config"), "OpenCode JSONC comment was not preserved");

  const vscodeMcpText = fs.readFileSync(path.join(targetRoot, ".vscode", "mcp.json"), "utf8");
  assert(vscodeMcpText.includes('"other-wiki-kit"'), "existing VS Code MCP server text was not preserved");
  const vscodeSettingsText = fs.readFileSync(path.join(targetRoot, ".vscode", "settings.json"), "utf8");
  const vscodeSettings = JSON.parse(vscodeSettingsText.replace(/\/\/[^\n]*/g, "").replace(/,\s*}/g, "}"));
  assert(vscodeSettings["editor.wordWrap"] === "on", "unrelated VS Code setting was overwritten");
  assert(vscodeSettingsText.includes("// User-owned setting"), "VS Code settings comment was not preserved");

  const codexConfig = fs.readFileSync(path.join(targetRoot, ".codex", "config.toml"), "utf8");
  assert(codexConfig.includes("[mcp_servers.other-wiki-kit]"), "existing Codex MCP server was not preserved");
  assert(codexConfig.includes("[mcp_servers.wiki-manager]"), "wiki-manager Codex MCP server was not merged");

  assert(fs.existsSync(path.join(targetRoot, agentsDir, "skills", "custom", "SKILL.md")), "custom skill was not preserved");
}

function assertLegacyAgentsPolicyMigrated(targetRoot) {
  const agentsPolicy = fs.readFileSync(path.join(targetRoot, "AGENTS.md"), "utf8");
  const signature = "This repository uses `$wiki` as the governed project knowledge workflow.";
  const occurrences = agentsPolicy.split(signature).length - 1;

  assert(agentsPolicy.includes("# Existing local instructions"), "local instructions before legacy policy were not preserved");
  assert(agentsPolicy.includes("# More local instructions"), "local instructions after legacy policy were not preserved");
  assert(agentsPolicy.includes("Local legacy collision."), "colliding local legacy heading was removed");
  assert(occurrences === 1, "legacy unmarked wiki policy was duplicated instead of migrated");
}

function main() {
  assert(
    PACKAGE_METADATA.version === COMPATIBILITY.wikiKitVersion,
    "package.json version must match the shared wiki-kit/service release version"
  );
  assertDshBundle();
  assertDshBundleSource();
  assertCompatibilityClassification();
  assertReleaseWorkflowImageRepository();
  assertRepositoryUniqueResourceNames();
  prepareScratch(DEFAULT_SMOKE_ROOT);
  run(process.execPath, [path.join(ROOT, "bin", "wiki-kit.js"), "install", DEFAULT_SMOKE_ROOT, "--force"]);
  assertInstall(DEFAULT_SMOKE_ROOT, ".agents");
  const defaultStatus = run(process.execPath, [path.join(ROOT, "bin", "wiki-kit.js"), "status", DEFAULT_SMOKE_ROOT]);
  assert(defaultStatus.stdout.includes("Agents dir: .agents"), "status did not report default agents dir");
  assert(defaultStatus.stdout.includes("Install marker: present"), "status did not report install marker");
  assert(defaultStatus.stdout.includes(`Configured image: ${DEFAULT_IMAGE}`), "status did not report pinned image");
  assert(defaultStatus.stdout.includes("Image configuration: current"), "status did not report current image configuration");
  const fakeDockerDir = path.join(ARTIFACTS_ROOT, "fake-docker-cli");
  fs.mkdirSync(fakeDockerDir, { recursive: true });
  const fakeDockerPath = path.join(fakeDockerDir, "fake-docker.js");
  fs.writeFileSync(
    fakeDockerPath,
    'if (process.argv[2] === "--version") { console.log("Docker version fake"); process.exit(0); } process.exit(1);\n',
    "utf8"
  );
  expectFailure(
    process.execPath,
    [path.join(ROOT, "bin", "wiki-kit.js"), "doctor", DEFAULT_SMOKE_ROOT, "--live"],
    "[fail] Docker daemon is reachable",
    {
      env: {
        ...process.env,
        WIKI_KIT_DOCKER_COMMAND: process.execPath,
        WIKI_KIT_DOCKER_PREFIX_ARGS: JSON.stringify([fakeDockerPath]),
      },
    }
  );
  for (const invalidAgentsDir of [".", "..", "nested/agents", "nested\\agents", "C:agents", "CON", "agents."]) {
    expectFailure(
      process.execPath,
      [path.join(ROOT, "bin", "wiki-kit.js"), "install", DEFAULT_SMOKE_ROOT, "--agents-dir", invalidAgentsDir],
      "agents dir must be a portable direct-child directory name"
    );
  }
  run(process.execPath, [path.join(ROOT, "bin", "wiki-kit.js"), "update", DEFAULT_SMOKE_ROOT]);

  const mergeRoot = path.join(ARTIFACTS_ROOT, "verify-smoke-merge");
  prepareScratch(mergeRoot);
  fs.mkdirSync(path.join(mergeRoot, ".agents", "skills", "custom"), { recursive: true });
  fs.writeFileSync(path.join(mergeRoot, ".agents", "skills", "custom", "SKILL.md"), "# Custom\n", "utf8");
  fs.mkdirSync(path.join(mergeRoot, ".vscode"), { recursive: true });
  fs.mkdirSync(path.join(mergeRoot, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(mergeRoot, ".codex"), { recursive: true });
  fs.writeFileSync(
    path.join(mergeRoot, "AGENTS.md"),
    "# Existing repository instructions\n\n## Knowledge Scope\n\nLocal colliding Knowledge Scope content.\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(mergeRoot, ".vscode", "mcp.json"),
    '{\n  "servers": {\n    // Keep this user server\n    "other-wiki-kit": { "command": "node", "args": ["other.js"] },\n    "wiki-manager": { "command": "node", "args": ["${workspaceFolder}/.agents/run-wiki-manager.mcp.js"] },\n  },\n}\n',
    "utf8"
  );
  fs.writeFileSync(
    path.join(mergeRoot, ".vscode", "settings.json"),
    '{\n  // User-owned setting\n  "editor.wordWrap": "on",\n  "chat.mcp.autostart": "never",\n}\n',
    "utf8"
  );
  fs.writeFileSync(
    path.join(mergeRoot, ".claude", "settings.local.json"),
    `${JSON.stringify({
      mcpServers: { "other-wiki-kit": { command: "node", args: ["other.js"] } },
      hooks: {
        Stop: [{ matcher: "*", hooks: [
          { type: "command", command: "node .agents/scripts/auto-capture.js" },
          { type: "command", command: "node user-hook.js" },
        ] }],
      },
    }, null, 2)}\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(mergeRoot, "opencode.jsonc"),
    '{\n  // Existing wiki-kit config\n  "mcp": {\n    "other-wiki-kit": { "type": "local", "command": ["node", "other.js"] },\n  },\n  "instructions": ["OTHER.md"],\n}\n',
    "utf8"
  );
  fs.writeFileSync(
    path.join(mergeRoot, ".codex", "config.toml"),
    '[mcp_servers.other-wiki-kit]\ncommand = "node"\nargs = ["other.js"]\n',
    "utf8"
  );
  run(process.execPath, [path.join(ROOT, "bin", "wiki-kit.js"), "install", mergeRoot]);
  assertInstall(mergeRoot, ".agents");
  assertMergedInstall(mergeRoot, ".agents");
  const idempotentFiles = [
    "AGENTS.md",
    ".vscode/mcp.json",
    ".vscode/settings.json",
    ".claude/settings.local.json",
    "opencode.jsonc",
    ".codex/config.toml",
  ];
  const firstMerge = new Map(
    idempotentFiles.map((file) => [file, fs.readFileSync(path.join(mergeRoot, file), "utf8")])
  );
  run(process.execPath, [path.join(ROOT, "bin", "wiki-kit.js"), "update", mergeRoot, "--force"]);
  for (const file of idempotentFiles) {
    assert(
      fs.readFileSync(path.join(mergeRoot, file), "utf8") === firstMerge.get(file),
      `repeated forced update was not idempotent for ${file}`
    );
  }
  assertMergedInstall(mergeRoot, ".agents");
  const mergedStatus = run(process.execPath, [path.join(ROOT, "bin", "wiki-kit.js"), "status", mergeRoot]);
  assert(
    mergedStatus.stdout.includes("MCP configs: 5 current, 0 changed, 0 missing, 0 invalid"),
    "merged MCP configs with unrelated servers were not reported current"
  );
  assert(
    mergedStatus.stdout.includes("MCP configs with unrelated user servers"),
    "status did not distinguish unrelated user MCP additions"
  );

  const legacyVscode = readJson(path.join(mergeRoot, ".vscode", "mcp.json"));
  legacyVscode.servers["wiki-manager"] = {
    command: "node",
    args: [".agents/run-wiki-manager.mcp.js"],
  };
  fs.writeFileSync(
    path.join(mergeRoot, ".vscode", "mcp.json"),
    `${JSON.stringify(legacyVscode, null, 2)}\n`,
    "utf8"
  );
  const legacyVscodeStatus = run(
    process.execPath,
    [path.join(ROOT, "bin", "wiki-kit.js"), "status", mergeRoot]
  );
  assert(
    legacyVscodeStatus.stdout.includes("wiki-manager entry does not match the managed VS Code configuration"),
    "status did not identify the legacy VS Code MCP format"
  );
  run(process.execPath, [path.join(ROOT, "bin", "wiki-kit.js"), "update", mergeRoot]);
  assertMergedInstall(mergeRoot, ".agents");

  const decoyRoot = path.join(ARTIFACTS_ROOT, "verify-smoke-mcp-decoy");
  prepareScratch(decoyRoot);
  run(process.execPath, [path.join(ROOT, "bin", "wiki-kit.js"), "install", decoyRoot]);
  const decoyVscode = readJson(path.join(decoyRoot, ".vscode", "mcp.json"));
  delete decoyVscode.servers["wiki-manager"];
  decoyVscode.servers["unrelated-runner"] = {
    command: "node",
    args: [".agents/run-wiki-manager.mcp.js"],
  };
  fs.writeFileSync(
    path.join(decoyRoot, ".vscode", "mcp.json"),
    `${JSON.stringify(decoyVscode, null, 2)}\n`,
    "utf8"
  );
  const decoyStatus = run(process.execPath, [path.join(ROOT, "bin", "wiki-kit.js"), "status", decoyRoot]);
  assert(
    decoyStatus.stdout.includes(".vscode/mcp.json: wiki-manager entry is missing"),
    "an unrelated JS runner incorrectly satisfied wiki-manager validation"
  );
  expectFailure(
    process.execPath,
    [path.join(ROOT, "bin", "wiki-kit.js"), "doctor", decoyRoot],
    "managed wiki-manager entries are current"
  );

  fs.writeFileSync(path.join(decoyRoot, ".claude", "settings.local.json"), "{ invalid", "utf8");
  const invalidStatus = run(process.execPath, [path.join(ROOT, "bin", "wiki-kit.js"), "status", decoyRoot]);
  assert(
    invalidStatus.stdout.includes(".claude/settings.local.json: unreadable or invalid"),
    "status did not distinguish an unreadable MCP config"
  );

  const legacyAgentsRoot = path.join(ARTIFACTS_ROOT, "verify-smoke-legacy-agents");
  prepareScratch(legacyAgentsRoot);
  const legacyPolicy = fs.readFileSync(path.join(ROOT, "templates", "root", "AGENTS.md"), "utf8");
  fs.writeFileSync(
    path.join(legacyAgentsRoot, "AGENTS.md"),
    `# Existing local instructions\n\n${legacyPolicy
      .replace("<!-- BEGIN WIKI-KIT MANAGED WIKI POLICY -->\n", "")
      .replace("\n<!-- END WIKI-KIT MANAGED WIKI POLICY -->", "")
      .trim()}\n\n## Knowledge Scope\n\nLocal legacy collision.\n\n# More local instructions\n`,
    "utf8"
  );
  run(process.execPath, [path.join(ROOT, "bin", "wiki-kit.js"), "install", legacyAgentsRoot]);
  assertInstall(legacyAgentsRoot, ".agents");
  assertLegacyAgentsPolicyMigrated(legacyAgentsRoot);

  prepareScratch(CUSTOM_SMOKE_ROOT);
  run(process.execPath, [
    path.join(ROOT, "bin", "wiki-kit.js"),
    "install",
    CUSTOM_SMOKE_ROOT,
    "--agents-dir",
    "wiki-kit-agent",
    "--force",
  ]);
  assertInstall(CUSTOM_SMOKE_ROOT, "wiki-kit-agent");
  const customStatus = run(process.execPath, [path.join(ROOT, "bin", "wiki-kit.js"), "status", CUSTOM_SMOKE_ROOT]);
  assert(customStatus.stdout.includes("Agents dir: wiki-kit-agent"), "status did not discover custom agents dir");

  run(process.execPath, [path.join(ROOT, "bin", "wiki-kit.js"), "update", CUSTOM_SMOKE_ROOT]);
  assertInstall(CUSTOM_SMOKE_ROOT, "wiki-kit-agent");
  assert(
    !fs.existsSync(path.join(CUSTOM_SMOKE_ROOT, ".agents")),
    "direct custom update without --agents-dir created a second default installation"
  );

  const wrapperName = process.platform === "win32" ? "update-wiki-kit.cmd" : "update-wiki-kit.sh";
  const wrapperPath = path.join(CUSTOM_SMOKE_ROOT, "wiki-kit-agent", wrapperName);
  const wrapperCommand = process.platform === "win32" ? "cmd.exe" : "sh";
  const wrapperArgs = process.platform === "win32" ? ["/d", "/c", wrapperPath] : [wrapperPath];
  const wrapperMarkerPath = path.join(CUSTOM_SMOKE_ROOT, "wiki-kit-agent", ".wiki-kit-install.json");
  const wrapperMarker = readJson(wrapperMarkerPath);
  wrapperMarker.package = ROOT;
  fs.writeFileSync(wrapperMarkerPath, `${JSON.stringify(wrapperMarker, null, 2)}\n`, "utf8");
  run(wrapperCommand, wrapperArgs, {
    cwd: CUSTOM_SMOKE_ROOT,
    env: { ...process.env },
  });
  assertInstall(CUSTOM_SMOKE_ROOT, "wiki-kit-agent");
  assert(
    !fs.existsSync(path.join(CUSTOM_SMOKE_ROOT, ".agents")),
    "custom update wrapper created a second default installation"
  );

  const ambiguousRoot = path.join(ARTIFACTS_ROOT, "verify-smoke-ambiguous");
  prepareScratch(ambiguousRoot);
  for (const agentsDir of ["agents-one", "agents-two"]) {
    fs.mkdirSync(path.join(ambiguousRoot, agentsDir), { recursive: true });
    fs.writeFileSync(path.join(ambiguousRoot, agentsDir, ".wiki-kit-install.json"), "{}\n", "utf8");
  }
  expectFailure(
    process.execPath,
    [path.join(ROOT, "bin", "wiki-kit.js"), "update", ambiguousRoot],
    "Multiple wiki-kit installations found (agents-one, agents-two)"
  );

  runNpm(["pack", "--dry-run"]);
  console.log("verify: ok");
}

main();
