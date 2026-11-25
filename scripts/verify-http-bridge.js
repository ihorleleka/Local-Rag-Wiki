#!/usr/bin/env node
"use strict";

// Docker-free regression tests for the HTTP portion of the stdio MCP bridge.
// Run: node scripts/verify-http-bridge.js
const assert = require("node:assert/strict");
const http = require("node:http");
const { performance } = require("node:perf_hooks");
const {
  createMcpMessageHandler,
} = require("../templates/root/.agents/run-wiki-manager.mcp.js");

const initialize = {
  jsonrpc: "2.0", id: "client-initialize", method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "http-bridge-test", version: "1" } },
};
const rpc = (id, method = "tools/list") => ({ jsonrpc: "2.0", id, method });
const reply = (res, request, result = { ok: true }) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
};
const expire = (res) => {
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: "server-error", error: { code: -32000, message: "Session not found" } }));
};
function initialized(res, request, session, version = "2025-06-18") {
  res.setHeader("mcp-session-id", session);
  reply(res, request, { protocolVersion: version, capabilities: {}, serverInfo: { name: "mock", version: "1" } });
}
async function bounded(promise, ms = 2500) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Test operation exceeded ${ms}ms`)), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}
async function withBridge(responder, test, options = {}) {
  const requests = [];
  const output = [];
  const failures = [];
  const timers = new Set();
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try {
        const message = JSON.parse(body);
        const record = { message, headers: req.headers, raw: body };
        requests.push(record);
        responder(record, res, { timers, requests });
      } catch (error) {
        failures.push(error);
        res.destroy();
      }
    });
    req.on("error", () => {});
  });
  server.on("connection", socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const handler = createMcpMessageHandler(
    `http://127.0.0.1:${server.address().port}/mcp/`,
    text => output.push(JSON.parse(text)),
    { timeoutMs: 500, ...options },
  );
  const send = message => bounded(handler(JSON.stringify(message)));
  try {
    await test({ send, output, requests });
    assert.deepEqual(failures, [], "mock server assertions must pass");
  } finally {
    for (const timer of timers) { clearTimeout(timer); clearInterval(timer); }
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    for (const socket of sockets) socket.destroy();
    await bounded(closed);
  }
}
function assertError(output, id) {
  assert.equal(output.length, 1, "exactly one correlated response");
  assert.equal(output[0].id, id);
  assert.equal(output[0].jsonrpc, "2.0");
  assert.equal(output[0].error?.code, -32000);
  assert.equal(typeof output[0].error.message, "string");
  assert.ok(output[0].error.message.length > 0);
}
const tests = [];
const test = (name, run) => tests.push({ name, run });

test("initialize cache, negotiated version, repeated private renewal, ID zero", async () => {
  let generation = 0;
  const attempts = new Map();
  await withBridge(({ message, headers }, res) => {
    if (message.method === "initialize") {
      assert.equal(headers["mcp-session-id"], undefined, "initialize must not send stale session");
      assert.deepEqual(message, initialize, "renewal reuses original client initialization");
      generation += 1;
      initialized(res, message, `session-${generation}`, `negotiated-${generation}`);
    } else if (message.method === "notifications/initialized") {
      assert.equal(headers["mcp-session-id"], `session-${generation}`);
      assert.equal(headers["mcp-protocol-version"], `negotiated-${generation}`);
      res.writeHead(202); res.end();
    } else {
      assert.equal(headers["mcp-session-id"], `session-${generation}`);
      assert.equal(headers["mcp-protocol-version"], `negotiated-${generation}`);
      const count = (attempts.get(message.id) || 0) + 1;
      attempts.set(message.id, count);
      if (count === 1) expire(res);
      else reply(res, message, { generation });
    }
  }, async ({ send, output, requests }) => {
    await send(initialize);
    assert.equal(output.length, 1);
    assert.equal(output[0].result.protocolVersion, "negotiated-1");
    output.length = 0;
    for (const id of [0, "second-expiration"]) {
      const original = { ...rpc(id, "tools/call"), params: { name: "wiki_write", arguments: { text: "exact original" } } };
      const start = requests.length;
      await send(original);
      assert.deepEqual(output, [{ jsonrpc: "2.0", id, result: { generation } }]);
      const exchange = requests.slice(start);
      assert.deepEqual(exchange.map(item => item.message.method), ["tools/call", "initialize", "notifications/initialized", "tools/call"]);
      assert.equal(exchange[0].raw, exchange[3].raw, "retry original exactly once and unchanged");
      output.length = 0;
    }
    assert.equal(generation, 3);
    assert.deepEqual([...attempts.values()], [2, 2]);
  });
});

