#!/usr/bin/env node

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const PACKAGE_ROOT = path.resolve(__dirname, "..");
const DEFAULT_AGENTS_DIR = ".agents";
const MARKER_FILE = ".wiki-kit-install.json";
const AGENTS_POLICY_BEGIN = "<!-- BEGIN WIKI-KIT MANAGED WIKI POLICY -->";
const AGENTS_POLICY_END = "<!-- END WIKI-KIT MANAGED WIKI POLICY -->";
const CONTRACT_PATH = path.join(
  PACKAGE_ROOT,
  "templates",
  "root",
  ".agents",
  "wiki-manager-contract.js"
);
const {
  COMPATIBILITY,
  DEFAULT_IMAGE,
  classifyCompatibility,
  deriveResourceNames,
} = require(CONTRACT_PATH);
let packageMetadata = null;

const LEGACY_SKILL_DIRS = [
  "initialize-wiki",
  "migrate-wiki",
  "retrieve-knowledge",
  "wiki-maintenance",
];

function printUsage() {
  console.log(`Usage:
  wiki-kit install [target] [--force] [--agents-dir <dir>] [--skip-root]
  wiki-kit update [target] [--force] [--agents-dir <dir>] [--skip-root]
  wiki-kit status [target] [--agents-dir <dir>]
  wiki-kit doctor [target] [--agents-dir <dir>] [--live]
  wiki-kit start [target] [--agents-dir <dir>]
  wiki-kit stop [target] [--agents-dir <dir>]
  wiki-kit restart [target] [--agents-dir <dir>]
  wiki-kit pull [target] [--agents-dir <dir>]

Examples:
  npx github:ihorleleka/wiki-kit install .
  npx github:ihorleleka/wiki-kit update . --force
  npx github:ihorleleka/wiki-kit status .
  npx github:ihorleleka/wiki-kit doctor .
  npx github:ihorleleka/wiki-kit start .
  npx github:ihorleleka/wiki-kit stop .
  npx github:ihorleleka/wiki-kit pull .
  .agents\\update-wiki-kit.cmd
  sh ./.agents/update-wiki-kit.sh`);
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  const options = {
    command,
    target: ".",
    agentsDir: DEFAULT_AGENTS_DIR,
    agentsDirProvided: false,
    force: false,
    skipRoot: false,
    live: false,
  };

  if (command === "--help" || command === "-h") {
    options.command = "help";
    return options;
  }

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--force") {
      options.force = true;
    } else if (arg === "--live") {
      options.live = true;
    } else if (arg === "--skip-root") {
      options.skipRoot = true;
    } else if (arg === "--agents-dir") {
      const value = args.shift();
      if (!value) throw new Error("--agents-dir requires a value");
      options.agentsDir = value;
      options.agentsDirProvided = true;
    } else if (arg === "--help" || arg === "-h") {
      options.command = "help";
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      options.target = arg;
    }
  }

  return options;
}

function ensureDirectChild(relativePath) {
  const raw = String(relativePath).trim();
  if (!raw) {
    throw new Error("--agents-dir requires a value");
  }

  const normalized = path.normalize(raw);
  const portableNormalized = normalized.replace(/\\/g, "/");
  const hasRoot =
    path.isAbsolute(raw) || path.win32.isAbsolute(raw) || path.posix.isAbsolute(raw);
  const hasSeparator = /[\\/]/.test(raw);
  const hasInvalidWindowsNameChar = /[<>:"|?*\x00-\x1F]/.test(raw);
  const isReservedWindowsName = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(raw);
  const hasInvalidWindowsEnding = /[. ]$/.test(raw);

  if (
    hasRoot ||
    hasSeparator ||
    hasInvalidWindowsNameChar ||
    isReservedWindowsName ||
    hasInvalidWindowsEnding ||
    portableNormalized === "." ||
    portableNormalized === ".."
  ) {
    throw new Error(
      `agents dir must be a portable direct-child directory name inside the target repo: ${relativePath}`
    );
  }

  return portableNormalized;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function removePath(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function copyFile(source, target) {
  ensureDir(path.dirname(target));
  fs.copyFileSync(source, target);
}

function copyDirectory(source, target) {
  ensureDir(target);
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, targetPath);
    } else if (entry.isFile()) {
      copyFile(sourcePath, targetPath);
    }
  }
}

function copyPath(source, target) {
  const stat = fs.statSync(source);
  removePath(target);
  if (stat.isDirectory()) {
    copyDirectory(source, target);
  } else {
    copyFile(source, target);
  }
}

function copyManagedSkills(agentsRoot) {
  const sourceSkillsRoot = path.join(PACKAGE_ROOT, "templates", "root", ".agents", "skills");
  const targetSkillsRoot = path.join(agentsRoot, "skills");
  ensureDir(targetSkillsRoot);

  for (const entry of fs.readdirSync(sourceSkillsRoot, { withFileTypes: true })) {
    const sourcePath = path.join(sourceSkillsRoot, entry.name);
    const targetPath = path.join(targetSkillsRoot, entry.name);
    copyPath(sourcePath, targetPath);
  }
}

