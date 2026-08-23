#!/usr/bin/env node

const { output, readStdinJson, readState, findRelevantRecent } = require("./common");

function pickPrompt(input) {
  return (
    input.prompt ||
    input.user_prompt ||
    input.message ||
    ""
  );
}

function buildAdditionalContext(prompt) {
  const state = readState();
  const matches = findRelevantRecent(state, prompt, 3);
  if (matches.length === 0) return "";
  return [
    '<wiki-kit-context source="self-evolving-hooks" stage="prompt-recall">',
    "Relevant prior execution patterns:",
    ...matches.map((item) => `- ${item.prompt}${item.summary ? ` -> ${item.summary}` : ""}`),
    "Treat this as advisory context; confirm with current code and wiki evidence.",
    "</wiki-kit-context>",
  ].join("\n");
}

async function main() {
  const input = await readStdinJson();
  const prompt = pickPrompt(input);
  if (!String(prompt || "").trim()) {
    output({ decision: "approve" });
    return;
  }
  const additionalContext = buildAdditionalContext(prompt);
  if (!additionalContext) {
    output({ decision: "approve" });
    return;
  }
  output({
    decision: "approve",
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    },
  });
}

main().catch(() => output({ decision: "approve" }));