for (const failure of ["renewal-http", "renewal-rpc", "second-404"]) {
  test(`${failure}: correlated error, bounded replay, next call succeeds`, async () => {
    let initializations = 0;
    let badAttempts = 0;
    await withBridge(({ message, headers }, res) => {
      if (message.method === "initialize") {
        assert.equal(headers["mcp-session-id"], undefined);
        initializations += 1;
        if (initializations === 2 && failure === "renewal-http") {
          res.writeHead(500); res.end("renewal unavailable");
        } else if (initializations === 2 && failure === "renewal-rpc") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "no renewal" } }));
        } else initialized(res, message, `s-${initializations}`);
      } else if (message.method === "notifications/initialized") {
        res.writeHead(202); res.end();
      } else if (message.id === "expired") {
        badAttempts += 1; expire(res);
      } else {
        assert.equal(initializations, 3, "next request privately reinitializes after failed renewal or second 404");
        assert.equal(headers["mcp-session-id"], "s-3");
        assert.equal(headers["mcp-protocol-version"], "2025-06-18");
        reply(res, message);
      }
    }, async ({ send, output }) => {
      await send(initialize); output.length = 0;
      await send(rpc("expired"));
      assertError(output, "expired");
      assert.equal(initializations, 2, "no recursive renewal loop");
      assert.equal(badAttempts, failure === "second-404" ? 2 : 1);
      output.length = 0;
      await send(rpc("healthy"));
      assert.deepEqual(output, [{ jsonrpc: "2.0", id: "healthy", result: { ok: true } }]);
    });
  });
}

for (const failure of ["http500", "mismatched-id", "invalid-json"]) {
  test(`${failure}: correlated error and next call succeeds`, async () => {
    await withBridge(({ message }, res) => {
      if (message.id === "bad") {
        res.writeHead(failure === "http500" ? 500 : 200, { "content-type": "application/json" });
        res.end(failure === "invalid-json" ? "{not JSON" : JSON.stringify({ jsonrpc: "2.0", id: "server-error", result: { wrong: true } }));
      } else reply(res, message);
    }, async ({ send, output, requests }) => {
      await send(rpc("bad"));
      assertError(output, "bad");
      output.length = 0;
      await send(rpc("next"));
      assert.deepEqual(output, [{ jsonrpc: "2.0", id: "next", result: { ok: true } }]);
      assert.equal(requests.length, 2, "HTTP and payload failures must not replay requests");
    });
  });
}

test("ambiguous mutation connection failure is never replayed", async () => {
  await withBridge(({ message }, res) => {
    if (message.method === "initialize") initialized(res, message, "mutation-session");
    else if (message.id === "mutation") res.socket.destroy();
    else reply(res, message);
  }, async ({ send, output, requests }) => {
    await send(initialize); output.length = 0;
    await send({ ...rpc("mutation", "tools/call"), params: { name: "wiki_write", arguments: { text: "do not duplicate" } } });
    assertError(output, "mutation");
    assert.equal(requests.filter(item => item.message.id === "mutation").length, 1);
    assert.equal(requests.filter(item => item.message.method === "initialize").length, 1);
    output.length = 0;
    await send(rpc("after-mutation"));
    assert.equal(output[0].result.ok, true);
  });
});

for (const failure of ["sse-keepalive", "response-abort"]) {
  test(`${failure}: queued next request recovers`, async () => {
    let responseClosed = false;
    await withBridge(({ message }, res, { timers }) => {
      if (message.id !== "stalled") return reply(res, message);
      res.on("close", () => { responseClosed = true; });
      if (failure === "sse-keepalive") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": first keepalive\n\n");
        const timer = setInterval(() => res.write(": keepalive\n\n"), 10);
        timers.add(timer);
        res.on("close", () => { clearInterval(timer); timers.delete(timer); });
      } else {
        res.writeHead(200, { "content-type": "application/json", "content-length": "2000" });
        res.write('{"jsonrpc":"2.0",');
        const timer = setTimeout(() => res.destroy(), 20);
        timers.add(timer);
      }
    }, async ({ send, output, requests }) => {
      const start = performance.now();
      // Mirrors the serialized Promise chain in startHttpBridge, including a
      // second request queued before the stalled first response completes.
      let queue = Promise.resolve();
      queue = queue.then(() => send(rpc("stalled", "tools/call")));
      queue = queue.then(() => send(rpc("queued-next")));
      await bounded(queue);
      const elapsed = performance.now() - start;
      assert.equal(output.length, 2);
      assertError([output[0]], "stalled");
      assert.deepEqual(output[1], { jsonrpc: "2.0", id: "queued-next", result: { ok: true } });
      assert.deepEqual(requests.map(item => item.message.id), ["stalled", "queued-next"]);
      assert.ok(elapsed < 1500, `unfinished response must be bounded, took ${elapsed}ms`);
      if (failure === "sse-keepalive") {
        assert.ok(elapsed >= 60, `absolute timeout fired too early: ${elapsed}ms`);
        assert.match(output[0].error.message, /timeout/i);
      }
      assert.equal(responseClosed, true, "failed response connection must close");
    }, { timeoutMs: 100 });
  });
}

