#!/usr/bin/env node

const { spawn } = require("child_process");
const path = require("path");
const http = require("http");
const net = require("net");
const { StringDecoder } = require("string_decoder");
const {
  DEFAULT_IMAGE,
  canonicalRepositoryRoot,
  deriveResourceNames,
} = require("./wiki-manager-contract");

const ROOT = path.resolve(__dirname, "..");
const IMAGE = process.env.KB_IMAGE || DEFAULT_IMAGE;
const MIN_PORT = 1111;
const MAX_PORT = 9999;
const CONTAINER_PORT = 1111;
const DEFAULT_BIND_ADDRESS = "127.0.0.1";
const KB_BIND_ADDRESS = (process.env.KB_BIND_ADDRESS || DEFAULT_BIND_ADDRESS).trim();
const ALLOW_NETWORK_EXPOSURE = ["1", "true"].includes(
  (process.env.KB_ALLOW_NETWORK_EXPOSURE || "").trim().toLowerCase()
);
const KB_WIKI_ROOT = "/workspace/wiki";
const KB_REPOSITORY_ROOT = "/repository";
const KB_ROOT = "/workspace/.kb";
const HF_CACHE_ROOT = "/root/.cache/huggingface/hub";
let kbVolume = null;
let hfCacheVolume = null;
const KB_EMBEDDING_MODEL = process.env.KB_EMBEDDING_MODEL || "all-MiniLM-L6-v2";
const KB_CHUNK_TOKENS = process.env.KB_CHUNK_TOKENS || "220";
const KB_TOP_K = process.env.KB_TOP_K || "8";
const KB_MIN_RELEVANCE = process.env.KB_MIN_RELEVANCE || "0.35";
const KB_EVIDENCE_MAX_ANCHORS = process.env.KB_EVIDENCE_MAX_ANCHORS || "12";
const KB_MERGE_ADJACENT_WINDOW = process.env.KB_MERGE_ADJACENT_WINDOW || "1";
const KB_WATCH_INTERVAL_SECONDS = process.env.KB_WATCH_INTERVAL_SECONDS || "15";
const FIND_FREE_PORT =
  (process.env.KB_FIND_FREE_PORT || "1").trim().toLowerCase() !== "0";
const REQUEST_TIMEOUT_MS = 2500;
const READY_TIMEOUT_MS = 8000;
const HEALTH_TIMEOUT_MS = parseTimeoutMs(
  process.env.KB_HEALTH_TIMEOUT_MS,
  70000,
  "KB_HEALTH_TIMEOUT_MS"
);
const POLL_INTERVAL_MS = 500;

let shuttingDown = false;
let bridgeStarted = false;
let containerName = null;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      ...options,
    });

    child.stdout?.on("data", (chunk) => process.stderr.write(chunk));
    child.stderr?.on("data", (chunk) => process.stderr.write(chunk));

    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}`));
    });

    child.on("error", reject);
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeUrls(port) {
  let host = KB_BIND_ADDRESS;
  if (host === "0.0.0.0") host = DEFAULT_BIND_ADDRESS;
  if (host === "::") host = "::1";
  if (host.includes(":")) host = `[${host}]`;
  return {
    mcpUrl: `http://${host}:${port}/mcp/`,
    healthUrl: `http://${host}:${port}/health`,
  };
}

function validateBindAddress() {
  if (!KB_BIND_ADDRESS) {
    throw new Error("KB_BIND_ADDRESS must not be empty.");
  }
  if ([DEFAULT_BIND_ADDRESS, "::1"].includes(KB_BIND_ADDRESS)) return;
  if (!ALLOW_NETWORK_EXPOSURE) {
    throw new Error(
      `Refusing to publish the unauthenticated wiki-manager MCP server on ${KB_BIND_ADDRESS}. ` +
        "Set KB_ALLOW_NETWORK_EXPOSURE=1 only if network exposure is intentional."
    );
  }
}

function dockerPublishArgument(port) {
  const address = KB_BIND_ADDRESS.includes(":")
    ? `[${KB_BIND_ADDRESS}]`
    : KB_BIND_ADDRESS;
  return `${address}:${port}:${CONTAINER_PORT}`;
}

