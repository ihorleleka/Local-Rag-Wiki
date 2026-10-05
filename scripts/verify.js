#!/usr/bin/env node

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const YAML = require("yaml");

const ROOT = path.resolve(__dirname, "..");
const ARTIFACTS_ROOT = path.join(ROOT, ".artifacts");
const DEFAULT_SMOKE_ROOT = path.join(ARTIFACTS_ROOT, "verify-smoke-default");
const CUSTOM_SMOKE_ROOT = path.join(ARTIFACTS_ROOT, "verify-smoke-custom");
const DEFAULT_PACKAGE_SOURCE = "github:ihorleleka/Local-Rag-Wiki";
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
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

  if (result.error || result.status === null) {
    fail(`${command} could not run: ${result.error?.message || result.signal}`);
  }
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
  const relative = path.relative(ARTIFACTS_ROOT, path.resolve(dir));
  assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "scratch directory must be inside .artifacts");
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
  for (const relativePath of ["SKILL.md", "references/authoring.md"]) {
    const deliveredPath = path.join(path.dirname(wikiSkillPath), relativePath);
    assert(fs.existsSync(deliveredPath), `wiki guidance missing: ${relativePath}`);
    const actual = fs.readFileSync(deliveredPath, "utf8");
    assert(actual.trim(), `wiki guidance is empty: ${relativePath}`);
    for (const match of actual.matchAll(/\[[^\]]+\]\(([^)]+\.md)(?:#[^)]*)?\)/g)) {
      assert(
        fs.existsSync(path.resolve(path.dirname(deliveredPath), match[1])),
        `wiki guidance references missing file: ${match[1]}`
      );
    }
  }
  assert(fs.existsSync(integrationManifestPath), "integration manifest missing");
  assert(fs.existsSync(marketplacePath), "plugin marketplace metadata missing");
  assert(fs.existsSync(dshMcpPath), "DeepSeek Harness MCP configuration missing");
  assert(fs.existsSync(dshMcpClientPath), "agent-scoped DSH MCP client missing from .dsh");
  assert(!fs.existsSync(path.join(targetRoot, ".dsh-mcp-client.js")), "DSH MCP client leaked into repository root");
  assert(readJson(dshModulePath).type === "module", ".dsh MCP client is not in an ESM package scope");
  const dshServer = YAML.parse(fs.readFileSync(dshMcpPath, "utf8")).servers?.["wiki-manager"];
  assert(dshServer?.command === "node", "DSH wiki-manager command is incorrect");
  assert(dshServer?.args?.[0] === `${agentsDir}/run-wiki-manager.mcp.js`, "DSH runner path is incorrect");
  assert(fs.existsSync(path.join(targetRoot, dshServer.args[0])), "installed MCP runner is missing");
  const runner = fs.readFileSync(path.join(targetRoot, dshServer.args[0]), "utf8");
  assert(
    /"--ulimit"\s*,\s*"core=0:0"/.test(runner),
    "installed MCP runner is missing the zero soft/hard core limit"
  );
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
  const packageJson = PACKAGE_METADATA;
  const marker = readJson(path.join(targetRoot, agentsDir, ".wiki-kit-install.json"));

  const expectedSource = expectedPackageSource || DEFAULT_PACKAGE_SOURCE;
  assert(marker.package === expectedSource, "install marker package source changed unexpectedly");
  assert(marker.packageName === packageJson.name, "install marker packageName does not match package.json");
  assert(marker.version === packageJson.version, "install marker version does not match package.json");
  assert(marker.agentsDir === agentsDir, "install marker agentsDir does not match install option");
  assert(marker.defaultImage === DEFAULT_IMAGE, "install marker does not record the pinned image");
  assert(Boolean(marker.containerName), "install marker does not record the repository container name");

  assertDeliveredSurface(targetRoot, agentsDir);

  const status = run(process.execPath, [path.join(ROOT, "bin", "wiki-kit.js"), "status", targetRoot]);
  assert(status.stdout.includes("MCP configs: 5 current, 0 changed, 0 missing, 0 invalid"), "installed MCP configurations are not current");
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
  const imageName = YAML.parse(dockerReleaseWorkflow).env?.IMAGE_NAME;
  assert(
    imageName === expectedRepository,
    `docker-release IMAGE_NAME must match pinned repository (${expectedRepository}), found ${imageName}`
  );
}

