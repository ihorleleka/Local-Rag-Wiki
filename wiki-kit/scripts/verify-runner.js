#!/usr/bin/env node

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SCRATCH_ROOT = path.join(ROOT, ".artifacts", "verify-runner");
const RUNNER_PATH = path.join(SCRATCH_ROOT, ".agents", "run-wiki-manager.mcp.js");
const CONTAINER_NAME = `wiki-kit-runner-test-${process.pid}`;
const KB_VOLUME = `${CONTAINER_NAME}-kb-data`;
const HF_CACHE_VOLUME = `${CONTAINER_NAME}-hf-cache`;
const FAILURE_CONTAINER_NAME = `${CONTAINER_NAME}-unhealthy`;
const FAILURE_KB_VOLUME = `${FAILURE_CONTAINER_NAME}-kb-data`;
const TIMEOUT_MS = 120000;
const { DEFAULT_IMAGE } = require(path.join(
  ROOT,
  "templates",
  "root",
  ".agents",
  "wiki-manager-contract.js"
));
const TEST_ENV = {
  ...process.env,
  KB_IMAGE: process.env.KB_IMAGE || DEFAULT_IMAGE,
  KB_CONTAINER_NAME: CONTAINER_NAME,
  KB_VOLUME,
  HF_CACHE_VOLUME,
};

function fail(message, details = "") {
  throw new Error(`${message}${details ? `\n${details}` : ""}`);
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
    fail(
      `${command} ${args.join(" ")} exited with ${result.status}`,
      `${result.stdout || ""}${result.stderr || ""}`.trim()
    );
  }
  return result.stdout.trim();
}

function cleanup() {
  spawnSync("docker", ["rm", "-f", CONTAINER_NAME, FAILURE_CONTAINER_NAME], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "ignore",
    windowsHide: true,
  });
  spawnSync("docker", ["volume", "rm", KB_VOLUME], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "ignore",
    windowsHide: true,
  });
  spawnSync("docker", ["volume", "rm", HF_CACHE_VOLUME], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "ignore",
    windowsHide: true,
  });
  spawnSync("docker", ["volume", "rm", FAILURE_KB_VOLUME], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "ignore",
    windowsHide: true,
  });
}

function prepareInstall() {
  fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
  run(process.execPath, [
    path.join(ROOT, "bin", "wiki-kit.js"),
    "install",
    SCRATCH_ROOT,
    "--force",
  ]);
}