function copyManagedAgentFiles(agentsRoot) {
  const sourceAgentsRoot = path.join(PACKAGE_ROOT, "templates", "root", ".agents");
  for (const entry of fs.readdirSync(sourceAgentsRoot, { withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    copyPath(path.join(sourceAgentsRoot, entry.name), path.join(agentsRoot, entry.name));
  }
}

function readPackageMetadata() {
  if (packageMetadata !== null) return packageMetadata;
  const manifestPath = path.join(PACKAGE_ROOT, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  packageMetadata = {
    name: manifest.name,
    version: manifest.version,
  };
  return packageMetadata;
}

function writeMarker(agentsRoot, options) {
  const metadata = readPackageMetadata();
  const marker = {
    package: "github:ihorleleka/wiki-kit",
    packageName: metadata.name,
    version: metadata.version,
    installedAt: new Date().toISOString(),
    agentsDir: options.agentsDir,
    defaultImage: DEFAULT_IMAGE,
    containerName: deriveResourceNames(options.targetRoot).containerName,
  };
  fs.writeFileSync(
    path.join(agentsRoot, MARKER_FILE),
    `${JSON.stringify(marker, null, 2)}\n`,
    "utf8"
  );
}

function removeLegacySkillDirs(agentsRoot) {
  const skillsRoot = path.join(agentsRoot, "skills");
  const removed = [];
  for (const skillName of LEGACY_SKILL_DIRS) {
    const skillPath = path.join(skillsRoot, skillName);
    if (!fs.existsSync(skillPath)) continue;
    removePath(skillPath);
    removed.push(path.relative(agentsRoot, skillPath));
  }
  return removed;
}

function copyWikiKitPayload(agentsRoot, options) {
  ensureDir(agentsRoot);
  const removedLegacySkills = removeLegacySkillDirs(agentsRoot);
  copyManagedAgentFiles(agentsRoot);
  copyManagedSkills(agentsRoot);
  removedLegacySkills.push(...removeLegacySkillDirs(agentsRoot));
  writeMarker(agentsRoot, options);
  return removedLegacySkills;
}

function rewriteAgentsDir(content, agentsDir) {
  if (agentsDir === DEFAULT_AGENTS_DIR) return content;
  const normalized = agentsDir.replace(/\\/g, "/");
  return content.replace(/\.agents/g, normalized);
}

function normalizeTrailingNewline(content) {
  return content.replace(/\s*$/, "\n");
}

function removeLegacyUnmarkedAgentsPolicy(existing, templateContent) {
  const template = templateContent
    .replace(AGENTS_POLICY_BEGIN, "")
    .replace(AGENTS_POLICY_END, "")
    .trim();
  if (existing.trim() === template) return "";

  const exactIndex = existing.indexOf(template);
  if (exactIndex !== -1) {
    return `${existing.slice(0, exactIndex)}${existing.slice(exactIndex + template.length)}`;
  }

  const signature =
    "This repository uses `$wiki` as the governed project knowledge workflow.";
  const finalSentence =
    "Keep responses concise by default: changed files, verification, and decision-changing context.";
  const signatureIndex = existing.indexOf(signature);
  const finalIndex =
    signatureIndex === -1 ? -1 : existing.indexOf(finalSentence, signatureIndex);

  if (signatureIndex === -1 || finalIndex === -1) return existing;
  const blockStart = existing.lastIndexOf("## Knowledge Governance", signatureIndex);
  if (blockStart === -1) return existing;
  const finalLineEnd = existing.indexOf("\n", finalIndex + finalSentence.length);
  const blockEnd = finalLineEnd === -1 ? existing.length : finalLineEnd + 1;
  return `${existing.slice(0, blockStart)}${existing.slice(blockEnd)}`;
}

function mergeAgentsPolicy(existing, templateContent) {
  const block = templateContent.trim();
  const beginIndex = existing.indexOf(AGENTS_POLICY_BEGIN);
  const endIndex = beginIndex === -1 ? -1 : existing.indexOf(AGENTS_POLICY_END, beginIndex);
  let unmanaged = existing;
  if (beginIndex !== -1 && endIndex !== -1) {
    unmanaged = `${existing.slice(0, beginIndex)}${existing.slice(endIndex + AGENTS_POLICY_END.length)}`;
  } else {
    unmanaged = removeLegacyUnmarkedAgentsPolicy(existing, templateContent);
  }
  if (!unmanaged.trim()) return `${block}\n`;
  const withoutLegacyPolicy = unmanaged;
  if (!withoutLegacyPolicy.trim()) return `${block}\n`;
  return `${normalizeTrailingNewline(withoutLegacyPolicy).trimEnd()}\n\n${block}\n`;
}

function readJsonConfig(file) {
  return JSON.parse(stripJsonComments(fs.readFileSync(file, "utf8")));
}

function stripJsonComments(content) {
  let output = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    const next = content[i + 1];

    if (inLineComment) {
      if (char === "\n" || char === "\r") {
        inLineComment = false;
        output += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (!inString && char === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }

    if (!inString && char === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }

    output += char;

    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === "\"") {
      inString = !inString;
    }
  }

  return output.replace(/,\s*([}\]])/g, "$1");
}

function scanJsonc(content) {
  const tokens = [];
  let index = 0;
  while (index < content.length) {
    const char = content[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "/" && content[index + 1] === "/") {
      index = content.indexOf("\n", index + 2);
      if (index === -1) break;
      continue;
    }
    if (char === "/" && content[index + 1] === "*") {
      const end = content.indexOf("*/", index + 2);
      if (end === -1) throw new Error("unterminated JSONC block comment");
      index = end + 2;
      continue;
    }
    if (char === '"') {
      const start = index;
      index += 1;
      let escaped = false;
      while (index < content.length) {
        const current = content[index];
        index += 1;
        if (escaped) escaped = false;
        else if (current === "\\") escaped = true;
        else if (current === '"') break;
      }
      const raw = content.slice(start, index);
      tokens.push({ type: "string", start, end: index, value: JSON.parse(raw) });
      continue;
    }
    if ("{}[]:,".includes(char)) {
      tokens.push({ type: char, start: index, end: index + 1, value: char });
      index += 1;
      continue;
    }
    const start = index;
    while (index < content.length && !/[\s{}\[\]:,]/.test(content[index])) index += 1;
    tokens.push({ type: "literal", start, end: index, value: content.slice(start, index) });
  }
  return tokens;
}

function parseJsoncTree(content) {
  const tokens = scanJsonc(content);
  function parseValue(position) {
    const token = tokens[position];
    if (!token) throw new Error("missing JSONC value");
    if (token.type === "{") {
      const properties = new Map();
      let cursor = position + 1;
      while (tokens[cursor]?.type !== "}") {
        const key = tokens[cursor];
        if (key?.type !== "string" || tokens[cursor + 1]?.type !== ":") {
          throw new Error("malformed JSONC object");
        }
        const parsed = parseValue(cursor + 2);
        properties.set(key.value, { key, value: parsed.node });
        cursor = parsed.next;
        if (tokens[cursor]?.type === ",") cursor += 1;
        else if (tokens[cursor]?.type !== "}") throw new Error("malformed JSONC object separator");
      }
      return {
        node: { type: "object", start: token.start, end: tokens[cursor].end, close: tokens[cursor], properties },
        next: cursor + 1,
      };
    }
    if (token.type === "[") {
      let cursor = position + 1;
      while (tokens[cursor]?.type !== "]") {
        const parsed = parseValue(cursor);
        cursor = parsed.next;
        if (tokens[cursor]?.type === ",") cursor += 1;
        else if (tokens[cursor]?.type !== "]") throw new Error("malformed JSONC array separator");
      }
      return {
        node: { type: "array", start: token.start, end: tokens[cursor].end, close: tokens[cursor] },
        next: cursor + 1,
      };
    }
    if (!["string", "literal"].includes(token.type)) throw new Error("malformed JSONC value");
    return { node: { type: "scalar", start: token.start, end: token.end }, next: position + 1 };
  }
  const parsed = parseValue(0);
  if (parsed.next !== tokens.length) throw new Error("unexpected JSONC content after root");
  return parsed.node;
}

function lineIndentAt(content, offset) {
  const lineStart = content.lastIndexOf("\n", offset - 1) + 1;
  return content.slice(lineStart, offset).match(/^\s*/)?.[0] || "";
}

function renderJsonValue(value, indent) {
  return JSON.stringify(value, null, 2).replace(/\n/g, `\n${indent}`);
}

function setJsoncPath(content, propertyPath, value) {
  const root = parseJsoncTree(content);
  if (root.type !== "object") throw new Error("JSONC root must be an object");
  let parent = root;
  for (let depth = 0; depth < propertyPath.length - 1; depth += 1) {
    const segment = propertyPath[depth];
    const property = parent.properties.get(segment);
    if (!property || property.value.type !== "object") {
      let nested = value;
      for (let tail = propertyPath.length - 1; tail > depth; tail -= 1) {
        nested = { [propertyPath[tail]]: nested };
      }
      return setJsoncPath(content, propertyPath.slice(0, depth + 1), nested);
    }
    parent = property.value;
  }

  const key = propertyPath[propertyPath.length - 1];
  const existing = parent.properties.get(key);
  if (existing) {
    const indent = lineIndentAt(content, existing.key.start);
    return `${content.slice(0, existing.value.start)}${renderJsonValue(value, indent)}${content.slice(existing.value.end)}`;
  }

  const parentIndent = lineIndentAt(content, parent.start);
  const childIndent = `${parentIndent}  `;
  const beforeClose = content.slice(parent.start + 1, parent.close.start);
  const hasProperties = parent.properties.size > 0;
  const hasTrailingComma = /,\s*(?:(?:\/\/[^\n]*(?:\n|$))|(?:\/\*[\s\S]*?\*\/)|\s)*$/.test(beforeClose);
  const prefix = hasProperties ? (hasTrailingComma ? "\n" : ",\n") : "\n";
  const insertion = `${prefix}${childIndent}${JSON.stringify(key)}: ${renderJsonValue(value, childIndent)}\n${parentIndent}`;
  return `${content.slice(0, parent.close.start)}${insertion}${content.slice(parent.close.start)}`;
}

function wikiManagerJsonServer(agentsDir) {
  return {
    command: "node",
    args: [`${agentsDir.replace(/\\/g, "/")}/run-wiki-manager.mcp.js`],
  };
}

function wikiManagerVscodeServer(sourcePath, agentsDir) {
  const template = JSON.parse(rewriteAgentsDir(fs.readFileSync(sourcePath, "utf8"), agentsDir));
  return template.servers["wiki-manager"];
}

function mergeJsonRootAsset(sourcePath, targetPath, relativePath, options) {
  let content = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf8") : "{}\n";
  // Validate before editing so malformed user configuration is never replaced.
  readJsonConfig(targetPath && fs.existsSync(targetPath) ? targetPath : sourcePath);

  if (relativePath === ".vscode/mcp.json") {
    content = setJsoncPath(
      content,
      ["servers", "wiki-manager"],
      wikiManagerVscodeServer(sourcePath, options.agentsDir)
    );
  } else if (relativePath === ".claude/settings.local.json") {
    content = setJsoncPath(content, ["mcpServers", "wiki-manager"], wikiManagerJsonServer(options.agentsDir));
  } else if (relativePath === "opencode.jsonc") {
    content = setJsoncPath(content, ["mcp", "wiki-manager"], {
      type: "local",
      enabled: true,
      timeout: 75000,
      command: ["node", `${options.agentsDir.replace(/\\/g, "/")}/run-wiki-manager.mcp.js`],
    });
    const config = JSON.parse(stripJsonComments(content));
    config.instructions = Array.isArray(config.instructions) ? config.instructions : [];
    if (!config.instructions.includes("AGENTS.md")) config.instructions.push("AGENTS.md");
    content = setJsoncPath(content, ["instructions"], config.instructions);
    if (!config.$schema) content = setJsoncPath(content, ["$schema"], JSON.parse(fs.readFileSync(sourcePath, "utf8")).$schema);
  } else {
    return false;
  }

  ensureDir(path.dirname(targetPath));
  fs.writeFileSync(targetPath, normalizeTrailingNewline(content), "utf8");
  return true;
}

function mergeVscodeSettings(sourcePath, targetPath) {
  let content = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf8") : "{}\n";
  if (fs.existsSync(targetPath)) readJsonConfig(targetPath);
  const managed = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  for (const [key, value] of Object.entries(managed)) {
    content = setJsoncPath(content, [key], value);
  }
  ensureDir(path.dirname(targetPath));
  fs.writeFileSync(targetPath, normalizeTrailingNewline(content), "utf8");
}

function removeExistingCodexWikiBlock(content) {
  const lines = content.split(/\r?\n/);
  const output = [];
  let skipping = false;

  for (const line of lines) {
    const table = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (table) {
      const name = table[1];
      if (name === "mcp_servers.wiki-manager" || name.startsWith("mcp_servers.wiki-manager.")) {
        skipping = true;
        continue;
      }
      skipping = false;
    }
    if (!skipping) output.push(line);
  }

  return output.join("\n").replace(/\s*$/, "\n");
}

function mergeCodexToml(existing, templateContent) {
  const block = templateContent.trim();
  const withoutOldWikiBlock = removeExistingCodexWikiBlock(existing);
  if (!withoutOldWikiBlock.trim()) return `${block}\n`;
  return `${withoutOldWikiBlock.trimEnd()}\n\n${block}\n`;
}

function writeRootAsset(sourcePath, targetPath, relativePath, options) {
  const sourceContent = rewriteAgentsDir(fs.readFileSync(sourcePath, "utf8"), options.agentsDir);

  if (relativePath === "AGENTS.md") {
    const existing = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf8") : "";
    ensureDir(path.dirname(targetPath));
    fs.writeFileSync(targetPath, mergeAgentsPolicy(existing, sourceContent), "utf8");
    return "merged";
  }

  if (relativePath === ".codex/config.toml") {
    const existing = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf8") : "";
    ensureDir(path.dirname(targetPath));
    fs.writeFileSync(targetPath, mergeCodexToml(existing, sourceContent), "utf8");
    return "merged";
  }

  if (
    [".vscode/mcp.json", ".claude/settings.local.json", "opencode.jsonc"].includes(relativePath)
  ) {
    mergeJsonRootAsset(sourcePath, targetPath, relativePath, options);
    return "merged";
  }

  if (relativePath === ".vscode/settings.json") {
    mergeVscodeSettings(sourcePath, targetPath);
    return "merged";
  }

  if (fs.existsSync(targetPath) && !options.force) return "skipped";
  ensureDir(path.dirname(targetPath));
  fs.writeFileSync(targetPath, sourceContent, "utf8");
  return "copied";
}

function copyRootPayload(targetRoot, options) {
  if (options.skipRoot) return { copied: [], skipped: [], merged: [] };

  const result = { copied: [], skipped: [], merged: [] };
  const sourceRoot = path.join(PACKAGE_ROOT, "templates", "root");
  const entries = fs.readdirSync(sourceRoot, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === ".agents") {
      continue;
    }
    const sourcePath = path.join(sourceRoot, entry.name);
    const targetPath = path.join(targetRoot, entry.name);

    if (entry.isDirectory()) {
      copyDirectoryWithRewrite(sourcePath, targetPath, options, result);
    } else if (entry.isFile()) {
      const relativePath = entry.name;
      recordRootAssetResult(
        targetRoot,
        targetPath,
        writeRootAsset(sourcePath, targetPath, relativePath, options),
        result
      );
    }
  }

  return result;
}