function assertMergedInstall(targetRoot, agentsDir) {
  const agentsPolicy = fs.readFileSync(path.join(targetRoot, "AGENTS.md"), "utf8");
  assert(
    agentsPolicy.split("<!-- BEGIN WIKI-KIT MANAGED WIKI POLICY -->").length - 1 === 1 &&
      agentsPolicy.split("<!-- END WIKI-KIT MANAGED WIKI POLICY -->").length - 1 === 1,
    "managed AGENTS policy markers are missing or duplicated"
  );

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

  const vscodeSettingsText = fs.readFileSync(path.join(targetRoot, ".vscode", "settings.json"), "utf8");
  const vscodeSettings = readJson(path.join(targetRoot, ".vscode", "settings.json"));
  assert(vscodeSettings["editor.wordWrap"] === "on", "unrelated VS Code setting was overwritten");
  assert(vscodeSettingsText.includes("// User-owned setting"), "VS Code settings comment was not preserved");

  const codexConfig = fs.readFileSync(path.join(targetRoot, ".codex", "config.toml"), "utf8");
  assert(codexConfig.includes("[mcp_servers.other-wiki-kit]"), "existing Codex MCP server was not preserved");
  assert(codexConfig.includes("[mcp_servers.wiki-manager]"), "wiki-manager Codex MCP server was not merged");

  assert(agentsPolicy.includes("Local colliding Knowledge Scope content."), "local AGENTS instructions were overwritten");
  assert(fs.readFileSync(path.join(targetRoot, agentsDir, "skills", "custom", "SKILL.md"), "utf8") === "# Custom\n", "custom skill was overwritten");
}

function assertLegacyAgentsPolicyMigrated(targetRoot) {
  const agentsPolicy = fs.readFileSync(path.join(targetRoot, "AGENTS.md"), "utf8");
  const begin = "<!-- BEGIN WIKI-KIT MANAGED WIKI POLICY -->";
  const end = "<!-- END WIKI-KIT MANAGED WIKI POLICY -->";
  assert(agentsPolicy.split(begin).length - 1 === 1, "legacy policy migration did not produce one managed block");
  assert(agentsPolicy.split(end).length - 1 === 1, "legacy policy migration did not close one managed block");
  assert(agentsPolicy.indexOf(begin) < agentsPolicy.indexOf(end), "managed policy markers are out of order");
  const expected = fs.readFileSync(path.join(ROOT, "templates", "root", "AGENTS.md"), "utf8").trim();
  assert(agentsPolicy.includes(expected), "legacy migration did not install the current policy");
  assert(agentsPolicy.includes("# Existing local instructions") && agentsPolicy.includes("# More local instructions"), "legacy migration overwrote local instructions");
}

function verifyContracts() {
  assert(
    PACKAGE_METADATA.version === COMPATIBILITY.wikiKitVersion,
    "package.json version must match the shared wiki-kit/service release version"
  );
  assertCompatibilityClassification();
  assertReleaseWorkflowImageRepository();
  assertRepositoryUniqueResourceNames();
}

function verifyDefaultInstall() {
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
}

function verifyMergedInstall() {
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
}

function verifyDiagnostics() {
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
    "[fail] managed wiki-manager entries are current"
  );

  fs.writeFileSync(path.join(decoyRoot, ".claude", "settings.local.json"), "{ invalid", "utf8");
  const invalidStatus = run(process.execPath, [path.join(ROOT, "bin", "wiki-kit.js"), "status", decoyRoot]);
  assert(
    invalidStatus.stdout.includes(".claude/settings.local.json: unreadable or invalid"),
    "status did not distinguish an unreadable MCP config"
  );
}

function verifyLegacyPolicy() {
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
}