function assertNetworkExposureGuard() {
  const result = spawnSync(process.execPath, [RUNNER_PATH], {
    cwd: SCRATCH_ROOT,
    env: {
      ...TEST_ENV,
      KB_BIND_ADDRESS: "0.0.0.0",
      KB_ALLOW_NETWORK_EXPOSURE: "",
    },
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if (result.status === 0 || !output.includes("Refusing to publish")) {
    fail("Runner did not reject non-loopback binding without explicit opt-in", output.trim());
  }
}

function assertUnhealthyStartupFailsClearly() {
  fs.writeFileSync(
    path.join(SCRATCH_ROOT, "wiki", "startup-failure-probe.md"),
    "# Startup failure probe\n\nThis forces embedding-model initialization.\n",
    "utf8"
  );
  const result = spawnSync(process.execPath, [RUNNER_PATH], {
    cwd: SCRATCH_ROOT,
    env: {
      ...TEST_ENV,
      KB_CONTAINER_NAME: FAILURE_CONTAINER_NAME,
      KB_VOLUME: FAILURE_KB_VOLUME,
      KB_EMBEDDING_MODEL: "invalid-model-for-wiki-kit-startup-verification",
      KB_HEALTH_TIMEOUT_MS: "1500",
    },
    input: `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "unhealthy-startup-verifier", version: "1.0.0" },
      },
    })}\n`,
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
    timeout: 30000,
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if (
    result.status === 0 ||
    !output.includes("did not become healthy within 1500ms")
  ) {
    fail("Unhealthy startup did not fail with the actionable timeout error", output.trim());
  }
  spawnSync("docker", ["rm", "-f", FAILURE_CONTAINER_NAME], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "ignore",
    windowsHide: true,
  });
}

function inspectBinding() {
  return JSON.parse(
    run("docker", [
      "inspect",
      CONTAINER_NAME,
      "--format",
      "{{json (index (index .NetworkSettings.Ports \"1111/tcp\") 0)}}",
    ])
  );
}

function assertRepositoryMountIsReadOnly() {
  const mounts = JSON.parse(
    run("docker", ["inspect", CONTAINER_NAME, "--format", "{{json .Mounts}}"])
  );
  const repositoryMount = mounts.find((mount) => mount.Destination === "/repository");
  if (!repositoryMount || repositoryMount.Type !== "bind" || repositoryMount.RW !== false) {
    fail("Expected /repository to be a read-only bind mount", JSON.stringify(mounts));
  }
}

function assertContainerRunning() {
  const running = run("docker", [
    "inspect",
    CONTAINER_NAME,
    "--format",
    "{{.State.Running}}",
  ]);
  if (running !== "true") fail(`Expected ${CONTAINER_NAME} to be running`);
}

function createClient(name, mode = "ndjson") {
  const child = spawn(process.execPath, [RUNNER_PATH], {
    cwd: SCRATCH_ROOT,
    env: TEST_ENV,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  let stdoutBuffer = "";
  const pending = new Map();

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    while (true) {
      let line = "";
      if (mode === "framed") {
        const marker = stdoutBuffer.indexOf("\r\n\r\n");
        if (marker === -1) break;
        const header = stdoutBuffer.slice(0, marker);
        const length = Number(header.match(/content-length:\s*(\d+)/i)?.[1]);
        if (!Number.isFinite(length) || stdoutBuffer.length < marker + 4 + length) break;
        line = stdoutBuffer.slice(marker + 4, marker + 4 + length);
        stdoutBuffer = stdoutBuffer.slice(marker + 4 + length);
      } else {
        if (!stdoutBuffer.includes("\n")) break;
        const newline = stdoutBuffer.indexOf("\n");
        line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
      }
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      clearTimeout(waiter.timeout);
      pending.delete(message.id);
      waiter.resolve(message);
    }
  });

  let exitCode = null;
  child.on("exit", (code) => {
    exitCode = code;
    for (const [id, waiter] of pending) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error(`${name} exited with ${code} waiting for response ${id}\n${stderr}`));
    }
    pending.clear();
  });

  function send(message) {
    const json = JSON.stringify(message);
    if (mode === "framed") {
      child.stdin.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`);
    } else {
      child.stdin.write(`${json}\n`);
    }
  }

  function request(id, method, params = {}) {
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${name} timed out waiting for ${method}\n${stderr}`));
      }, TIMEOUT_MS);
      pending.set(id, { resolve, reject, timeout });
    });
    send({ jsonrpc: "2.0", id, method, params });
    return response;
  }

  async function initialize() {
    const response = await request(1, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name, version: "1.0.0" },
    });
    if (!response.result?.serverInfo) {
      fail(`${name} initialize response did not include serverInfo`, JSON.stringify(response));
    }
    send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  }

  async function close() {
    if (exitCode !== null) return;
    child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        resolve();
      }, 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (exitCode !== 0) fail(`${name} exited with ${exitCode}`, stderr);
  }

  return { request, initialize, close };
}

function assertToolCallSucceeded(response, toolName) {
  if (response.error || !response.result || response.result.isError) {
    fail(`${toolName} failed`, JSON.stringify(response));
  }
}