function recordRootAssetResult(targetRoot, targetPath, action, result) {
  if (action === "skipped") {
    recordSkippedRootAsset(targetRoot, targetPath, result);
  } else if (action === "merged") {
    result.merged.push(path.relative(targetRoot, targetPath));
  } else if (action === "copied") {
    result.copied.push(path.relative(targetRoot, targetPath));
  }
}

function recordSkippedRootAsset(targetRoot, targetPath, result) {
  const relativePath = path.relative(targetRoot, targetPath);
  result.skipped.push(relativePath);
  console.warn(`Skipped existing root asset: ${relativePath}`);
}

function copyDirectoryWithRewrite(source, target, options, result) {
  ensureDir(target);
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryWithRewrite(sourcePath, targetPath, options, result);
    } else if (entry.isFile()) {
      const relativePath = path.relative(options.targetRoot, targetPath).replace(/\\/g, "/");
      recordRootAssetResult(
        options.targetRoot,
        targetPath,
        writeRootAsset(sourcePath, targetPath, relativePath, options),
        result
      );
    }
  }
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function collectTemplateFiles(sourceRoot, prefix = "") {
  const files = [];
  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    if (prefix === "" && entry.name === ".agents") continue;
    const sourcePath = path.join(sourceRoot, entry.name);
    const relativePath = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      files.push(...collectTemplateFiles(sourcePath, relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

function discoverAgentsDir(targetRoot, requestedAgentsDir, wasProvided) {
  if (wasProvided) return requestedAgentsDir;

  const candidates = [];
  for (const entry of fs.readdirSync(targetRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const markerPath = path.join(targetRoot, entry.name, MARKER_FILE);
    if (fs.existsSync(markerPath)) candidates.push(entry.name);
  }

  if (candidates.length > 1) {
    throw new Error(
      `Multiple wiki-kit installations found (${candidates.sort().join(", ")}); ` +
        "re-run with --agents-dir <dir> to choose one explicitly."
    );
  }
  if (candidates.length === 1) return candidates[0];
  return requestedAgentsDir;
}

function describeMarker(agentsRoot) {
  const markerPath = path.join(agentsRoot, MARKER_FILE);
  if (!fs.existsSync(markerPath)) {
    return { exists: false, marker: null };
  }
  return { exists: true, marker: readJsonSafe(markerPath) };
}

function compareRootAssets(targetRoot, agentsDir) {
  const sourceRoot = path.join(PACKAGE_ROOT, "templates", "root");
  const files = collectTemplateFiles(sourceRoot);
  const result = {
    current: [],
    changed: [],
    missing: [],
  };

  for (const relativePath of files) {
    const portablePath = relativePath.replace(/\\/g, "/");
    const sourcePath = path.join(sourceRoot, relativePath);
    const targetPath = path.join(targetRoot, relativePath);
    if (!fs.existsSync(targetPath)) {
      result.missing.push(portablePath);
      continue;
    }
    const expected = rewriteAgentsDir(fs.readFileSync(sourcePath, "utf8"), agentsDir);
    const actual = fs.readFileSync(targetPath, "utf8");
    if (portablePath === "AGENTS.md" && actual.includes(expected.trim())) {
      result.current.push(portablePath);
    } else if (portablePath === ".codex/config.toml" && actual.includes(expected.trim())) {
      result.current.push(portablePath);
    } else if ([".vscode/mcp.json", ".claude/settings.local.json", "opencode.jsonc"].includes(portablePath)) {
      const validation = validateMcpConfig(targetRoot, agentsDir, portablePath);
      (validation.state === "current" ? result.current : result.changed).push(portablePath);
    } else if (portablePath === ".vscode/settings.json") {
      try {
        const managed = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
        const installed = readJsonConfig(targetPath);
        const isCurrent = Object.entries(managed).every(
          ([key, value]) => JSON.stringify(installed[key]) === JSON.stringify(value)
        );
        (isCurrent ? result.current : result.changed).push(portablePath);
      } catch {
        result.changed.push(portablePath);
      }
    } else if (actual === expected) {
      result.current.push(portablePath);
    } else {
      result.changed.push(portablePath);
    }
  }

  return result;
}

function portablePath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function validateRunner(targetRoot, agentsDir, command, args) {
  const expectedRunner = `${portablePath(agentsDir)}/run-wiki-manager.mcp.js`;
  if (command !== "node") return { state: "changed", detail: "wiki-manager command must be node" };
  const actualRunner = Array.isArray(args) && args.length === 1 ? portablePath(args[0]) : "";
  if (!actualRunner || actualRunner !== expectedRunner) {
    return { state: "changed", detail: `wiki-manager args must reference ${expectedRunner}` };
  }
  const resolved = path.resolve(targetRoot, actualRunner);
  const expectedResolved = path.resolve(targetRoot, expectedRunner);
  if (resolved !== expectedResolved || !fs.existsSync(expectedResolved)) {
    return { state: "changed", detail: `wiki-manager runner is missing or resolves outside ${expectedRunner}` };
  }
  return { state: "current", detail: "" };
}

function codexWikiManagerEntry(content) {
  const lines = content.split(/\r?\n/);
  const header = "[mcp_servers.wiki-manager]";
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) return null;
  const block = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) break;
    block.push(lines[index]);
  }
  const text = block.join("\n");
  const command = text.match(/^\s*command\s*=\s*"([^"]+)"\s*$/m)?.[1];
  const argsBody = text.match(/^\s*args\s*=\s*\[([^\]]*)\]\s*$/m)?.[1];
  if (!command || argsBody === undefined) return { malformed: true };
  const args = [...argsBody.matchAll(/"([^"]*)"/g)].map((match) => match[1]);
  return { command, args };
}

