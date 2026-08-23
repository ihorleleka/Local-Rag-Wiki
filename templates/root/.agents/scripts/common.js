const fs = require("fs");
const path = require("path");

const STATE_DIR = path.resolve(process.cwd(), ".agents", ".wiki-kit-state");
const STATE_FILE = path.join(STATE_DIR, "self-evolving.json");
const MAX_RECENT = 200;
const STOPWORDS = new Set([
  "about", "after", "again", "also", "because", "before", "between", "could", "doing",
  "from", "have", "into", "just", "like", "make", "more", "need", "should", "than",
  "that", "then", "there", "these", "this", "those", "very", "what", "when", "where",
  "which", "while", "with", "would", "your",
]);

function output(payload) {
  process.stdout.write(`${JSON.stringify(payload || {})}\n`);
}

function readStdinJson() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    process.stdin.on("error", () => resolve({}));
  });
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function extractKeywords(value) {
  const text = normalizeWhitespace(value).toLowerCase();
  const tokens = text.match(/[a-z0-9][a-z0-9_-]{3,}/g) || [];
  const unique = [];
  const seen = new Set();
  for (const token of tokens) {
    if (STOPWORDS.has(token) || seen.has(token)) continue;
    seen.add(token);
    unique.push(token);
    if (unique.length >= 12) break;
  }
  return unique;
}

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { recent: [], keywordTotals: {} };
  }
}

function writeState(state) {
  ensureStateDir();
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function updateStateWithCapture(state, capture) {
  const next = {
    recent: Array.isArray(state.recent) ? state.recent : [],
    keywordTotals:
      state.keywordTotals && typeof state.keywordTotals === "object" ? state.keywordTotals : {},
  };
  const keywords = extractKeywords(capture.prompt);
  for (const keyword of keywords) {
    next.keywordTotals[keyword] = Number(next.keywordTotals[keyword] || 0) + 1;
  }
  next.recent.unshift({
    capturedAt: new Date().toISOString(),
    prompt: normalizeWhitespace(capture.prompt).slice(0, 260),
    summary: normalizeWhitespace(capture.summary).slice(0, 260),
    keywords,
  });
  next.recent = next.recent.slice(0, MAX_RECENT);
  return next;
}

function topKeywordHints(state, limit = 8) {
  const totals =
    state.keywordTotals && typeof state.keywordTotals === "object" ? state.keywordTotals : {};
  return Object.entries(totals)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, limit)
    .map(([keyword]) => keyword);
}

function findRelevantRecent(state, prompt, limit = 3) {
  const promptWords = new Set(extractKeywords(prompt));
  if (promptWords.size === 0) return [];
  const recent = Array.isArray(state.recent) ? state.recent : [];
  const scored = [];
  for (const item of recent) {
    if (!Array.isArray(item.keywords) || item.keywords.length === 0) continue;
    let score = 0;
    for (const keyword of item.keywords) {
      if (promptWords.has(keyword)) score += 1;
    }
    if (score > 0) scored.push({ score, item });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((entry) => entry.item);
}

function trimState(state) {
  const next = {
    recent: Array.isArray(state.recent) ? state.recent.slice(0, MAX_RECENT) : [],
    keywordTotals:
      state.keywordTotals && typeof state.keywordTotals === "object" ? state.keywordTotals : {},
  };
  return next;
}

module.exports = {
  output,
  readStdinJson,
  readState,
  writeState,
  updateStateWithCapture,
  topKeywordHints,
  findRelevantRecent,
  trimState,
};
