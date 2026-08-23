#!/usr/bin/env node

const { output, readState, topKeywordHints } = require("./common");

function buildAdditionalContext() {
  const state = readState();
  const topHints = topKeywordHints(state, 6);
  if (topHints.length === 0) return "";
  return [
    '<wiki-kit-context source="self-evolving-hooks" stage="session-start">',
    "High-signal recurring topics from prior work:",
    ...topHints.map((hint) => `- ${hint}`),
    "Orient with wiki_tree, scan with wiki_search depth=\"abstract\", then validate with wiki_read before reusing prior assumptions.",
    "</wiki-kit-context>",
  ].join("\n");
}

function main() {
  const additionalContext = buildAdditionalContext();
  if (!additionalContext) {
    output({ decision: "approve" });
    return;
  }
  output({
    decision: "approve",
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext,
    },
  });
}

main();