function verifyCustomInstall() {
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
  const { findAgentsRoot } = require(path.join(ROOT, "packages", "dsh-local-rag-wiki", "workspace-runner.cjs"));
  assert(findAgentsRoot(CUSTOM_SMOKE_ROOT) === path.join(CUSTOM_SMOKE_ROOT, "wiki-kit-agent"), "workspace runner did not discover the custom installation");
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
  const wrapperFakeDockerDir = path.join(CUSTOM_SMOKE_ROOT, "wrapper-fake-docker");
  fs.mkdirSync(wrapperFakeDockerDir, { recursive: true });
  // This fixture verifies update selection and pull dispatch, not Docker image
  // inspection: a Windows batch stub transfers control at the first invocation.
  const fakeDocker = path.join(wrapperFakeDockerDir, process.platform === "win32" ? "docker.cmd" : "docker");
  const fakeDockerLog = path.join(wrapperFakeDockerDir, "arguments.log");
  fs.writeFileSync(
    fakeDocker,
    process.platform === "win32"
      ? "@echo off\r\necho %* >> \"%WIKI_KIT_DOCKER_LOG%\"\r\nexit /b 0\r\n"
      : "#!/usr/bin/env sh\nprintf '%s\\n' \"$*\" >> \"$WIKI_KIT_DOCKER_LOG\"\nexit 0\n",
    "utf8"
  );
  if (process.platform !== "win32") fs.chmodSync(fakeDocker, 0o755);
  run(wrapperCommand, wrapperArgs, {
    cwd: CUSTOM_SMOKE_ROOT,
    env: {
      ...process.env,
      PATH: `${wrapperFakeDockerDir}${path.delimiter}${process.env.PATH || ""}`,
      Path: `${wrapperFakeDockerDir}${path.delimiter}${process.env.Path || process.env.PATH || ""}`,
      WIKI_KIT_DOCKER_LOG: fakeDockerLog,
    },
  });
  const pulledArguments = fs.existsSync(fakeDockerLog) ? fs.readFileSync(fakeDockerLog, "utf8") : "";
  assert(
    pulledArguments.split(/\r?\n/).some(line => line.startsWith("pull ") && line.includes(DEFAULT_IMAGE)),
    "update wrapper did not pull the installed image"
  );
  assertInstall(CUSTOM_SMOKE_ROOT, "wiki-kit-agent");
  assert(
    !fs.existsSync(path.join(CUSTOM_SMOKE_ROOT, ".agents")),
    "custom update wrapper created a second default installation"
  );
}

function verifyAmbiguousInstall() {
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
}

function verifyPublishedPackage() {
  const inventory = JSON.parse(runNpm(["pack", "--dry-run", "--json"]).stdout);
  // npm versions emit either an array or an object keyed by package name.
  const packed = Array.isArray(inventory) ? inventory[0] : inventory[PACKAGE_METADATA.name];
  assert(Array.isArray(packed?.files), "npm pack did not return a package file inventory");
  const files = new Set(packed.files.map(file => file.path));
  const manifest = PACKAGE_METADATA;
  for (const name of [".", "./dsh", "./dsh-mcp-client", "./dsh-runner"]) {
    assert(typeof manifest.exports?.[name] === "string", `public package export is missing: ${name}`);
  }
  const patch = YAML.parse(fs.readFileSync(path.join(ROOT, manifest.dsh.bundle.patch), "utf8"));
  assert(patch.some(operation => operation.insert?.some(plugin => plugin.name === `${manifest.name}/dsh`)), "DSH bundle patch does not reference the public lifecycle export");
  const entries = [
    ...Object.values(manifest.bin),
    manifest.main,
    ...Object.values(manifest.exports),
    manifest.dsh.bundle.patch,
    "templates/root/.agents/skills/wiki/SKILL.md",
    "templates/root/.agents/skills/wiki/references/authoring.md",
    "templates/root/.agents/run-wiki-manager.mcp.js",
  ];
  for (const entry of entries) {
    assert(files.has(entry.replace(/^\.\//, "")), `published package is missing ${entry}`);
  }
}

function main() {
  // Installer/package behavior only; DSH runtime and live Docker checks have
  // dedicated verify-dsh-mcp.js and verify-runner.js entrypoints.
  const scenarios = [
    ["release contracts and repository isolation", verifyContracts],
    ["fresh install and invalid options", verifyDefaultInstall],
    ["user configuration preservation and idempotent updates", verifyMergedInstall],
    ["missing and malformed configuration diagnostics", verifyDiagnostics],
    ["legacy policy migration", verifyLegacyPolicy],
    ["custom installation and update wrapper", verifyCustomInstall],
    ["ambiguous installation rejection", verifyAmbiguousInstall],
    ["published package assets", verifyPublishedPackage],
  ];
  for (const [name, verify] of scenarios) {
    verify();
    console.log(`verify: ${name}: ok`);
  }
  console.log("verify: ok");
}

main();