async function main() {
  cleanup();
  prepareInstall();
  assertNetworkExposureGuard();
  assertUnhealthyStartupFailsClearly();

  const clientA = createClient("wiki-kit-runner-verifier-a");
  const clientB = createClient("wiki-kit-runner-verifier-b");
  const framedClient = createClient("wiki-kit-runner-verifier-framed", "framed");

  try {
    // Both clients initialize concurrently against a repository with no container.
    const initializationStarted = Date.now();
    await Promise.all([clientA.initialize(), clientB.initialize()]);
    const coldInitializationSeconds = (Date.now() - initializationStarted) / 1000;
    if (coldInitializationSeconds >= 75) {
      fail(
        `Cold initialization took ${coldInitializationSeconds.toFixed(2)}s, exceeding the generated 75s timeout`
      );
    }

    const binding = inspectBinding();
    if (binding.HostIp !== "127.0.0.1") {
      fail(`Expected Docker HostIp 127.0.0.1, received ${binding.HostIp || "<empty>"}`);
    }
    assertRepositoryMountIsReadOnly();
    const status = run(
      process.execPath,
      [path.join(ROOT, "bin", "wiki-kit.js"), "status", SCRATCH_ROOT],
      { env: TEST_ENV }
    );
    if (!status.includes("Image configuration: override")) {
      fail("Wiki-Kit status did not identify explicit KB_IMAGE configuration");
    }
    if (!status.includes("Compatibility: current")) {
      fail("Wiki-Kit status did not classify the pinned running image as current", status);
    }
    const doctor = run(
      process.execPath,
      [path.join(ROOT, "bin", "wiki-kit.js"), "doctor", SCRATCH_ROOT, "--live"],
      { env: TEST_ENV }
    );
    for (const expected of [
      "[ok] Docker daemon is reachable",
      "[ok] container is bound to loopback",
      "[ok] service, index schema, and MCP tool contract are compatible",
      "[ok] service health endpoint is ready",
      "[ok] MCP handshake and read-only tool call succeed",
    ]) {
      if (!doctor.includes(expected)) fail(`Live doctor did not report ${expected}`, doctor);
    }

    await framedClient.initialize();
    const framedTools = await framedClient.request(2, "tools/list");
    if (!Array.isArray(framedTools.result?.tools) || framedTools.result.tools.length === 0) {
      fail("Framed MCP tools/list returned no tools", JSON.stringify(framedTools));
    }
    await framedClient.close();

    await clientA.close();
    assertContainerRunning();

    const tools = await clientB.request(2, "tools/list");
    if (!Array.isArray(tools.result?.tools) || tools.result.tools.length === 0) {
      fail("MCP tools/list returned no tools", JSON.stringify(tools));
    }
    const toolNames = new Set(tools.result.tools.map((tool) => tool.name));
    for (const required of ["wiki_list", "wiki_search"]) {
      if (!toolNames.has(required)) fail(`MCP tools/list did not include ${required}`);
    }

    const listResult = await clientB.request(3, "tools/call", {
      name: "wiki_list",
      arguments: {},
    });
    assertToolCallSucceeded(listResult, "wiki_list");

    const searchResult = await clientB.request(4, "tools/call", {
      name: "wiki_search",
      arguments: { query: "wiki-kit multi-client lifecycle verification" },
    });
    assertToolCallSucceeded(searchResult, "wiki_search");

    await clientB.close();
    assertContainerRunning();

    const lifecycleArgs = [path.join(ROOT, "bin", "wiki-kit.js")];
    run("docker", ["stop", CONTAINER_NAME]);
    run(process.execPath, [...lifecycleArgs, "start", SCRATCH_ROOT], { env: TEST_ENV });
    assertContainerRunning();
    run(process.execPath, [...lifecycleArgs, "restart", SCRATCH_ROOT], { env: TEST_ENV });
    assertContainerRunning();
    run(process.execPath, [...lifecycleArgs, "stop", SCRATCH_ROOT], { env: TEST_ENV });
    const remaining = spawnSync("docker", ["inspect", CONTAINER_NAME], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: "pipe",
      windowsHide: true,
    });
    if (remaining.status === 0) fail("wiki-kit stop left the repository container present");

    console.log(
      `verify-runner: ok (${binding.HostIp}:${binding.HostPort}, cold init ${coldInitializationSeconds.toFixed(2)}s, two clients, lifecycle commands)`
    );
  } finally {
    await clientA.close().catch(() => {});
    await clientB.close().catch(() => {});
    await framedClient.close().catch(() => {});
    cleanup();
  }
}

main().catch((error) => {
  cleanup();
  console.error(`verify-runner: ${error.message}`);
  process.exit(1);
});

