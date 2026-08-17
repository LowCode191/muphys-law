#!/usr/bin/env node
// muphys-law — lessons register core + MCP stdio server.
//
// A lessons register is an append-only JSONL file of operational lessons
// ("what burned us and what to do instead"), plus four small tools:
//
//   lessons_query      search the register (lexical scorer, telemetry-logged)
//   lessons_apply      declare that lessons influenced a task (+ outcome)
//   lessons_candidate  submit a new lesson for curation
//   lessons_supersede  retire lessons by judgment (curator-only; never deletes)
//
// Run `node lib/register.cjs` to serve these over MCP stdio, or use the
// exported functions directly (the CLI in bin/muphys.mjs does).
//
// Design invariants, learned the hard way (see eval/PROTOCOL.md):
//   - Every record carries an explicit `id` at write time. Synthesized,
//     position-dependent ids break every downstream reference the first time
//     someone deduplicates the file.
//   - Records are never deleted. Retirement is a status (`superseded` /
//     `deprecated`) with a pointer to the replacement; queries filter it.
//   - Every query is logged server-side (query, returned ids, ranks, scores,
//     caller). Retrieval you can't observe is retrieval you can't improve.
//   - Failure mode of telemetry is silence, so telemetry writes never throw.

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

// ---------------------------------------------------------------------------
// Paths — everything lives under MUPHYS_HOME (default ~/.muphys), individually
// overridable for embedding into an existing data layout.
// ---------------------------------------------------------------------------
const MUPHYS_HOME = path.resolve(process.env.MUPHYS_HOME || path.join(os.homedir(), ".muphys"));
const p = (envName, fallback) => path.resolve(process.env[envName] || path.join(MUPHYS_HOME, fallback));
const REGISTER_JSONL = p("MUPHYS_REGISTER", "lessons.jsonl");
const USAGE_JSONL = p("MUPHYS_USAGE_LOG", "usage.jsonl");
const CANDIDATES_JSONL = p("MUPHYS_CANDIDATES", "candidates.jsonl");
const QUERIES_JSONL = p("MUPHYS_QUERY_LOG", "queries.jsonl");
const PROJECTS_JSON = p("MUPHYS_PROJECTS", "projects.json");

const APPLY_OUTCOMES = new Set(["worked", "partial", "failed", "unknown"]);
const MAX_TEXT_CHARS = 240000;

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------
function ensureSafeText(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  if (value.length > MAX_TEXT_CHARS) throw new Error(`${field} exceeds ${MAX_TEXT_CHARS} characters`);
  return value.replace(/\r\n/g, "\n");
}

function safeSlug(value, fallback = "x") {
  const slug = String(value || fallback).trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
  return slug || fallback;
}

