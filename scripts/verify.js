#!/usr/bin/env node

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const YAML = require("yaml");

// install/update provision Docker by default; these installer tests must stay
// hermetic. Individual scenarios opt back in by overriding this variable.
process.env.WIKI_KIT_SKIP_DOCKER = "1";

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
  const dshMcpPath = path.join(targetRoot, ".dsh", "mcp.servers.yml");
  const dshMcpClientPath = path.join(targetRoot, ".dsh", ".dsh-mcp-client.js");
  const dshModulePath = path.join(targetRoot, ".dsh", "package.json");
  const consumerPolicy = fs.readFileSync(consumerAgentsPath, "utf8");
  assert(
    consumerPolicy.includes(`${agentsDir}/skills/wiki/SKILL.md`),
    "AGENTS.md must name the delivered skill for clients without native skill discovery"
  );
  for (const relativePath of ["SKILL.md", "references/authoring.md", "references/recovery.md", "agents/openai.yaml"]) {
    const deliveredPath = path.join(path.dirname(wikiSkillPath), relativePath);
    const actual = fs.readFileSync(deliveredPath, "utf8");
    const templatePath = path.join(ROOT, "templates", "root", ".agents", "skills", "wiki", relativePath);
    const expected = fs.readFileSync(templatePath, "utf8");
    assert(actual === expected, `delivered wiki guidance differs from its template: ${relativePath}`);
    if (relativePath === "SKILL.md") {
      const frontmatter = actual.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      assert(frontmatter, "wiki skill must include discoverable YAML frontmatter");
      const metadata = YAML.parse(frontmatter[1]);
      assert(metadata.name === "wiki" && metadata.description?.trim(), "wiki skill routing metadata is invalid");
    }
    for (const match of actual.matchAll(/\[[^\]]+\]\(([^)]+\.md)(?:#[^)]*)?\)/g)) {
      assert(
        fs.existsSync(path.resolve(path.dirname(deliveredPath), match[1])),
        `wiki guidance references missing file: ${match[1]}`
      );
    }
  }
  const claudePolicy = fs.readFileSync(path.join(targetRoot, "CLAUDE.md"), "utf8");
  for (const marker of ["<!-- BEGIN WIKI-KIT MANAGED WIKI POLICY -->", "<!-- END WIKI-KIT MANAGED WIKI POLICY -->"]) {
    assert(claudePolicy.split(marker).length - 1 === 1, "managed CLAUDE policy markers are missing or duplicated");
  }
  const managedClaudeBlock = claudePolicy.slice(
    claudePolicy.indexOf("<!-- BEGIN WIKI-KIT MANAGED WIKI POLICY -->"),
    claudePolicy.indexOf("<!-- END WIKI-KIT MANAGED WIKI POLICY -->")
  ).split(/\r?\n/).slice(1).join("\n").trim();
  assert(managedClaudeBlock === "@AGENTS.md", "managed CLAUDE.md block must contain only the @AGENTS.md import");
  for (const relativePath of ["SKILL.md", "references/authoring.md", "references/recovery.md"]) {
    const canonical = fs.readFileSync(path.join(ROOT, "templates", "root", ".agents", "skills", "wiki", relativePath));
    const native = fs.readFileSync(path.join(targetRoot, ".claude", "skills", "wiki", relativePath));
    assert(native.equals(canonical), `native Claude wiki guidance differs from canonical template: ${relativePath}`);
  }
  const claudeConfig = readJson(path.join(targetRoot, ".mcp.json"));
  assert(claudeConfig.mcpServers?.["wiki-manager"]?.command === "node", "root Claude MCP command is incorrect");
  assert(claudeConfig.mcpServers["wiki-manager"].args?.[0] === `${agentsDir}/run-wiki-manager.mcp.js`, "root Claude MCP runner path is incorrect");
  // AGENTS.md stays short: it only points at the recovery reference, which owns the steps.
  for (const expected of ["rather than silently using local files", `${agentsDir}/skills/wiki/references/recovery.md`]) {
    assert(consumerPolicy.includes(expected), `AGENTS.md recovery pointer is missing: ${expected}`);
  }
  const recoveryGuide = fs.readFileSync(path.join(path.dirname(wikiSkillPath), "references", "recovery.md"), "utf8");
  for (const expected of [
    "KB_LIFECYCLE_COMMAND=start node .agents/run-wiki-manager.mcp.js",
    "KB_ATTACH_ONLY=1",
    "do not switch to local files silently",
    "new session",
    "schema-report",
    "MCP_TIMEOUT=150000",
  ]) {
    assert(recoveryGuide.includes(expected), `wiki recovery reference is missing: ${expected}`);
  }
  const claudeSettings = readJson(path.join(targetRoot, ".claude", "settings.json"));
  assert(claudeSettings.env?.MCP_TIMEOUT === "150000", "Claude Code settings must set MCP_TIMEOUT=150000 like Codex and OpenCode");
  assert(fs.existsSync(path.join(targetRoot, agentsDir, "wiki-manager-manifest.js")), "static MCP manifest was not installed beside the runner");
  assert(fs.existsSync(dshMcpClientPath), "agent-scoped DSH MCP client missing from .dsh");
  assert(!fs.existsSync(path.join(targetRoot, ".dsh-mcp-client.js")), "DSH MCP client leaked into repository root");
  assert(readJson(dshModulePath).type === "module", ".dsh MCP client is not in an ESM package scope");
  const dshServer = YAML.parse(fs.readFileSync(dshMcpPath, "utf8")).servers?.["wiki-manager"];
  assert(dshServer?.command === "node", "DSH wiki-manager command is incorrect");
  assert(dshServer?.args?.[0] === `${agentsDir}/run-wiki-manager.mcp.js`, "DSH runner path is incorrect");
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
  const { deriveResourceNames, wikiMountMatches } = require(runnerPath);
  const wikiHere = path.join(ARTIFACTS_ROOT, "identity-a", "same-repo", "wiki");
  assert(wikiMountMatches(wikiHere, wikiHere), "matching wiki mount was reported as stale");
  assert(wikiMountMatches(`${wikiHere}${path.sep}`, wikiHere), "trailing separator caused a false stale mount");
  assert(wikiMountMatches(null, wikiHere), "container without wiki mount metadata must not be recreated");
  assert(
    !wikiMountMatches(path.join(ARTIFACTS_ROOT, "identity-b", "same-repo", "wiki"), wikiHere),
    "wiki mount pointing at a moved repository was not detected"
  );
  const desktopForm = wikiHere.replace(/^([a-zA-Z]):/, (_, drive) => `/run/desktop/mnt/host/${drive.toLowerCase()}`).replace(/\\/g, "/");
  assert(wikiMountMatches(desktopForm, wikiHere), "Docker Desktop VM path form was reported as a stale mount");
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
  assert(marker.containerName === undefined, "install marker must not record a path-derived container name that goes stale after a move");

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

  const claudeConfig = readJson(path.join(targetRoot, ".mcp.json"));
  assert(claudeConfig.mcpServers["other-wiki-kit"]?.args?.[0] === "other.js", "existing root Claude MCP server was not preserved");
  assert(claudeConfig.mcpServers["wiki-manager"], "wiki-manager root Claude MCP server was not merged");
  assert(claudeConfig.userOwned === "keep", "unrelated root Claude MCP configuration was not preserved");
  const localSettings = readJson(path.join(targetRoot, ".claude", "settings.local.json"));
  assert(JSON.stringify(localSettings.hooks || {}).includes("node user-hook.js"), "unrelated Claude hook was not preserved");
  assert(JSON.stringify(localSettings.hooks || {}).includes("auto-capture.js"), "existing Claude hooks were unexpectedly removed");
  const claudePolicy = fs.readFileSync(path.join(targetRoot, "CLAUDE.md"), "utf8");
  assert(claudePolicy.includes("Local Claude Knowledge Scope content."), "local CLAUDE instructions were overwritten");
  assert(claudePolicy.includes("# More Claude instructions"), "trailing local CLAUDE instructions were overwritten");
  assert(fs.readFileSync(path.join(targetRoot, ".claude", "skills", "custom", "SKILL.md"), "utf8") === "# Custom Claude\n", "custom native Claude skill was overwritten");

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
  assert(!fs.existsSync(path.join(DEFAULT_SMOKE_ROOT, ".claude", "settings.local.json")), "fresh install must not create Claude local settings");
  const defaultStatus = run(process.execPath, [path.join(ROOT, "bin", "wiki-kit.js"), "status", DEFAULT_SMOKE_ROOT]);
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
  verifyNativeSkillRefresh(DEFAULT_SMOKE_ROOT, ".agents");
}