function validateMcpConfig(targetRoot, agentsDir, configFile) {
  const configPath = path.join(targetRoot, configFile);
  if (!fs.existsSync(configPath)) return { state: "missing", detail: "file missing", additions: 0 };

  try {
    let entry;
    let additions = 0;
    if (configFile === ".codex/config.toml") {
      const content = fs.readFileSync(configPath, "utf8");
      entry = codexWikiManagerEntry(content);
      additions = [...content.matchAll(/^\s*\[mcp_servers\.([^\.\]]+)\]\s*$/gm)]
        .map((match) => match[1])
        .filter((name) => name !== "wiki-manager").length;
      if (entry?.malformed) {
        return { state: "invalid", detail: "wiki-manager TOML entry is malformed", additions };
      }
    } else {
      const config = readJsonConfig(configPath);
      if (!config || typeof config !== "object" || Array.isArray(config)) {
        return { state: "invalid", detail: "top-level config is not an object", additions: 0 };
      }
      let servers;
      if (configFile === ".vscode/mcp.json") servers = config.servers;
      if (configFile === ".claude/settings.local.json") servers = config.mcpServers;
      if (configFile === "opencode.jsonc") servers = config.mcp;
      if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
        return { state: "changed", detail: "wiki-manager server collection is missing", additions: 0 };
      }
      entry = servers["wiki-manager"];
      additions = Object.keys(servers).filter((name) => name !== "wiki-manager").length;
    }

    if (!entry) return { state: "changed", detail: "wiki-manager entry is missing", additions };
    if (typeof entry !== "object" || Array.isArray(entry)) {
      return { state: "invalid", detail: "wiki-manager entry is malformed", additions };
    }
    if (configFile === ".vscode/mcp.json") {
      const templatePath = path.join(PACKAGE_ROOT, "templates", "root", ".vscode", "mcp.json");
      const expectedEntry = wikiManagerVscodeServer(templatePath, agentsDir);
      if (JSON.stringify(entry) !== JSON.stringify(expectedEntry)) {
        return {
          state: "changed",
          detail: "wiki-manager entry does not match the managed VS Code configuration",
          additions,
        };
      }
      return {
        ...validateRunner(targetRoot, agentsDir, entry.command, [`${portablePath(agentsDir)}/run-wiki-manager.mcp.js`]),
        additions,
      };
    }
    const command = configFile === "opencode.jsonc" ? entry.command?.[0] : entry.command;
    const args = configFile === "opencode.jsonc" ? entry.command?.slice(1) : entry.args;
    return { ...validateRunner(targetRoot, agentsDir, command, args), additions };
  } catch (error) {
    return { state: "invalid", detail: `unreadable or invalid: ${error.message}`, additions: 0 };
  }
}

