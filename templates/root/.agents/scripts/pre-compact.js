#!/usr/bin/env node

const { output, readState, trimState, writeState } = require("./common");

function main() {
  const state = readState();
  writeState(trimState(state));
  output({ decision: "approve" });
}

main();