function hashString(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function parsePort(raw) {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_PORT || n > MAX_PORT) {
    throw new Error(`Invalid KB_PORT "${raw}". Expected ${MIN_PORT}-${MAX_PORT}.`);
  }
  return n;
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findFirstFreePort(startPort) {
  for (let port = startPort; port <= MAX_PORT; port += 1) {
    if (await isPortFree(port)) return port;
  }
  for (let port = MIN_PORT; port < startPort; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port found in ${MIN_PORT}-${MAX_PORT}.`);
}

async function selectPort() {
  const override = parsePort(process.env.KB_PORT);
  if (override !== null) {
    if (FIND_FREE_PORT && !(await isPortFree(override))) {
      return findFirstFreePort(override + 1 <= MAX_PORT ? override + 1 : MIN_PORT);
    }
    return override;
  }

  const span = MAX_PORT - MIN_PORT + 1;
  const hash = hashString(ROOT);
  const preferred = MIN_PORT + (hash % span);

  if (!FIND_FREE_PORT || (await isPortFree(preferred))) {
    return preferred;
  }

  return findFirstFreePort(preferred + 1 <= MAX_PORT ? preferred + 1 : MIN_PORT);
}

async function getHttpStatus(url, options = {}) {
  const {
    acceptStatus = (statusCode) => statusCode === 200,
    headers,
    timeoutMs = REQUEST_TIMEOUT_MS,
  } = options;

  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      const ok = acceptStatus(res.statusCode ?? 0);
      res.resume();
      if (ok) resolve();
      else reject(new Error(`HTTP ${res.statusCode}`));
    });

    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

async function waitFor(checkFn, timeoutMs = READY_TIMEOUT_MS, intervalMs = POLL_INTERVAL_MS) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await checkFn();
      return true;
    } catch {
      // Retry until the timeout expires.
    }
    await wait(intervalMs);
  }
  return false;
}

async function isEndpointReady(port) {
  const { healthUrl, mcpUrl } = makeUrls(port);

  try {
    await getHttpStatus(healthUrl);
    await getHttpStatus(mcpUrl, {
      acceptStatus: (statusCode) => statusCode !== 404,
      headers: { Accept: "application/json, text/event-stream" },
    });
    return true;
  } catch {
    return false;
  }
}

async function waitForEndpointReady(port, timeoutMs = 8000) {
  return waitFor(async () => {
    if (!(await isEndpointReady(port))) {
      throw new Error("endpoint not ready");
    }
  }, timeoutMs);
}

async function getContainerState(container) {
  try {
    const output = await runCapture("docker", ["inspect", container], { echoStderr: false });
    const [details] = JSON.parse(output);
    const binding = details?.NetworkSettings?.Ports?.["1111/tcp"]?.[0];
    return {
      running: Boolean(details?.State?.Running),
      port: binding?.HostPort || null,
      hostIp: binding?.HostIp || null,
    };
  } catch {
    return { running: false, port: null, hostIp: null };
  }
}

function parseTimeoutMs(raw, fallback, name) {
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name} "${raw}". Expected a positive integer.`);
  }
  return value;
}

async function attachToRunningContainer(name) {
  const existingContainer = await getContainerState(name);
  if (!existingContainer.running || !existingContainer.port) {
    return null;
  }
  if (existingContainer.hostIp !== KB_BIND_ADDRESS) {
    return null;
  }

  const port = Number(existingContainer.port);
  if (!(await waitForEndpointReady(port, HEALTH_TIMEOUT_MS))) {
    throw new Error(
      `Existing KB container "${name}" is running on port ${port} but is not responding`
    );
  }

  return port;
}

function runCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { echoStderr = true, ...spawnOptions } = options;
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      ...spawnOptions,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (echoStderr) process.stderr.write(chunk);
    });

    child.on("exit", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited with ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    });

    child.on("error", reject);
  });
}

async function removeContainer() {
  if (!containerName) return;
  await runCapture("docker", ["rm", "-f", containerName], {
    echoStderr: false,
  }).catch(() => {});
}