function checkMcpReferences(targetRoot, agentsDir) {
  const configFiles = [
    ".claude/settings.local.json",
    ".vscode/mcp.json",
    "opencode.jsonc",
    ".codex/config.toml",
  ];
  const result = {
    ok: [],
    changed: [],
    missing: [],
    invalid: [],
    additions: [],
  };

  for (const configFile of configFiles) {
    const validation = validateMcpConfig(targetRoot, agentsDir, configFile);
    if (validation.state === "current") result.ok.push(configFile);
    if (validation.state === "changed") result.changed.push(`${configFile}: ${validation.detail}`);
    if (validation.state === "missing") result.missing.push(configFile);
    if (validation.state === "invalid") result.invalid.push(`${configFile}: ${validation.detail}`);
    if (validation.additions > 0) result.additions.push(`${configFile}: ${validation.additions}`);
  }

  return result;
}

function commandWorks(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    output: `${result.stdout || ""}${result.stderr || ""}`.trim(),
    error: result.error ? result.error.message : "",
  };
}

function printList(label, items) {
  if (items.length === 0) return;
  console.log(`${label}: ${items.join(", ")}`);
}

function getInstallState(options) {
  options.agentsDir = ensureDirectChild(options.agentsDir);
  const targetRoot = path.resolve(process.cwd(), options.target);
  if (!fs.existsSync(targetRoot) || !fs.statSync(targetRoot).isDirectory()) {
    throw new Error(`Target directory does not exist: ${targetRoot}`);
  }

  const agentsDir = discoverAgentsDir(targetRoot, options.agentsDir, options.agentsDirProvided);
  const agentsRoot = path.join(targetRoot, agentsDir);
  const markerState = describeMarker(agentsRoot);
  return {
    targetRoot,
    agentsDir,
    agentsRoot,
    markerState,
  };
}