test("SSE batch preserves server requests and notifications, filters unrelated replies", async () => {
  const serverRequest = { jsonrpc: "2.0", id: "server-question", method: "sampling/createMessage", params: {} };
  const notification = { jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "hello" } };
  const unrelated = { jsonrpc: "2.0", id: "wrong-id", result: { wrong: true } };
  const correlated = { jsonrpc: "2.0", id: "batch", result: { ok: true } };
  await withBridge((_, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end([serverRequest, notification, unrelated, correlated].map(message => `data: ${JSON.stringify(message)}\n\n`).join(""));
  }, async ({ send, output }) => {
    await send(rpc("batch"));
    assert.deepEqual(output, [serverRequest, notification, correlated]);
  });
});

test("deferred renewal suppresses duplicate initialized notification", async () => {
  let initializations = 0;
  let notifications = 0;
  await withBridge(({ message }, res) => {
    if (message.method === "initialize") {
      initializations += 1;
      if (initializations === 2) { res.writeHead(500); res.end("transient renewal failure"); }
      else initialized(res, message, `s-${initializations}`);
    } else if (message.method === "notifications/initialized") {
      notifications += 1;
      res.writeHead(202); res.end();
    } else expire(res);
  }, async ({ send, output }) => {
    await send(initialize); output.length = 0;
    await send(rpc("expired"));
    assertError(output, "expired"); output.length = 0;
    await send({ jsonrpc: "2.0", method: "notifications/initialized" });
    assert.deepEqual(output, []);
    assert.equal(initializations, 3);
    assert.equal(notifications, 1, "private renewal already delivered initialized");
  });
});

test("expired initialized notification renews once without duplicate or output", async () => {
  let initializations = 0;
  let notifications = 0;
  await withBridge(({ message }, res) => {
    if (message.method === "initialize") initialized(res, message, `s-${++initializations}`);
    else if (message.method === "notifications/initialized") {
      notifications += 1;
      if (notifications === 1) expire(res);
      else { res.writeHead(202); res.end(); }
    } else reply(res, message);
  }, async ({ send, output }) => {
    await send(initialize); output.length = 0;
    await send({ jsonrpc: "2.0", method: "notifications/initialized" });
    assert.deepEqual(output, []);
    assert.equal(initializations, 2);
    assert.equal(notifications, 2);
    await send(rpc("after-notification"));
    assert.equal(output[0].result.ok, true);
  });
});

// --- Lazy initialization: static manifest answers, queued calls, deadline, retry ---
const manifestModule = require("../templates/root/.agents/wiki-manager-manifest.js");
const { createWarmingHandler } = require("../templates/root/.agents/run-wiki-manager.mcp.js");