async function startContainer(port) {
  const wikiPath = path.join(ROOT, "wiki");
  await run("docker", [
    "run",
    "-d",
    "--name",
    containerName,
    "-p",
    dockerPublishArgument(port),
    "-e",
    `KB_WIKI_ROOT=${KB_WIKI_ROOT}`,
    "-e",
    `KB_REPOSITORY_ROOT=${KB_REPOSITORY_ROOT}`,
    "-e",
    `KB_ROOT=${KB_ROOT}`,
    "-e",
    `KB_EMBEDDING_MODEL=${KB_EMBEDDING_MODEL}`,
    "-e",
    `KB_CHUNK_TOKENS=${KB_CHUNK_TOKENS}`,
    "-e",
    `KB_TOP_K=${KB_TOP_K}`,
    "-e",
    `KB_MIN_RELEVANCE=${KB_MIN_RELEVANCE}`,
    "-e",
    `KB_EVIDENCE_MAX_ANCHORS=${KB_EVIDENCE_MAX_ANCHORS}`,
    "-e",
    `KB_MERGE_ADJACENT_WINDOW=${KB_MERGE_ADJACENT_WINDOW}`,
    "-e",
    `KB_WATCH_INTERVAL_SECONDS=${KB_WATCH_INTERVAL_SECONDS}`,
    "-v",
    `${wikiPath}:${KB_WIKI_ROOT}`,
    "-v",
    `${ROOT}:${KB_REPOSITORY_ROOT}:ro`,
    "-v",
    `${kbVolume}:${KB_ROOT}`,
    "-v",
    `${hfCacheVolume}:${HF_CACHE_ROOT}`,
    IMAGE,
  ]);
}

async function startOrAttachContainer(port) {
  try {
    await startContainer(port);
  } catch (startError) {
    const attachedPort = await attachToRunningContainer(containerName);
    if (attachedPort !== null) {
      return makeUrls(attachedPort).mcpUrl;
    }

    // A stopped or unhealthy container is stale. Removing it is safe because
    // attachToRunningContainer has already established that it is not serving.
    await removeContainer();
    try {
      await startContainer(port);
    } catch (retryError) {
      // Another runner may have won the create race after stale cleanup.
      const raceWinnerPort = await attachToRunningContainer(containerName);
      if (raceWinnerPort !== null) {
        return makeUrls(raceWinnerPort).mcpUrl;
      }
      throw new Error(
        `Unable to start or attach to KB container "${containerName}": ${retryError.message}`,
        { cause: startError }
      );
    }
  }

  const { healthUrl, mcpUrl } = makeUrls(port);
  const ready = await waitFor(() => getHttpStatus(healthUrl), HEALTH_TIMEOUT_MS, 1000);
  if (!ready) {
    throw new Error(
      `KB container "${containerName}" did not become healthy within ${HEALTH_TIMEOUT_MS}ms`
    );
  }
  return mcpUrl;
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  process.exit(0);
}

function writeFramedJson(jsonText) {
  const payload = Buffer.from(jsonText, "utf8");
  const header = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "utf8");
  process.stdout.write(Buffer.concat([header, payload]));
}

function writeNdjson(jsonText) {
  process.stdout.write(`${jsonText}\n`);
}

function parseSseMessages(body) {
  const messages = [];
  const lines = body.split(/\r?\n/);
  const dataLines = [];

  for (const line of lines) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
      continue;
    }
    if (line.trim() === "" && dataLines.length > 0) {
      messages.push(dataLines.join("\n"));
      dataLines.length = 0;
    }
  }
  if (dataLines.length > 0) {
    messages.push(dataLines.join("\n"));
  }
  return messages.filter((m) => m && m !== "[DONE]");
}

function postMcpJson(mcpUrl, jsonText, sessionId) {
  return new Promise((resolve, reject) => {
    const url = new URL(mcpUrl);
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Content-Length": Buffer.byteLength(jsonText, "utf8"),
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: "POST",
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body,
          });
        });
      }
    );

    req.on("error", reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error("MCP HTTP request timeout"));
    });
    req.write(jsonText, "utf8");
    req.end();
  });
}