function runStatus(options) {
  const { targetRoot, agentsDir, agentsRoot, markerState } = getInstallState(options);
  const marker = markerState.marker;
  const metadata = readPackageMetadata();
  const rootAssets = compareRootAssets(targetRoot, agentsDir);
  const mcpRefs = checkMcpReferences(targetRoot, agentsDir);
  const runnerPath = path.join(agentsRoot, "run-wiki-manager.mcp.js");
  const skillPath = path.join(agentsRoot, "skills", "wiki", "SKILL.md");
  const wikiPath = path.join(targetRoot, "wiki");
  const configuredImage = process.env.KB_IMAGE || DEFAULT_IMAGE;
  const containerName = process.env.KB_CONTAINER_NAME
    ? deriveResourceNames(targetRoot, process.env).containerName
    : marker?.containerName || deriveResourceNames(targetRoot).containerName;
  const imageState = inspectContainerImage(containerName);

  console.log(`Wiki-Kit status for ${targetRoot}`);
  console.log(`Package: ${metadata.name}@${metadata.version}`);
  console.log(`Agents dir: ${agentsDir}`);
  console.log(`Install marker: ${markerState.exists ? "present" : "missing"}`);
  if (marker) {
    console.log(`Installed package: ${marker.packageName || "unknown"}@${marker.version || "unknown"}`);
    console.log(`Installed at: ${marker.installedAt || "unknown"}`);
  } else if (markerState.exists) {
    console.log("Install marker detail: unreadable");
  }
  console.log(`Runner: ${fs.existsSync(runnerPath) ? "present" : "missing"}`);
  console.log(`Managed wiki skill: ${fs.existsSync(skillPath) ? "present" : "missing"}`);
  console.log(`Wiki directory: ${fs.existsSync(wikiPath) ? "present" : "missing"}`);
  console.log(`Configured image: ${configuredImage}`);
  console.log(`Image configuration: ${process.env.KB_IMAGE ? "override" : "current"}`);
  console.log(`Container: ${containerName} (${imageState.running ? "running" : "not running"})`);
  if (imageState.running) {
    console.log(`Running image: ${imageState.imageReference || "unknown"}`);
    console.log(`Running image ID: ${imageState.imageId || "unknown"}`);
    console.log(`Running image digest: ${imageState.repoDigest || "unknown"}`);
    console.log(`Service version: ${imageState.serviceVersion || "unknown"}`);
    console.log(`Index schema version: ${imageState.indexSchemaVersion ?? "unknown"}`);
    console.log(`MCP tool contract version: ${imageState.mcpToolContractVersion ?? "unknown"}`);
    console.log(`Compatibility: ${imageState.compatibility}`);
    if (imageState.compatibility === "outdated") {
      console.log(`Compatibility action: run wiki-kit pull . then wiki-kit restart .`);
    } else if (imageState.compatibility === "incompatible") {
      console.log(`Compatibility action: update the wiki-kit or remove the KB_IMAGE override`);
    }
  } else {
    console.log("Compatibility: not running");
  }
  console.log(
    `Root assets: ${rootAssets.current.length} current, ${rootAssets.changed.length} changed, ${rootAssets.missing.length} missing`
  );
  printList("Changed root assets", rootAssets.changed);
  printList("Missing root assets", rootAssets.missing);
  console.log(
    `MCP configs: ${mcpRefs.ok.length} current, ${mcpRefs.changed.length} changed, ` +
      `${mcpRefs.missing.length} missing, ${mcpRefs.invalid.length} invalid`
  );
  printList("Changed MCP configs", mcpRefs.changed);
  printList("Missing MCP configs", mcpRefs.missing);
  printList("Invalid MCP configs", mcpRefs.invalid);
  printList("MCP configs with unrelated user servers", mcpRefs.additions);
}

function inspectContainerImage(containerName) {
  const result = spawnSync("docker", ["inspect", containerName], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
  });
  if (result.status !== 0) return { running: false };

  const [container] = JSON.parse(result.stdout);
  if (!container?.State?.Running) return { running: false };
  const labels = container.Config?.Labels || {};
  const serviceVersion = labels["org.opencontainers.image.version"];
  const indexSchemaVersion =
    labels["io.github.ihorleleka.project-rag-wiki.index-schema-version"];
  const mcpToolContractVersion =
    labels["io.github.ihorleleka.project-rag-wiki.mcp-tool-contract-version"];
  const imageReference = container.Config?.Image || "";
  const imageResult = spawnSync("docker", ["image", "inspect", imageReference], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
  });
  let repoDigest = "";
  if (imageResult.status === 0) {
    const [image] = JSON.parse(imageResult.stdout);
    repoDigest = image?.RepoDigests?.[0] || "";
  }

  return {
    running: true,
    imageReference,
    imageId: container.Image || "",
    repoDigest,
    serviceVersion,
    indexSchemaVersion,
    mcpToolContractVersion,
    compatibility: classifyCompatibility({
      serviceVersion,
      indexSchemaVersion,
      mcpToolContractVersion,
    }),
  };
}