function assertDate(value, field = "date") {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${field} must be YYYY-MM-DD`);
  return value;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function appendLine(filePath, line) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, line.endsWith("\n") ? line : line + "\n", { mode: 0o600 });
}

function atomicReplace(filePath, content) {
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

// ---------------------------------------------------------------------------
// Register read + scoring (the scorer used in the published behavioral trial)
// ---------------------------------------------------------------------------
function readRegister() {
  if (!fs.existsSync(REGISTER_JSONL)) return [];
  const lessons = [];
  const lines = fs.readFileSync(REGISTER_JSONL, "utf8").split("\n");
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const parsed = JSON.parse(line);
      // Legacy rows without an id get a stable synthesized one — but every
      // WRITER in this package stamps explicit ids, so this is read-side
      // compatibility only.
      if (typeof parsed.id !== "string" || !parsed.id.trim()) {
        const basis = [parsed.author || "", parsed.timestamp || "", parsed.title || "", parsed.description || "", index].join("|");
        parsed.id = `ll-${crypto.createHash("sha1").update(basis).digest("hex").slice(0, 12)}`;
      }
      lessons.push(parsed);
    } catch {
      // malformed historical line — ignored on read, preserved on disk
    }
  });
  return lessons;
}

function activeLessons() {
  return readRegister().filter((l) => l.status !== "superseded" && l.status !== "deprecated");
}

function normalizeSearchText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Lexical token-overlap scorer — the retriever measured in the A1 retrieval
// benchmark (its paraphrase recall is the documented weak link; the A2
// behavioral trial injected scenario-mapped lessons directly, so A2 tested
// delivery, not this scorer's selection). If you swap in BM25/embeddings,
// keep the interface and re-run both eval tracks.
function scoreLessonForQuery(lesson, query, tags) {
  const normalizedQuery = normalizeSearchText(query);
  const queryTerms = normalizedQuery ? normalizedQuery.split(/\s+/).filter((t) => t.length > 2) : [];
  const haystack = normalizeSearchText([
    lesson.title,
    lesson.description,
    lesson.author,
    Array.isArray(lesson.tags) ? lesson.tags.join(" ") : "",
  ].join(" "));
  let score = 0;
  for (const term of queryTerms) {
    if (haystack.includes(term)) score += 2;
  }
  if (normalizedQuery && haystack.includes(normalizedQuery)) score += 6;
  const lessonTags = new Set(Array.isArray(lesson.tags) ? lesson.tags.map((t) => normalizeSearchText(t)) : []);
  for (const tag of tags) {
    if (lessonTags.has(normalizeSearchText(tag))) score += 4;
  }
  if (!queryTerms.length && !tags.length) score = 1;
  return score;
}

function compactLesson(lesson, score = 0) {
  const fullDescription = String(lesson.description || "");
  const truncated = fullDescription.length > 900;
  return {
    id: lesson.id,
    title: lesson.title || "Untitled lesson",
    // Truncation is explicit: silent mid-sentence cuts were observed removing
    // the actionable rule from results.
    description: truncated ? fullDescription.slice(0, 900) + " …[truncated]" : fullDescription,
    truncated,
    author: lesson.author || null,
    timestamp: lesson.timestamp || null,
    status: lesson.status || "active",
    project: lesson.project || null,
    evidence: Array.isArray(lesson.evidence) ? lesson.evidence.slice(0, 8) : [],
    tags: Array.isArray(lesson.tags) ? lesson.tags.slice(0, 12) : [],
    score,
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
function handleQuery(args, meta = {}) {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const tags = Array.isArray(args.tags) ? args.tags.filter(Boolean).map(String).slice(0, 12) : [];
  const limit = Math.max(1, Math.min(Number(args.limit || 8) || 8, 20));
  const all = activeLessons();
  const scored = all
    .map((lesson) => ({ lesson, score: scoreLessonForQuery(lesson, query, tags) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return String(b.lesson.timestamp || "").localeCompare(String(a.lesson.timestamp || ""));
    })
    .slice(0, limit)
    .map((item) => compactLesson(item.lesson, item.score));
  try {
    appendLine(QUERIES_JSONL, JSON.stringify({
      id: `q-${crypto.randomUUID()}`,
      ts: new Date().toISOString(),
      caller: meta.caller || null,
      surface: meta.surface || null,
      query: query.slice(0, 500),
      argumentless: !query && !tags.length,
      tags,
      limit,
      registerSize: all.length,
      count: scored.length,
      results: scored.map((l, i) => ({ id: l.id, rank: i + 1, score: l.score })),
    }));
  } catch { /* telemetry only */ }
  return { query, tags, count: scored.length, source: REGISTER_JSONL, lessons: scored };
}

function handleApply(args, meta = {}) {
  const lessonIds = Array.isArray(args.lessonIds) ? args.lessonIds.filter(Boolean).map(String).slice(0, 30) : [];
  if (!lessonIds.length) throw new Error("lessonIds array is required");
  const task = ensureSafeText(args.task || "unspecified task", "task").trim().slice(0, 500);
  let outcome = null;
  if (args.outcome !== undefined && args.outcome !== null && args.outcome !== "") {
    outcome = String(args.outcome).trim().toLowerCase();
    if (!APPLY_OUTCOMES.has(outcome)) throw new Error(`outcome must be one of: ${[...APPLY_OUTCOMES].join(", ")}`);
  }
  const entry = {
    id: `use-${crypto.randomUUID()}`,
    ts: new Date().toISOString(),
    caller: meta.caller || (typeof args.agent === "string" ? args.agent.slice(0, 64) : null),
    task,
    lessonIds,
    rationale: typeof args.rationale === "string" ? args.rationale.trim().slice(0, 1000) : "",
    outcome,
    outcomeNote: typeof args.outcomeNote === "string" ? args.outcomeNote.trim().slice(0, 500) : null,
  };
  if (args.dryRun === true) return { dryRun: true, path: USAGE_JSONL, entry };
  appendLine(USAGE_JSONL, JSON.stringify(entry));
  return { path: USAGE_JSONL, entry };
}

function lessonEntries(args) {
  const lessons = Array.isArray(args.lessons) ? args.lessons : (args.lesson ? [args.lesson] : []);
  if (!lessons.length) throw new Error("lessons array is required");
  return lessons.map((lesson, index) => ({
    title: ensureSafeText(lesson.title, `lessons[${index}].title`).trim(),
    description: ensureSafeText(lesson.description, `lessons[${index}].description`).trim(),
    date: lesson.date ? assertDate(lesson.date, `lessons[${index}].date`) : new Date().toISOString().slice(0, 10),
    evidence: Array.isArray(lesson.evidence) ? lesson.evidence.filter(Boolean).map(String).slice(0, 20) : [],
    tags: Array.isArray(lesson.tags) ? lesson.tags.filter(Boolean).map((t) => safeSlug(t, "tag")).slice(0, 20) : [],
    project: typeof lesson.project === "string" && lesson.project.trim() ? safeSlug(lesson.project).slice(0, 64).toLowerCase() : null,
  }));
}

function handleCandidate(args, meta = {}) {
  const entries = lessonEntries(args);
  const now = new Date().toISOString();
  const records = entries.map((lesson) => ({
    id: `cand-${crypto.randomUUID()}`,
    ts: now,
    status: "pending-review",
    author: meta.caller || (typeof args.agent === "string" ? args.agent.slice(0, 64) : null),
    ...lesson,
    task: typeof args.task === "string" ? args.task.trim().slice(0, 500) : "",
  }));
  if (args.dryRun === true) return { dryRun: true, path: CANDIDATES_JSONL, candidates: records };
  appendLine(CANDIDATES_JSONL, records.map((r) => JSON.stringify(r)).join("\n"));
  return { path: CANDIDATES_JSONL, appended: records.length, candidates: records };
}

// Curator write-back: retire by judgment. Rows are marked, never deleted.
function handleSupersede(args) {
  const supersededBy = typeof args.supersededBy === "string" && args.supersededBy.trim() ? args.supersededBy.trim() : null;
  const reason = ensureSafeText(args.reason, "reason").trim().slice(0, 500);
  const status = args.status === "deprecated" ? "deprecated" : "superseded";
  const ids = Array.isArray(args.ids) ? args.ids.filter(Boolean).map(String).slice(0, 50) : [];
  if (!ids.length) throw new Error("ids array is required");
  if (status === "superseded" && !supersededBy) {
    throw new Error("supersededBy is required when status is 'superseded' (use status 'deprecated' to retire with no replacement)");
  }
  const lines = fs.readFileSync(REGISTER_JSONL, "utf8").split("\n");
  const targets = new Set(ids);
  const found = new Set();
  let replacementExists = !supersededBy;
  const parsed = lines.map((line) => {
    if (!line.trim()) return { line, record: null };
    try { return { line, record: JSON.parse(line) }; } catch { return { line, record: null }; }
  });
  for (const entry of parsed) {
    if (entry.record && entry.record.id === supersededBy) replacementExists = true;
  }
  if (!replacementExists) throw new Error(`supersededBy id not found in register: ${supersededBy}`);
  if (supersededBy && targets.has(supersededBy)) throw new Error("a lesson cannot supersede itself");
  const now = new Date().toISOString();
  const changed = [];
  const output = parsed.map((entry) => {
    const record = entry.record;
    if (!record || !targets.has(record.id)) return entry.line;
    found.add(record.id);
    if (record.status === "superseded" || record.status === "deprecated") return entry.line;
    const updated = { ...record, status, superseded_at: now, superseded_reason: reason };
    if (supersededBy) updated.superseded_by = supersededBy;
    changed.push({ id: record.id, title: record.title, status });
    return JSON.stringify(updated);
  });
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) throw new Error(`ids not found in register: ${missing.join(", ")}`);
  if (args.dryRun === true) return { dryRun: true, status, supersededBy, reason, changed };
  if (changed.length) atomicReplace(REGISTER_JSONL, output.join("\n"));
  return { path: REGISTER_JSONL, status, supersededBy, reason, retired: changed.length, changed };
}

// Direct append for curators / the project-sync pipeline. Explicit id + status
// stamped at write time, always.
function appendLessons(entries, { author = null, source = null } = {}) {
  const now = new Date().toISOString();
  const records = entries.map((lesson) => ({
    id: `llg-${crypto.randomUUID()}`,
    author,
    title: lesson.title,
    description: lesson.description,
    evidence: lesson.evidence || [],
    tags: lesson.tags || [],
    project: lesson.project || null,
    scope: lesson.project ? `project:${lesson.project}` : "global",
    status: "active",
    source,
    timestamp: `${lesson.date || now.slice(0, 10)}T12:00:00`,
    synced_at: now,
  }));
  appendLine(REGISTER_JSONL, records.map((r) => JSON.stringify(r)).join("\n"));
  return records;
}

// ---------------------------------------------------------------------------
// MCP stdio server
// ---------------------------------------------------------------------------
const tools = [
  {
    name: "lessons_query",
    description: "Search the lessons register and return relevant lesson records with stable ids for attribution.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        limit: { type: "number" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "lessons_apply",
    description: "Record that specific lesson ids influenced a task. Telemetry only. Include outcome (worked|partial|failed|unknown) when observable so effectiveness is measurable, not just declared.",
    inputSchema: {
      type: "object",
      properties: {
        lessonIds: { type: "array", items: { type: "string" } },
        task: { type: "string" },
        rationale: { type: "string" },
        outcome: { type: "string", enum: ["worked", "partial", "failed", "unknown"] },
        outcomeNote: { type: "string" },
        agent: { type: "string" },
        dryRun: { type: "boolean" },
      },
      required: ["lessonIds", "task"],
      additionalProperties: false,
    },
  },
  {
    name: "lessons_candidate",
    description: "Submit candidate lessons for curator review instead of writing to the register directly. Set project (slug) for project-scoped lessons.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string" },
        agent: { type: "string" },
        lessons: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              description: { type: "string" },
              date: { type: "string" },
              evidence: { type: "array", items: { type: "string" } },
              tags: { type: "array", items: { type: "string" } },
              project: { type: "string" },
            },
            required: ["title", "description"],
            additionalProperties: false,
          },
        },
        dryRun: { type: "boolean" },
      },
      required: ["lessons"],
      additionalProperties: false,
    },
  },
  {
    name: "lessons_supersede",
    description: "Curator only: retire lessons by judgment. Marks status superseded (with supersededBy pointer) or deprecated. Never deletes; retired lessons stop appearing in lessons_query.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" } },
        supersededBy: { type: "string" },
        status: { type: "string", enum: ["superseded", "deprecated"] },
        reason: { type: "string" },
        dryRun: { type: "boolean" },
      },
      required: ["ids", "reason"],
      additionalProperties: false,
    },
  },
];

const handlers = {
  lessons_query: handleQuery,
  lessons_apply: handleApply,
  lessons_candidate: handleCandidate,
  lessons_supersede: handleSupersede,
};

function callTool(name, args, meta) {
  if (!handlers[name]) throw new Error("Unknown tool: " + name);
  return handlers[name](args || {}, meta || {});
}

function okText(value) {
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...value }, null, 2) }] };
}

function errorText(error, toolName) {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: { tool: toolName || null, message: error?.message || String(error) } }, null, 2) }],
  };
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function processRequest(request) {
  try {
    if (request.method === "initialize") {
      send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: request.params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "muphys-law", version: "0.1.0" } } });
    } else if (request.method === "notifications/initialized") {
      // no-op
    } else if (request.method === "tools/list") {
      send({ jsonrpc: "2.0", id: request.id, result: { tools } });
    } else if (request.method === "tools/call") {
      const result = callTool(request.params?.name, request.params?.arguments || {}, { surface: "mcp" });
      send({ jsonrpc: "2.0", id: request.id, result: okText(result) });
    } else {
      send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unsupported method: " + request.method } });
    }
  } catch (error) {
    send({ jsonrpc: "2.0", id: request.id, result: errorText(error, request.params?.name || null) });
  }
}

module.exports = {
  MUPHYS_HOME,
  REGISTER_JSONL,
  USAGE_JSONL,
  CANDIDATES_JSONL,
  QUERIES_JSONL,
  PROJECTS_JSON,
  readRegister,
  activeLessons,
  normalizeSearchText,
  scoreLessonForQuery,
  compactLesson,
  lessonEntries,
  appendLessons,
  callTool,
  tools,
  handlers,
};

if (require.main === module) {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let request;
      try { request = JSON.parse(line); } catch { continue; }
      if (!request || typeof request !== "object" || request.id === undefined) continue;
      processRequest(request);
    }
  });
  // A stdio server whose client is gone must not linger as an orphan.
  process.stdin.on("end", () => process.exit(0));
}
