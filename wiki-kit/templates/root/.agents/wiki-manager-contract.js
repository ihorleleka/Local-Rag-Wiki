const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DEFAULT_IMAGE = "ihorleleka/project-rag-wiki:0.0.13";

const SERVICE_COMPATIBILITY = Object.freeze({
  "0.0.9": Object.freeze({
    indexSchemaVersion: 4,
    minimumMcpToolContractVersion: 1,
    maximumMcpToolContractVersion: 1,
    requiredTools: Object.freeze([
      "wiki_search",
      "wiki_read",
      "wiki_list",
      "wiki_schema_report",
      "wiki_write",
    ]),
  }),
  "0.0.10": Object.freeze({
    indexSchemaVersion: 6,
    minimumMcpToolContractVersion: 4,
    maximumMcpToolContractVersion: 4,
    requiredTools: Object.freeze([
      "wiki_search",
      "wiki_read",
      "wiki_list",
      "wiki_schema_report",
      "wiki_write",
      "wiki_delete",
      "wiki_rename",
    ]),
  }),
  "0.0.11": Object.freeze({
    indexSchemaVersion: 6,
    minimumMcpToolContractVersion: 4,
    maximumMcpToolContractVersion: 4,
    requiredTools: Object.freeze([
      "wiki_search",
      "wiki_read",
      "wiki_list",
      "wiki_schema_report",
      "wiki_write",
      "wiki_delete",
      "wiki_rename",
    ]),
  }),
  "0.0.12": Object.freeze({
    indexSchemaVersion: 6,
    minimumMcpToolContractVersion: 4,
    maximumMcpToolContractVersion: 4,
    requiredTools: Object.freeze([
      "wiki_search",
      "wiki_read",
      "wiki_list",
      "wiki_schema_report",
      "wiki_write",
      "wiki_delete",
      "wiki_rename",
    ]),
  }),"0.0.13": Object.freeze({
    indexSchemaVersion: 6,
    minimumMcpToolContractVersion: 4,
    maximumMcpToolContractVersion: 4,
    requiredTools: Object.freeze([
      "wiki_search",
      "wiki_read",
      "wiki_list",
      "wiki_schema_report",
      "wiki_write",
      "wiki_delete",
      "wiki_rename",
    ]),
  }),
});

const COMPATIBILITY = Object.freeze({
  wikiKitVersion: "0.3.5",
  currentServiceVersion: "0.0.13",
  minimumServiceVersion: "0.0.9",
  maximumServiceVersion: "0.0.13",
  indexSchemaVersion: 6,
  minimumMcpToolContractVersion: 4,
  maximumMcpToolContractVersion: 4,
  requiredTools: SERVICE_COMPATIBILITY["0.0.13"].requiredTools,
  services: SERVICE_COMPATIBILITY,
});

function normalizeContainerName(input) {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "kb";
}

function canonicalRepositoryRoot(repositoryRoot) {
  const resolved = path.resolve(repositoryRoot);
  let canonical = resolved;
  try {
    canonical = fs.realpathSync.native(resolved);
  } catch {
    // The resolved absolute path is still deterministic if realpath is unavailable.
  }
  const portable = canonical.replace(/\\/g, "/");
  return process.platform === "win32" ? portable.toLowerCase() : portable;
}

function deriveResourceNames(repositoryRoot, env = process.env) {
  const canonicalRoot = canonicalRepositoryRoot(repositoryRoot);
  const rootHash = crypto
    .createHash("sha256")
    .update(canonicalRoot, "utf8")
    .digest("hex")
    .slice(0, 12);
  const repoName = normalizeContainerName(path.basename(canonicalRoot) || "repo").slice(0, 16);
  const repositoryIdentity = `${repoName}-${rootHash}`;

  return {
    kbVolume: env.KB_VOLUME || `${repositoryIdentity}-kb-data`,
    hfCacheVolume: env.HF_CACHE_VOLUME || "hf-cache",
    containerName: normalizeContainerName(
      env.KB_CONTAINER_NAME || `${repositoryIdentity}-kb`
    ),
  };
}

function parseVersion(input) {
  const match = String(input || "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function classifyServiceVersion(serviceVersion) {
  if (!parseVersion(serviceVersion) || !SERVICE_COMPATIBILITY[serviceVersion]) {
    return "incompatible";
  }
  return serviceVersion === COMPATIBILITY.currentServiceVersion ? "current" : "outdated";
}

function classifyCompatibility(metadata) {
  const serviceState = classifyServiceVersion(metadata.serviceVersion);
  if (serviceState === "incompatible") return serviceState;
  const expected = SERVICE_COMPATIBILITY[metadata.serviceVersion];
  const schema = metadata.indexSchemaVersion;
  const toolContract = metadata.mcpToolContractVersion;
  if (schema === undefined || Number(schema) !== expected.indexSchemaVersion) {
    return "incompatible";
  }
  if (
    toolContract === undefined ||
    Number(toolContract) < expected.minimumMcpToolContractVersion ||
    Number(toolContract) > expected.maximumMcpToolContractVersion
  ) {
    return "incompatible";
  }
  return serviceState;
}

module.exports = {
  COMPATIBILITY,
  DEFAULT_IMAGE,
  SERVICE_COMPATIBILITY,
  canonicalRepositoryRoot,
  classifyCompatibility,
  classifyServiceVersion,
  deriveResourceNames,
};

