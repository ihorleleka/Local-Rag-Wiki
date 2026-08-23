#!/usr/bin/env node

const path = require("path");
const { output, readStdinJson, readState, findRelevantRecent } = require("./common");

function extractToolName(input) {
  return String(input.tool_name || input.toolName || input.name || input.tool || "").trim();
}

function extractReadPath(input) {
  return (
    input.tool_input?.file_path ||
    input.tool_input?.path ||
    input.toolInput?.file_path ||
    input.toolInput?.path ||
    input.file_path ||
    input.path ||
    ""
  );
}

function isKnowledgePolicyRead(targetPath) {
  const normalized = String(targetPath || "").replace(/\\/g, "/");
  if (!normalized) return false;
  if (normalized.endsWith("/AGENTS.md")) return true;
  if (normalized.endsWith("/SKILL.md")) return true;
  return normalized.includes("/wiki/");
}

async function main() {
  const input = await readStdinJson();
  const toolName = extractToolName(input);
  if (toolName && toolName !== "Read") {
    output({ decision: "approve" });
    return;
  }
  const readPath = String(extractReadPath(input) || "");
  if (!isKnowledgePolicyRead(readPath)) {
    output({ decision: "approve" });
    return;
  }
  const state = readState();
  const fileHint = path.basename(readPath).replace(/\.[^.]+$/, "");
  const matches = findRelevantRecent(state, fileHint, 2);
  if (matches.length === 0) {
    output({ decision: "approve" });
    return;
  }
  const additionalContext = [
    '<wiki-kit-context source="skill-experience" format="digest">',
    "Related prior implementation context:",
    ...matches.map((entry) => `- ${entry.prompt}${entry.summary ? ` -> ${entry.summary}` : ""}`),
    "Treat as advisory; verify against current repository state.",
    "</wiki-kit-context>",
  ].join("\n");
  output({
    decision: "approve",
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext,
    },
  });
}

main().catch(() => output({ decision: "approve" }));