function inspectLoopbackBinding(containerName) {
  const result = spawnSync(
    "docker",
    ["inspect", containerName, "--format", "{{json (index (index .NetworkSettings.Ports \"1111/tcp\") 0)}}"],
    { cwd: process.cwd(), encoding: "utf8", stdio: "pipe", windowsHide: true }
  );
  if (result.status !== 0) return { ok: false, detail: "container port metadata unavailable" };
  try {
    const binding = JSON.parse(result.stdout.trim());
    const ok = binding?.HostIp === "127.0.0.1" && Boolean(binding?.HostPort);
    return { ok, detail: ok ? `${binding.HostIp}:${binding.HostPort}` : JSON.stringify(binding), binding };
  } catch (error) {
    return { ok: false, detail: `invalid port metadata: ${error.message}` };
  }
}

async function probeHealth(binding) {
  try {
    const response = await fetch(`http://127.0.0.1:${binding.HostPort}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    const body = await response.json();
    return { ok: response.ok && body.status === "ok", detail: JSON.stringify(body) };
  } catch (error) {
    return { ok: false, detail: error.message };
  }
}

function probeMcpRunner(runnerPath, targetRoot) {
  return new Promise((resolve) => {
    const child = require("child_process").spawn(process.execPath, [runnerPath], {
      cwd: targetRoot,
      env: { ...process.env, KB_ATTACH_ONLY: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.stdin.end();
      resolve(result);
    };
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const timer = setTimeout(
      () => finish({ ok: false, detail: `MCP probe timed out. ${stderr.trim()}`.trim() }),
      30000
    );

    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      while (stdout.includes("\n")) {
        const newline = stdout.indexOf("\n");
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          if (!message.result?.serverInfo) {
            finish({ ok: false, detail: `initialize failed: ${line}` });
            continue;
          }
          send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        } else if (message.id === 2) {
          const names = (message.result?.tools || []).map((tool) => tool.name);
          const missing = COMPATIBILITY.requiredTools.filter((name) => !names.includes(name));
          if (missing.length) {
            finish({ ok: false, detail: `expected tools missing (${missing.join(", ")}): ${names.join(", ")}` });
            continue;
          }
          send({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "wiki_list", arguments: {} },
          });
        } else if (message.id === 3) {
          if (message.error || message.result?.isError) {
            finish({ ok: false, detail: `wiki_list failed: ${line}` });
          } else {
            finish({ ok: true, detail: "initialize, tools/list, and read-only wiki_list succeeded" });
          }
        }
      }
    });
    child.on("error", (error) => finish({ ok: false, detail: error.message }));
    child.on("exit", (code) => {
      if (!finished) finish({ ok: false, detail: `MCP runner exited with ${code}. ${stderr.trim()}`.trim() });
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "wiki-kit-doctor", version: "1.0.0" },
      },
    });
  });
}

async function runDoctor(options) {
  const { targetRoot, agentsDir, agentsRoot, markerState } = getInstallState(options);
  const checks = [];
  const addCheck = (ok, label, detail = "", recovery = "") =>
    checks.push({ ok, label, detail, recovery });
  const rootAssets = compareRootAssets(targetRoot, agentsDir);
  const mcpRefs = checkMcpReferences(targetRoot, agentsDir);
  const nodeCheck = commandWorks(process.execPath, ["--version"]);
  const dockerCommand = process.env.WIKI_KIT_DOCKER_COMMAND || "docker";
  const dockerPrefixArgs = process.env.WIKI_KIT_DOCKER_PREFIX_ARGS
    ? JSON.parse(process.env.WIKI_KIT_DOCKER_PREFIX_ARGS)
    : [];
  const doctorDocker = (args) => commandWorks(dockerCommand, [...dockerPrefixArgs, ...args]);
  const dockerCheck = doctorDocker(["--version"]);

  addCheck(markerState.exists && Boolean(markerState.marker), "install marker is present and readable", "", "run wiki-kit update . --force");
  addCheck(fs.existsSync(path.join(agentsRoot, "run-wiki-manager.mcp.js")), "MCP runner is present");
  addCheck(fs.existsSync(path.join(agentsRoot, "skills", "wiki", "SKILL.md")), "managed wiki skill is present");
  addCheck(fs.existsSync(path.join(targetRoot, "wiki")), "wiki directory is present");
  addCheck(rootAssets.missing.length === 0, "root assets are present", rootAssets.missing.join(", "));
  addCheck(
    mcpRefs.invalid.length === 0 && mcpRefs.changed.length === 0,
    "managed wiki-manager entries are current",
    [...mcpRefs.changed, ...mcpRefs.invalid].join("; ")
  );
  addCheck(nodeCheck.ok, "Node.js is available", nodeCheck.output || nodeCheck.error);
  addCheck(dockerCheck.ok, "Docker CLI is available", dockerCheck.output || dockerCheck.error);

  if (options.live) {
    const daemon = doctorDocker(["info", "--format", "{{.ServerVersion}}"]);
    addCheck(daemon.ok, "Docker daemon is reachable", daemon.output || daemon.error, "start Docker Desktop or the Docker daemon, then rerun doctor --live");

    const configuredImage = process.env.KB_IMAGE || DEFAULT_IMAGE;
    const image = daemon.ok ? doctorDocker(["image", "inspect", configuredImage]) : { ok: false, output: "daemon unavailable", error: "" };
    addCheck(image.ok, "configured image is available locally", image.ok ? configuredImage : image.output || image.error, `run wiki-kit pull .`);

    const containerName = process.env.KB_CONTAINER_NAME
      ? deriveResourceNames(targetRoot, process.env).containerName
      : markerState.marker?.containerName || deriveResourceNames(targetRoot).containerName;
    const imageState = daemon.ok ? inspectContainerImage(containerName) : { running: false };
    addCheck(imageState.running, "repository container is running", containerName, "run wiki-kit start .");

    const binding = imageState.running ? inspectLoopbackBinding(containerName) : { ok: false, detail: "container not running" };
    addCheck(binding.ok, "container is bound to loopback", binding.detail, "run wiki-kit restart . after removing unsafe KB_BIND_ADDRESS overrides");

    const compatible = imageState.running && ["current", "outdated"].includes(imageState.compatibility);
    addCheck(
      compatible,
      "service, index schema, and MCP tool contract are compatible",
      imageState.running
        ? `${imageState.serviceVersion || "unknown"} / schema ${imageState.indexSchemaVersion ?? "unknown"} / tools ${imageState.mcpToolContractVersion ?? "unknown"}: ${imageState.compatibility}`
        : "container not running",
      "run wiki-kit pull . then wiki-kit restart ., or update the wiki-kit for the configured image"
    );

    const health = binding.ok ? await probeHealth(binding.binding) : { ok: false, detail: "loopback binding unavailable" };
    addCheck(health.ok, "service health endpoint is ready", health.detail, "inspect docker logs for the repository container, then run wiki-kit restart .");

    const mcp = health.ok
      ? await probeMcpRunner(path.join(agentsRoot, "run-wiki-manager.mcp.js"), targetRoot)
      : { ok: false, detail: "health check failed" };
    addCheck(mcp.ok, "MCP handshake and read-only tool call succeed", mcp.detail, "run wiki-kit restart . and inspect the runner/container logs");
  }

  console.log(`Wiki-Kit doctor for ${targetRoot} (${options.live ? "static + live" : "static"})`);
  for (const check of checks) {
    const prefix = check.ok ? "[ok]" : "[fail]";
    console.log(`${prefix} ${check.label}${check.detail ? ` - ${check.detail}` : ""}`);
    if (!check.ok && check.recovery) console.log(`  recovery: ${check.recovery}`);
  }

  if (rootAssets.changed.length > 0) {
    console.log(`[info] root assets changed from template - ${rootAssets.changed.join(", ")}`);
  }
  if (mcpRefs.missing.length > 0) {
    console.log(`[info] optional MCP configs missing - ${mcpRefs.missing.join(", ")}`);
  }
  if (mcpRefs.additions.length > 0) {
    console.log(`[info] unrelated MCP servers preserved - ${mcpRefs.additions.join(", ")}`);
  }

  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

function runLifecycle(options) {
  const { targetRoot, agentsRoot } = getInstallState(options);
  const runnerPath = path.join(agentsRoot, "run-wiki-manager.mcp.js");
  if (!fs.existsSync(runnerPath)) {
    throw new Error(`MCP runner is missing: ${runnerPath}`);
  }

  const result = spawnSync(process.execPath, [runnerPath], {
    cwd: targetRoot,
    env: {
      ...process.env,
      KB_LIFECYCLE_COMMAND: options.command,
    },
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
    timeout: 120000,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${options.command} failed${result.stderr ? `: ${result.stderr.trim()}` : ""}`
    );
  }
  console.log(`Wiki MCP container ${options.command} completed for ${targetRoot}`);
}

