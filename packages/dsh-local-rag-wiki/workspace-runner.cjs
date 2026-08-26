#!/usr/bin/env node

/**
 * Profile-installed DSH plugins run outside an individual repository package.
 * This tiny stdio-preserving launcher finds wiki-kit's marker in the current
 * workspace, then delegates all MCP traffic to that workspace's managed runner.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const MARKER_FILE = '.wiki-kit-install.json';
const RUNNER_FILE = 'run-wiki-manager.mcp.js';

function findAgentsRoot(workspace) {
  for (const entry of fs.readdirSync(workspace, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(workspace, entry.name);
    if (fs.existsSync(path.join(candidate, MARKER_FILE))) return candidate;
  }
  return null;
}

function main() {
  const workspace = process.cwd();
  const agentsRoot = findAgentsRoot(workspace);
  if (!agentsRoot) {
    throw new Error(
      `Local-Rag-Wiki is not installed in this workspace (${workspace}). ` +
      'Run `npx github:ihorleleka/Local-Rag-Wiki install .` first.'
    );
  }

  const runner = path.join(agentsRoot, RUNNER_FILE);
  if (!fs.existsSync(runner)) {
    throw new Error(`Local-Rag-Wiki MCP runner is missing: ${runner}`);
  }

  const child = spawn(process.execPath, [runner], {
    cwd: workspace,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  child.on('error', error => {
    process.stderr.write(`Failed to start Local-Rag-Wiki MCP runner: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.on('exit', code => {
    process.exitCode = code ?? 1;
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { findAgentsRoot };