function verifyMergedInstall() {
  const mergeRoot = path.join(ARTIFACTS_ROOT, "verify-smoke-merge");
  prepareScratch(mergeRoot);
  fs.mkdirSync(path.join(mergeRoot, ".agents", "skills", "custom"), { recursive: true });
  fs.writeFileSync(path.join(mergeRoot, ".agents", "skills", "custom", "SKILL.md"), "# Custom\n", "utf8");
  fs.mkdirSync(path.join(mergeRoot, ".vscode"), { recursive: true });
  fs.mkdirSync(path.join(mergeRoot, ".claude", "skills", "custom"), { recursive: true });
  fs.writeFileSync(path.join(mergeRoot, ".claude", "skills", "custom", "SKILL.md"), "# Custom Claude\n", "utf8");
  fs.writeFileSync(
    path.join(mergeRoot, "CLAUDE.md"),
    "# Existing Claude instructions\r\n\r\n## Knowledge Scope\r\n\r\nLocal Claude Knowledge Scope content.\r\n\r\n# More Claude instructions\r\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(mergeRoot, ".mcp.json"),
    `${JSON.stringify({
      userOwned: "keep",
      mcpServers: {
        "other-wiki-kit": { command: "node", args: ["other.js"] },
        "wiki-manager": { command: "outdated", args: ["old-runner.js"] },
      },
    }, null, 2)}\n`,
    "utf8"
  );
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
      mcpServers: {
        "other-wiki-kit": { command: "node", args: ["other.js"] },
        "wiki-manager": { command: "legacy-user-command", args: ["do-not-migrate.js"] },
      },
      permissions: { allow: ["Bash(node user-script.js)"] },
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
  fs.writeFileSync(path.join(mergeRoot, ".gitattributes"), "*.png binary\r\n", "utf8");
  const localSettingsPath = path.join(mergeRoot, ".claude", "settings.local.json");
  // Deliberate CRLF, indentation and legacy wiki-manager hooks/configuration: none may be migrated.
  fs.writeFileSync(localSettingsPath, fs.readFileSync(localSettingsPath, "utf8").replace(/\n/g, "\r\n"), "utf8");
  const originalLocalSettings = fs.readFileSync(localSettingsPath);
  run(process.execPath, [path.join(ROOT, "bin", "wiki-kit.js"), "install", mergeRoot]);
  assert(fs.readFileSync(localSettingsPath).equals(originalLocalSettings), "install changed existing Claude local settings bytes");
  assertInstall(mergeRoot, ".agents");
  assertMergedInstall(mergeRoot, ".agents");
  const idempotentFiles = [
    "AGENTS.md",
    "CLAUDE.md",
    ".mcp.json",
    ".claude/skills/wiki/SKILL.md",
    ".claude/skills/wiki/references/authoring.md",
    ".claude/skills/wiki/references/recovery.md",
    ".vscode/mcp.json",
    ".vscode/settings.json",
    ".claude/settings.local.json",
    "opencode.jsonc",
    ".codex/config.toml",
    ".gitattributes",
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
  assert(fs.readFileSync(localSettingsPath).equals(originalLocalSettings), "forced update changed existing Claude local settings bytes");
  run(process.execPath, [path.join(ROOT, "bin", "wiki-kit.js"), "update", mergeRoot]);
  for (const file of idempotentFiles) {
    assert(fs.readFileSync(path.join(mergeRoot, file), "utf8") === firstMerge.get(file), `repeated unforced update was not idempotent for ${file}`);
  }
  assertMergedInstall(mergeRoot, ".agents");
  const gitattributes = fs.readFileSync(path.join(mergeRoot, ".gitattributes"), "utf8");
  assert(gitattributes.startsWith("*.png binary\r\n"), "user .gitattributes rules or line endings were not preserved");
  assert(gitattributes.includes("wiki/**/*.md text eol=lf\r\n"), "managed wiki line-ending rule was not merged into .gitattributes");
  assert(gitattributes.split("# BEGIN WIKI-KIT MANAGED LINE ENDINGS").length === 2, ".gitattributes managed block was duplicated");
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

function verifyNativeSkillRefresh(targetRoot, agentsDir) {
  for (const relativePath of ["SKILL.md", "references/authoring.md", "references/recovery.md"]) {
    fs.writeFileSync(path.join(targetRoot, ".claude", "skills", "wiki", relativePath), "stale native skill\n", "utf8");
    fs.writeFileSync(path.join(targetRoot, agentsDir, "skills", "wiki", relativePath), "stale canonical copy\n", "utf8");
  }
  run(process.execPath, [path.join(ROOT, "bin", "wiki-kit.js"), "update", targetRoot]);
  assertDeliveredSurface(targetRoot, agentsDir);
}

function verifySkipRoot() {
  const skipRoot = path.join(ARTIFACTS_ROOT, "verify-smoke-skip-root");
  prepareScratch(skipRoot);
  run(process.execPath, [path.join(ROOT, "bin", "wiki-kit.js"), "install", skipRoot, "--skip-root"]);
  for (const relativePath of ["CLAUDE.md", ".mcp.json", ".claude"]) {
    assert(!fs.existsSync(path.join(skipRoot, relativePath)), `--skip-root created Claude asset: ${relativePath}`);
  }
  fs.mkdirSync(path.join(skipRoot, ".claude", "skills", "wiki"), { recursive: true });
  const userFiles = ["CLAUDE.md", ".mcp.json", ".claude/settings.local.json", ".claude/skills/wiki/SKILL.md"];
  for (const relativePath of userFiles) fs.writeFileSync(path.join(skipRoot, relativePath), `user-owned ${relativePath}\r\n`, "utf8");
  const originals = userFiles.map(relativePath => fs.readFileSync(path.join(skipRoot, relativePath)));
  run(process.execPath, [path.join(ROOT, "bin", "wiki-kit.js"), "update", skipRoot, "--skip-root", "--force"]);
  userFiles.forEach((relativePath, index) => {
    assert(fs.readFileSync(path.join(skipRoot, relativePath)).equals(originals[index]), `--skip-root changed Claude asset: ${relativePath}`);
  });
  assert(!fs.existsSync(path.join(skipRoot, ".claude", "skills", "wiki", "references")), "--skip-root created native skill references");
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

  run(process.execPath, [path.join(ROOT, "bin", "wiki-kit.js"), "update", decoyRoot]);
  const ignoredSettingsPath = path.join(decoyRoot, ".claude", "settings.local.json");
  fs.writeFileSync(ignoredSettingsPath, "{ invalid local user settings\r\n", "utf8");
  run(process.execPath, [path.join(ROOT, "bin", "wiki-kit.js"), "update", decoyRoot]);
  assert(fs.readFileSync(ignoredSettingsPath, "utf8") === "{ invalid local user settings\r\n", "invalid user local settings were changed");
  assertInstall(decoyRoot, ".agents");
  const claudeMcpPath = path.join(decoyRoot, ".mcp.json");
  const claudeMcp = readJson(claudeMcpPath);
  delete claudeMcp.mcpServers["wiki-manager"];
  fs.writeFileSync(claudeMcpPath, JSON.stringify(claudeMcp), "utf8");
  const missingClaudeStatus = run(process.execPath, [path.join(ROOT, "bin", "wiki-kit.js"), "status", decoyRoot]);
  assert(missingClaudeStatus.stdout.includes(".mcp.json: wiki-manager entry is missing"), "status did not diagnose missing root Claude MCP entry");
  fs.writeFileSync(claudeMcpPath, "{ invalid root MCP\r\n", "utf8");
  const invalidMcp = fs.readFileSync(claudeMcpPath);
  const invalidStatus = run(process.execPath, [path.join(ROOT, "bin", "wiki-kit.js"), "status", decoyRoot]);
  assert(
    invalidStatus.stdout.includes(".mcp.json: unreadable or invalid"),
    "status did not distinguish an unreadable root Claude MCP config"
  );
  assert(!invalidStatus.stdout.includes(".claude/settings.local.json"), "diagnostics still treat local Claude settings as managed MCP config");
  for (const command of ["install", "update"]) {
    expectFailure(process.execPath, [path.join(ROOT, "bin", "wiki-kit.js"), command, decoyRoot, "--force"], "wiki-kit:");
    assert(fs.readFileSync(claudeMcpPath).equals(invalidMcp), `${command} overwrote malformed root Claude MCP config`);
  }
  expectFailure(process.execPath, [path.join(ROOT, "bin", "wiki-kit.js"), "doctor", decoyRoot], "[fail] managed wiki-manager entries are current");
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

  const unmarkedClaudePolicy = [
    "# Existing Claude instructions",
    "",
    "## Knowledge Governance",
    "",
    "This repository uses `$wiki` as the governed project knowledge workflow.",
    "",
    "User-owned instruction inside a legacy-looking policy must survive.",
    "",
    "Keep responses concise by default: changed files, verification, and decision-changing context.",
    "",
    "# More Claude instructions",
  ].join("\n");
  const claudePath = path.join(legacyAgentsRoot, "CLAUDE.md");
  fs.writeFileSync(claudePath, `${unmarkedClaudePolicy}\n`, "utf8");
  run(process.execPath, [path.join(ROOT, "bin", "wiki-kit.js"), "update", legacyAgentsRoot]);
  assert(fs.readFileSync(claudePath, "utf8").includes(unmarkedClaudePolicy), "CLAUDE merge incorrectly migrated an unmarked user policy matching legacy AGENTS signatures");
  assertInstall(legacyAgentsRoot, ".agents");
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
  verifyNativeSkillRefresh(CUSTOM_SMOKE_ROOT, "wiki-kit-agent");
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
  // Docker provisioning is skipped globally (WIKI_KIT_SKIP_DOCKER), so this only
  // verifies that the wrapper updates the custom installation in place.
  run(wrapperCommand, wrapperArgs, { cwd: CUSTOM_SMOKE_ROOT });
  assertInstall(CUSTOM_SMOKE_ROOT, "wiki-kit-agent");
  assert(
    !fs.existsSync(path.join(CUSTOM_SMOKE_ROOT, ".agents")),
    "custom update wrapper created a second default installation"
  );
}

function verifyDockerProvisioning() {
  const root = path.join(ARTIFACTS_ROOT, "verify-smoke-docker-provisioning");
  prepareScratch(root);
  const cli = path.join(ROOT, "bin", "wiki-kit.js");

  const skipped = run(process.execPath, [cli, "install", root, "--skip-docker"]);
  assert(skipped.stdout.includes("Skipped Docker setup"), "--skip-docker did not skip Docker provisioning");

  // An unreachable Docker daemon must never fail an install: files are already usable.
  const unreachableHost = process.platform === "win32"
    ? "npipe:////./pipe/wiki-kit-docker-unavailable"
    : "unix:///tmp/wiki-kit-docker-unavailable.sock";
  const unreachable = run(process.execPath, [cli, "update", root], {
    env: { ...process.env, WIKI_KIT_SKIP_DOCKER: "", DOCKER_HOST: unreachableHost },
  });
  assert(
    unreachable.stderr.includes("Docker is not reachable") && unreachable.stderr.includes("wiki-kit start ."),
    "install did not warn with recovery steps when Docker is unreachable"
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

function verifyClaudeSettingsMerge() {
  const root = path.join(ARTIFACTS_ROOT, "verify-smoke-claude-settings");
  prepareScratch(root);
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  const settingsPath = path.join(root, ".claude", "settings.json");
  fs.writeFileSync(
    settingsPath,
    '{\n  "model": "user-model",\n  "permissions": { "allow": ["Bash(npm test)"] },\n  "env": { "USER_VAR": "1" }\n}\n',
    "utf8"
  );
  run(process.execPath, [path.join(ROOT, "bin", "wiki-kit.js"), "install", root]);
  const merged = readJson(settingsPath);
  assert(merged.model === "user-model" && merged.permissions.allow[0] === "Bash(npm test)", "Claude settings merge lost user keys");
  assert(merged.env.USER_VAR === "1" && merged.env.MCP_TIMEOUT === "150000", "Claude settings merge did not add MCP_TIMEOUT beside user env");
  const first = fs.readFileSync(settingsPath, "utf8");
  run(process.execPath, [path.join(ROOT, "bin", "wiki-kit.js"), "update", root, "--force"]);
  assert(fs.readFileSync(settingsPath, "utf8") === first, "Claude settings merge is not idempotent");
  assert(
    run(process.execPath, [path.join(ROOT, "bin", "wiki-kit.js"), "status", root]).stdout.includes("0 changed, 0 missing"),
    "status does not report merged Claude settings as current"
  );

  // A timeout the user chose deliberately is never overwritten.
  fs.writeFileSync(settingsPath, '{ "env": { "MCP_TIMEOUT": "240000" } }\n', "utf8");
  run(process.execPath, [path.join(ROOT, "bin", "wiki-kit.js"), "update", root, "--force"]);
  assert(readJson(settingsPath).env.MCP_TIMEOUT === "240000", "installer overwrote a user-chosen MCP_TIMEOUT");

  // Malformed user settings must stop the install instead of being replaced.
  fs.writeFileSync(settingsPath, "{ not json", "utf8");
  expectFailure(process.execPath, [path.join(ROOT, "bin", "wiki-kit.js"), "update", root], "wiki-kit:");
  assert(fs.readFileSync(settingsPath, "utf8") === "{ not json", "malformed Claude settings were replaced");
}

function verifyManifestMatchesService() {
  const manifest = require(path.join(ROOT, "templates", "root", ".agents", "wiki-manager-manifest.js"));
  const app = fs.readFileSync(path.join(ROOT, "kb-service", "src", "kb_service", "app.py"), "utf8");
  const serviceTools = new Map();
  const pattern = /@mcp\.tool\(\)\s+(?:async\s+)?def (\w+)\(([\s\S]*?)\)(?:\s*->[^:]+)?:\n/g;
  for (const match of app.matchAll(pattern)) {
    const params = [];
    let depth = 0;
    let current = "";
    for (const char of match[2]) {
      if ("[({".includes(char)) depth += 1;
      if ("])}".includes(char)) depth -= 1;
      if (char === "," && depth === 0) { params.push(current); current = ""; } else current += char;
    }
    params.push(current);
    const parsed = params.map(text => text.trim()).filter(Boolean).map(text => ({
      name: text.split(":")[0].trim(),
      required: !text.includes("="),
    }));
    serviceTools.set(match[1], parsed);
  }
  assert(serviceTools.size >= 10, "could not read the service tool list from app.py");
  assert(
    JSON.stringify([...serviceTools.keys()].sort()) === JSON.stringify(manifest.TOOLS.map(tool => tool.name).sort()),
    "static manifest tool names differ from kb-service/app.py"
  );
  assert(
    JSON.stringify([...serviceTools.keys()].sort()) === JSON.stringify([...COMPATIBILITY.requiredTools].sort()),
    "contract requiredTools differ from kb-service/app.py"
  );
  for (const tool of manifest.TOOLS) {
    const expected = serviceTools.get(tool.name);
    assert(
      JSON.stringify(Object.keys(tool.inputSchema.properties)) === JSON.stringify(expected.map(param => param.name)),
      `static manifest parameters differ from the service for ${tool.name}`
    );
    assert(
      JSON.stringify(tool.inputSchema.required) === JSON.stringify(expected.filter(param => param.required).map(param => param.name)),
      `static manifest required parameters differ from the service for ${tool.name}`
    );
  }
}

// The installed runner must answer a host's handshake even while Docker is
// unreachable (a cold start), and report the problem on the first tool call.
function verifyRunnerAnswersWithoutDocker() {
  const root = path.join(ARTIFACTS_ROOT, "verify-smoke-lazy-runner");
  prepareScratch(root);
  run(process.execPath, [path.join(ROOT, "bin", "wiki-kit.js"), "install", root, "--skip-docker"]);
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "lazy-verifier", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "wiki_list", arguments: {} } },
  ];
  const started = Date.now();
  const result = spawnSync(process.execPath, [path.join(root, ".agents", "run-wiki-manager.mcp.js")], {
    cwd: root,
    env: {
      ...process.env,
      DOCKER_HOST: process.platform === "win32" ? "npipe:////./pipe/wiki-kit-docker-unavailable" : "unix:///tmp/wiki-kit-docker-unavailable.sock",
      KB_DOCKER_DAEMON_TIMEOUT_MS: "100",
      KB_WARMUP_TIMEOUT_MS: "20000",
    },
    input: `${messages.map(message => JSON.stringify(message)).join("\n")}\n`,
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
    timeout: 60000,
  });
  assert(result.status === 0, `lazy runner exited with ${result.status}: ${result.stderr}`);
  const replies = result.stdout.trim().split("\n").map(line => JSON.parse(line));
  const byId = new Map(replies.map(reply => [reply.id, reply]));
  assert(byId.get(1)?.result?.serverInfo, "runner did not answer initialize without Docker");
  const names = byId.get(2)?.result?.tools?.map(tool => tool.name) || [];
  for (const required of COMPATIBILITY.requiredTools) assert(names.includes(required), `tools/list without Docker is missing ${required}`);
  const call = byId.get(3)?.result;
  assert(call?.isError === true, "tool call without Docker did not return a tool error");
  const text = call.content?.[0]?.text || "";
  assert(/could not start/.test(text) && /Docker Desktop's Linux engine is unavailable/.test(text), "tool error did not explain the Docker failure");
  assert(/KB_LIFECYCLE_COMMAND=start node \.agents\/run-wiki-manager\.mcp\.js/.test(text), "tool error did not give the recovery command");
  assert(Date.now() - started < 30000, "runner did not answer promptly");
}

function verifyCliCommands() {
  const cli = path.join(ROOT, "bin", "wiki-kit.js");
  expectFailure(process.execPath, [cli, "search", "."], 'search takes a target and a query');
  expectFailure(process.execPath, [cli, "search", ".", "q", "--top-k", "0"], "--top-k must be a positive integer");
  expectFailure(process.execPath, [cli, "search", ".", "q", "--depth", "full"], "--depth must be abstract or packet");
  const missing = path.join(ARTIFACTS_ROOT, "verify-smoke-cli-missing");
  prepareScratch(missing);
  expectFailure(process.execPath, [cli, "schema-report", missing], "MCP runner is missing");
  const help = run(process.execPath, [cli, "--help"]).stdout;
  for (const expected of ["schema-report", "search [target]", "--keep-warm"]) {
    assert(help.includes(expected), `usage does not document ${expected}`);
  }
}

function verifyPublishedPackage() {
  const inventory = JSON.parse(runNpm(["pack", "--dry-run", "--json"]).stdout);
  // npm versions emit either an array or an object keyed by package name.
  const packed = Array.isArray(inventory) ? inventory[0] : inventory[PACKAGE_METADATA.name];
  assert(Array.isArray(packed?.files), "npm pack did not return a package file inventory");
  const files = new Set(packed.files.map(file => file.path));
  const manifest = PACKAGE_METADATA;
  const patch = YAML.parse(fs.readFileSync(path.join(ROOT, manifest.dsh.bundle.patch), "utf8"));
  assert(patch.some(operation => operation.insert?.some(plugin => plugin.name === `${manifest.name}/dsh`)), "DSH bundle patch does not reference the public lifecycle export");
  const entries = [
    ...Object.values(manifest.bin),
    manifest.main,
    ...Object.values(manifest.exports),
    manifest.dsh.bundle.patch,
    "templates/root/CLAUDE.md",
    "templates/root/.mcp.json",
    "templates/root/.claude/settings.json",
    "templates/root/.agents/wiki-manager-manifest.js",
    "templates/root/.agents/skills/wiki/SKILL.md",
    "templates/root/.agents/skills/wiki/references/authoring.md",
    "templates/root/.agents/skills/wiki/references/recovery.md",
    "templates/root/.agents/skills/wiki/agents/openai.yaml",
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
    ["skip-root excludes Claude assets", verifySkipRoot],
    ["Claude Code startup timeout merges without overwriting user settings", verifyClaudeSettingsMerge],
    ["static MCP manifest matches the service tools", verifyManifestMatchesService],
    ["runner answers the host handshake while Docker is unreachable", verifyRunnerAnswersWithoutDocker],
    ["CLI validation commands", verifyCliCommands],
    ["legacy policy migration", verifyLegacyPolicy],
    ["custom installation and update wrapper", verifyCustomInstall],
    ["docker provisioning is optional and non-fatal", verifyDockerProvisioning],
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
