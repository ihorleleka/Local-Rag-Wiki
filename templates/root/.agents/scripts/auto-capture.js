#!/usr/bin/env node

const { output, readStdinJson, readState, updateStateWithCapture, writeState } = require("./common");

function pickPrompt(input) {
  return (
    input.prompt ||
    input.user_prompt ||
    input.last_user_message ||
    input.message ||
    ""
  );
}

function pickSummary(input) {
  return (
    input.last_assistant_message ||
    input.assistant_message ||
    input.summary ||
    ""
  );
}

async function main() {
  const input = await readStdinJson();
  const prompt = pickPrompt(input);
  const summary = pickSummary(input);
  if (!String(prompt || "").trim()) {
    output({ decision: "approve" });
    return;
  }
  const state = readState();
  const next = updateStateWithCapture(state, { prompt, summary });
  writeState(next);
  output({ decision: "approve" });
}

main().catch(() => output({ decision: "approve" }));