function runPull() {
  const image = process.env.KB_IMAGE || DEFAULT_IMAGE;
  const result = spawnSync("docker", ["pull", image], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`docker pull failed for ${image}`);
  console.log(`Pulled wiki MCP image: ${image}`);
}

function run(options) {
  if (!options.command || options.command === "help") {
    printUsage();
    return;
  }
  if (options.command === "status") {
    runStatus(options);
    return;
  }
  if (options.command === "doctor") {
    return runDoctor(options);
  }
  if (["start", "stop", "restart"].includes(options.command)) {
    runLifecycle(options);
    return;
  }
  if (options.command === "pull") {
    runPull(options);
    return;
  }
  if (options.command !== "install" && options.command !== "update") {
    throw new Error(`Unknown command: ${options.command}`);
  }

  options.agentsDir = ensureDirectChild(options.agentsDir);
  const targetRoot = path.resolve(process.cwd(), options.target);
  if (!fs.existsSync(targetRoot) || !fs.statSync(targetRoot).isDirectory()) {
    throw new Error(`Target directory does not exist: ${targetRoot}`);
  }
  options.targetRoot = targetRoot;
  options.agentsDir = discoverAgentsDir(
    targetRoot,
    options.agentsDir,
    options.agentsDirProvided
  );

  const agentsRoot = path.join(targetRoot, options.agentsDir);
  const removedLegacySkills = copyWikiKitPayload(agentsRoot, options);
  const rootAssets = copyRootPayload(targetRoot, options);

  console.log(`${options.command === "install" ? "Installed" : "Updated"} wiki-kit in ${agentsRoot}`);
  if (removedLegacySkills.length > 0) {
    console.log(`Removed legacy skills: ${removedLegacySkills.join(", ")}`);
  }
  if (rootAssets.copied.length > 0) {
    console.log(`Copied root assets: ${rootAssets.copied.join(", ")}`);
  }
  if (rootAssets.merged.length > 0) {
    console.log(`Merged root assets: ${rootAssets.merged.join(", ")}`);
  }
  if (rootAssets.skipped.length > 0) {
    console.warn(
      `Skipped ${rootAssets.skipped.length} existing root asset(s) because --force was not set.`
    );
    console.warn(
      "Non-mergeable root assets may now differ from the managed wiki-kit template; re-run with --force to refresh them."
    );
  }
  if (
    rootAssets.copied.length === 0 &&
    rootAssets.merged.length === 0 &&
    rootAssets.skipped.length === 0 &&
    !options.skipRoot
  ) {
    console.log("No root assets copied; existing files were left in place.");
  }
}

Promise.resolve()
  .then(() => run(parseArgs(process.argv.slice(2))))
  .catch((err) => {
  console.error(`wiki-kit: ${err.message}`);
  process.exit(1);
  });