async function withWarming(test, { warmupTimeoutMs = 2000 } = {}) {
  const requests = [];
  const output = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const message = JSON.parse(body);
      requests.push(message);
      if (message.method === "initialize") initialized(res, message, "warm-session");
      else if (message.method === "notifications/initialized") { res.writeHead(202); res.end(); }
      else reply(res, message, { served: message.method, id: message.id });
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/mcp/`;
  const gate = { calls: 0, resolve: null, reject: null };
  const warmUp = () => {
    gate.calls += 1;
    return new Promise((resolve, reject) => {
      gate.resolve = () => resolve(url);
      gate.reject = error => reject(error);
    });
  };
  const handler = createWarmingHandler(warmUp, text => output.push(JSON.parse(text)), {
    warmupTimeoutMs, bridgeOptions: { timeoutMs: 500 },
  });
  const until = async (predicate, ms = 2000) => {
    const started = Date.now();
    while (!predicate()) {
      if (Date.now() - started > ms) throw new Error("condition not met in time");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  try {
    await test({ handler, output, requests, gate, until, send: message => handler.handle(JSON.stringify(message)) });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
const toolCall = (id, name = "wiki_list", args = {}) => ({ ...rpc(id, "tools/call"), params: { name, arguments: args } });

test("lazy init: initialize, ping and tools/list answer before the container is ready", async () => {
  await withWarming(async ({ handler, output, requests, send, gate }) => {
    handler.begin();
    await send(initialize);
    await send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await send(rpc("ping-1", "ping"));
    await send(rpc("tools", "tools/list"));
    assert.equal(gate.calls, 1, "warm-up started exactly once");
    assert.equal(requests.length, 0, "nothing reached the service yet");
    assert.equal(output[0].id, "client-initialize");
    assert.equal(output[0].result.serverInfo.name, manifestModule.SERVER_INFO.name);
    assert.ok(output[0].result.capabilities.tools);
    assert.equal(output[0].result.protocolVersion, "2025-03-26");
    assert.deepEqual(output[1], { jsonrpc: "2.0", id: "ping-1", result: {} });
    assert.deepEqual(output[2].result.tools.map(t => t.name), manifestModule.TOOLS.map(t => t.name));
    assert.ok(output[2].result.tools.every(t => t.inputSchema?.type === "object"));
  });
});

test("lazy init: a tool call queues until ready, then replays the handshake once", async () => {
  await withWarming(async ({ handler, output, requests, send, gate, until }) => {
    handler.begin();
    await send(initialize);
    await send({ jsonrpc: "2.0", method: "notifications/initialized" });
    output.length = 0;
    const pending = send(toolCall("queued"));
    await pending;
    assert.equal(output.length, 0, "no answer while warming");
    gate.resolve();
    await until(() => output.length === 1);
    assert.deepEqual(output, [{ jsonrpc: "2.0", id: "queued", result: { served: "tools/call", id: "queued" } }]);
    assert.deepEqual(requests.map(r => r.method), ["initialize", "notifications/initialized", "tools/call"]);
    assert.equal(requests.filter(r => r.method === "initialize").length, 1);
    await send(toolCall("direct"));
    await until(() => output.length === 2);
    assert.equal(output[1].id, "direct");
    assert.equal(handler.getPhase(), "ready");
  });
});

test("lazy init: past the deadline a call gets a clear warming-up error and a later call succeeds", async () => {
  await withWarming(async ({ handler, output, send, gate, until }) => {
    handler.begin();
    await send(initialize);
    await send({ jsonrpc: "2.0", method: "notifications/initialized" });
    output.length = 0;
    await send(toolCall("slow"));
    await until(() => output.length === 1);
    assert.equal(output[0].id, "slow");
    assert.equal(output[0].result.isError, true, "tool errors are reported as tool results");
    const text = output[0].result.content[0].text;
    assert.match(text, /warming up/);
    assert.match(text, /do not fall back to local-file mode silently/);
    assert.match(text, /KB_LIFECYCLE_COMMAND=start node /);
    assert.match(text, /new session/);
    gate.resolve();
    await until(() => handler.getPhase() === "ready");
    output.length = 0;
    await send(toolCall("after"));
    await until(() => output.length === 1);
    assert.equal(output[0].result.served, "tools/call");
  }, { warmupTimeoutMs: 80 });
});

test("lazy init: a failed warm-up reports recovery guidance and the next call retries", async () => {
  await withWarming(async ({ handler, output, send, gate, until }) => {
    handler.begin();
    await send(initialize);
    await send({ jsonrpc: "2.0", method: "notifications/initialized" });
    output.length = 0;
    await send(toolCall("first"));
    gate.reject(new Error("Docker Desktop's Linux engine is unavailable."));
    await until(() => output.length === 1);
    const text = output[0].result.content[0].text;
    assert.match(text, /could not start: Docker Desktop's Linux engine is unavailable/);
    assert.match(text, /npx github:ihorleleka\/Local-Rag-Wiki start \./);
    output.length = 0;
    await send(toolCall("retry"));
    await until(() => gate.calls === 2);
    assert.equal(gate.calls, 2, "the next call starts a fresh warm-up");
    gate.resolve();
    await until(() => output.length === 1);
    assert.equal(output[0].id, "retry");
    assert.equal(output[0].result.served, "tools/call");
  });
});

test("lazy init: a service that rejects the replayed initialize counts as a failed warm-up", async () => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const message = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "nope" } }));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const output = [];
  const handler = createWarmingHandler(
    async () => `http://127.0.0.1:${server.address().port}/mcp/`,
    text => output.push(JSON.parse(text)),
    { warmupTimeoutMs: 1000, bridgeOptions: { timeoutMs: 500 } },
  );
  try {
    await handler.handle(JSON.stringify(initialize));
    await handler.handle(JSON.stringify(toolCall("x")));
    await handler.idle();
    const last = output[output.length - 1];
    assert.equal(last.id, "x");
    assert.match(last.result.content[0].text, /service rejected initialize/);
    assert.equal(handler.getPhase(), "failed");
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

(async () => {
  let failed = 0;
  const started = performance.now();
  for (const { name, run } of tests) {
    try {
      await run();
      console.log(`PASS ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${name}\n${error.stack || error}`);
    }
  }
  console.log(`${tests.length - failed}/${tests.length} HTTP bridge tests passed (${Math.round(performance.now() - started)}ms); loopback only, no Docker.`);
  if (failed) process.exitCode = 1;
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