function startHttpBridge(mcpUrl) {
  if (bridgeStarted) return;
  bridgeStarted = true;

  let buffer = Buffer.alloc(0);
  let pendingLength = null;
  let sessionId = null;
  let queue = Promise.resolve();
  const decoder = new StringDecoder("utf8");
  let inputMode = null; // "framed" | "ndjson"

  async function handleMessage(jsonText) {
    const response = await postMcpJson(mcpUrl, jsonText, sessionId);
    const maybeSession = response.headers["mcp-session-id"];
    if (typeof maybeSession === "string" && maybeSession.length > 0) {
      sessionId = maybeSession;
    }

    const contentType = String(response.headers["content-type"] || "");
    const writeJson = inputMode === "ndjson" ? writeNdjson : writeFramedJson;
    if (contentType.includes("text/event-stream")) {
      const messages = parseSseMessages(response.body);
      for (const msg of messages) {
        writeJson(msg);
      }
      return;
    }

    const trimmed = response.body.trim();
    if (trimmed.length > 0) {
      writeJson(trimmed);
    }
  }

  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (true) {
      if (inputMode === null) {
        const snapshot = buffer.toString("utf8");
        const trimmed = snapshot.trimStart();
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
          // Some clients send plain JSON messages without explicit framing.
          // Treat as line-delimited mode and fall back to whole-buffer JSON parsing below.
          inputMode = "ndjson";
        } else if (/content-length\s*:/i.test(snapshot)) {
          inputMode = "framed";
        } else {
          break;
        }
      }

      if (inputMode === "ndjson") {
        const lf = buffer.indexOf("\n");
        if (lf === -1) {
          const maybeJson = buffer.toString("utf8").trim();
          if (maybeJson.length === 0) break;
          try {
            JSON.parse(maybeJson);
            buffer = Buffer.alloc(0);
            queue = queue
              .then(() => handleMessage(maybeJson))
              .catch((err) => {
                console.error(err);
                process.exit(1);
              });
            continue;
          } catch {
            break;
          }
        }

        const line = buffer.slice(0, lf).toString("utf8").trim();
        buffer = buffer.slice(lf + 1);
        if (line.length === 0) continue;

        queue = queue
          .then(() => handleMessage(line))
          .catch((err) => {
            console.error(err);
            process.exit(1);
          });
        continue;
      }

      if (pendingLength === null) {
        let markerIndex = buffer.indexOf("\r\n\r\n");
        let markerLength = 4;
        if (markerIndex === -1) {
          markerIndex = buffer.indexOf("\n\n");
          markerLength = 2;
        }
        if (markerIndex === -1) break;

        const headerText = buffer.slice(0, markerIndex).toString("utf8");
        const match = headerText.match(/content-length:\s*(\d+)/i);
        if (!match) {
          buffer = buffer.slice(markerIndex + markerLength);
          continue;
        }
        pendingLength = Number(match[1]);
        buffer = buffer.slice(markerIndex + markerLength);
      }

      if (buffer.length < pendingLength) break;

      const payload = buffer.slice(0, pendingLength);
      buffer = buffer.slice(pendingLength);
      pendingLength = null;
      const jsonText = decoder.write(payload);

      queue = queue
        .then(() => handleMessage(jsonText))
        .catch((err) => {
          console.error(err);
          process.exit(1);
        });
    }
  });

  process.stdin.on("end", () => {
    queue.finally(() => shutdown().catch(() => process.exit(1)));
  });
}

async function main() {
  process.on("SIGINT", () => {
    shutdown().catch(() => process.exit(1));
  });
  process.on("SIGTERM", () => {
    shutdown().catch(() => process.exit(1));
  });

  validateBindAddress();

  const resourceNames = deriveResourceNames(ROOT);
  kbVolume = resourceNames.kbVolume;
  hfCacheVolume = resourceNames.hfCacheVolume;
  containerName = resourceNames.containerName;

  const lifecycleCommand = (process.env.KB_LIFECYCLE_COMMAND || "").trim().toLowerCase();
  if (lifecycleCommand === "stop") {
    await removeContainer();
    return;
  }
  if (lifecycleCommand && !["start", "restart"].includes(lifecycleCommand)) {
    throw new Error(`Unknown KB_LIFECYCLE_COMMAND: ${lifecycleCommand}`);
  }
  if (lifecycleCommand === "restart") {
    await removeContainer();
  }

  const attachedPort = await attachToRunningContainer(containerName);
  if (attachedPort !== null) {
    if (lifecycleCommand) return;
    startHttpBridge(makeUrls(attachedPort).mcpUrl);
    return;
  }

  if (process.env.KB_ATTACH_ONLY === "1") {
    throw new Error(
      `KB container "${containerName}" is not already running and healthy; attach-only diagnostics will not start or replace it`
    );
  }

  const selectedPort = await selectPort();
  const mcpUrl = await startOrAttachContainer(selectedPort);
  if (lifecycleCommand) return;
  startHttpBridge(mcpUrl);
}

if (require.main === module) {
  main().catch(async (err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  canonicalRepositoryRoot,
  deriveResourceNames,
};
