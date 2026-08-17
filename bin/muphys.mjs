#!/usr/bin/env node
// muphys — CLI for the lessons register.
//
//   muphys add --title "..." --description "..." [--tags a,b] [--evidence x]
//              [--project slug] [--author name] [--date YYYY-MM-DD]
//   muphys query "<text>" [--tags a,b] [--limit N]
//   muphys supersede --ids id1,id2 --superseded-by idX --reason "..."
//   muphys deprecate --ids id1,id2 --reason "..."
//   muphys dedupe [--apply]        exact content duplicates -> superseded
//   muphys sync [--dry-run]        pull project LESSONS-LEARNED.jsonl files in
//   muphys doctor                  integrity + liveness checks
//   muphys stats                   register/funnel counts

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const core = require(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "register.cjs"));

const [, , command, ...rest] = process.argv;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function out(value) {
  console.log(JSON.stringify(value, null, 2));
}

function fail(message) {
  console.error(`muphys: ${message}`);
  process.exit(2);
}

const args = parseArgs(rest);

switch (command) {
  case "add": {
    if (!args.title || !args.description) fail("--title and --description are required");
    const entries = core.lessonEntries({
      lessons: [{
        title: String(args.title),
        description: String(args.description),
        date: args.date ? String(args.date) : undefined,
        tags: args.tags ? String(args.tags).split(",").map((t) => t.trim()).filter(Boolean) : [],
        evidence: args.evidence ? [String(args.evidence)] : [],
        project: args.project ? String(args.project) : undefined,
      }],
    });
    const records = core.appendLessons(entries, { author: args.author ? String(args.author) : null, source: "cli" });
    out({ appended: records.map((r) => ({ id: r.id, title: r.title })) });
    break;
  }

  case "query": {
    const result = core.callTool("lessons_query", {
      query: args._.join(" "),
      tags: args.tags ? String(args.tags).split(",").map((t) => t.trim()).filter(Boolean) : [],
      limit: args.limit ? Number(args.limit) : undefined,
    }, { surface: "cli" });
    out(result);
    break;
  }

  case "supersede":
  case "deprecate": {
    if (!args.ids || !args.reason) fail("--ids and --reason are required");
    const result = core.callTool("lessons_supersede", {
      ids: String(args.ids).split(",").map((s) => s.trim()).filter(Boolean),
      supersededBy: args["superseded-by"] ? String(args["superseded-by"]) : undefined,
      status: command === "deprecate" ? "deprecated" : "superseded",
      reason: String(args.reason),
      dryRun: args["dry-run"] === true,
    });
    out(result);
    break;
  }

  case "dedupe": {
    // Exact content duplicates only (punctuation-folded title+description
    // equality). Anything less identical is a curator judgment call.
    // Dedupe equality is DESTRUCTIVE under --apply, and four review rounds
    // proved a lesson about lossy folds: every character class we stripped
    // created a new false-merge that retired a genuinely distinct lesson —
    // ASCII-only folding ate non-Latin text, \p{L}\p{N} ate combining marks
    // (क vs कि), adding \p{M} still ate symbols (a ✅-lesson merged with its
    // ❌-opposite), and locale-blind toLowerCase corrupts Turkish in BOTH
    // directions with no regex fix possible.
    //
    // So the fold strips NOTHING semantic. It applies only equivalences that
    // cannot distinguish two real lessons:
    //   - NFC canonical normalization (precomposed ≡ decomposed, by Unicode's
    //     own definition of "same text")
    //   - typographic quote/dash/ellipsis variants → their plain forms (the
    //     original backfill-duplicate class this command exists for)
    //   - whitespace runs → single space; trailing separator-dash runs dropped
    //
    // Deliberately NOT folded: case (locale-dependent — case-variant copies
    // are treated as distinct; a curator can supersede them manually, which
    // is the cheap direction of error) and every letter/mark/symbol/emoji.
    const TYPOGRAPHIC = new Map(Object.entries({
      "‘": "'", "’": "'", "‚": "'", "‛": "'",
      "“": '"', "”": '"', "„": '"', "‟": '"',
      "–": "-", "—": "-", "‒": "-", "―": "-",
      "…": "...",
      " ": " ",
    }));
    const fold = (t) => String(t || "")
      .normalize("NFC")
      .replace(/[‘’‚‛“”„‟–—‒―… ]/g, (ch) => TYPOGRAPHIC.get(ch) ?? ch)
      .replace(/\s+/g, " ")
      // Trailing separator-dash trim, gated on preceding whitespace: "title —"
      // is separator noise, but a dash GLUED to the last token is content —
      // "service tier is A-" must never collide with "service tier is A".
      .replace(/\s[-\s]+$/, "")
      .trim();
    const rows = core.readRegister();
    const groups = new Map();
    for (const lesson of rows) {
      if (lesson.status === "superseded" || lesson.status === "deprecated") continue;
      const foldedTitle = fold(lesson.title);
      const foldedDescription = fold(lesson.description);
      if (!foldedTitle || !foldedDescription) continue; // emoji-only etc: never judge on empty keys
      const key = foldedTitle + "|" + foldedDescription;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(lesson);
    }
    const plans = [];
    for (const members of groups.values()) {
      if (members.length < 2) continue;
      const keeper = [...members].sort((a, b) => String(a.timestamp || "").localeCompare(String(b.timestamp || ""))).pop();
      for (const member of members) {
        if (member.id !== keeper.id) plans.push({ retire: member.id, keeper: keeper.id, title: member.title });
      }
    }
    if (!plans.length) {
      out({ duplicates: 0 });
      break;
    }
    if (args.apply !== true) {
      out({ dryRun: true, wouldRetire: plans });
      break;
    }
    for (const plan of plans) {
      core.callTool("lessons_supersede", { ids: [plan.retire], supersededBy: plan.keeper, reason: "exact-duplicate-content (muphys dedupe)" });
    }
    out({ retired: plans.length });
    break;
  }

  case "sync": {
    // Deterministic feed-up of per-project LESSONS-LEARNED.jsonl files.
    // Content-derived ids (llp-<sha1(slug|title|description)>) make re-runs
    // idempotent with no checkpoint state; the register is append-only here.
    let registry;
    try {
      registry = JSON.parse(fs.readFileSync(core.PROJECTS_JSON, "utf8"));
    } catch {
      fail(`no project registry at ${core.PROJECTS_JSON} — see data/projects.example.json`);
    }
    const projects = (registry.projects || []).filter((project) => project && project.slug && project.root);
    const existing = new Set(core.readRegister().map((l) => l.id));
    const now = new Date().toISOString();
    const summary = [];
    const toAppend = [];
    for (const project of projects) {
      const slug = String(project.slug).toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
      const root = path.resolve(project.root);
      const file = path.resolve(root, project.file || "LESSONS-LEARNED.jsonl");
      const row = { project: slug, file, scanned: 0, appended: 0, duplicates: 0, invalid: 0 };
      summary.push(row);
      if (!file.startsWith(root + path.sep) && file !== root) { row.error = "lessons file escapes project root"; continue; }
      if (!fs.existsSync(file)) continue;
      let realFile;
      try {
        realFile = fs.realpathSync(file);
        const realRoot = fs.realpathSync(root);
        if (realFile !== realRoot && !realFile.startsWith(realRoot + path.sep)) { row.error = "symlink escape refused"; continue; }
      } catch { continue; }
      const lines = fs.readFileSync(realFile, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (!line.trim()) return;
        row.scanned += 1;
        let entry;
        try { entry = JSON.parse(line); } catch { row.invalid += 1; return; }
        const title = typeof entry.title === "string" ? entry.title.trim().slice(0, 300) : "";
        const description = typeof entry.description === "string" ? entry.description.trim().slice(0, 8000) : "";
        if (!title || !description) { row.invalid += 1; return; }
        const id = "llp-" + crypto.createHash("sha1").update(`${slug}|${title}|${description}`).digest("hex").slice(0, 12);
        if (existing.has(id)) { row.duplicates += 1; return; }
        existing.add(id);
        const date = typeof entry.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(entry.date) ? entry.date : now.slice(0, 10);
        toAppend.push(JSON.stringify({
          id,
          author: typeof entry.author === "string" && entry.author.trim() ? entry.author.trim().slice(0, 64) : slug,
          timestamp: `${date}T12:00:00`,
          title,
          description,
          evidence: Array.isArray(entry.evidence) ? entry.evidence.filter(Boolean).map(String).slice(0, 20) : [],
          tags: [...new Set([...(Array.isArray(entry.tags) ? entry.tags.filter(Boolean).map(String) : []), slug])].slice(0, 20),
          scope: `project:${slug}`,
          project: slug,
          status: "active",
          source: `project-sync:${slug}#L${index + 1}`,
          synced_at: now,
        }));
        row.appended += 1;
      });
    }
    if (args["dry-run"] !== true && toAppend.length) {
      // Single-writer lock: two concurrent syncs both pass the read-side
      // duplicate check and both append the same content id. The lock is a
      // FILE created with O_EXCL (the atomic front door) containing the
      // holder's pid. Takeover policy: a lock whose recorded pid is still
      // alive is NEVER touched — that closes the TOCTOU where a process
      // judges a lock stale by age and then removes a fresh lock that
      // replaced it in the gap (any age-based dir takeover has that hole; a
      // live-pid check cannot displace an active writer). A dead-pid lock is
      // unlinked and re-contested through O_EXCL, so racing reapers get
      // exactly one winner. Recycled-pid false positives fail toward
      // "skip this run" — the safe direction — and clear on the next tick.
      const lockPath = path.join(core.MUPHYS_HOME, ".sync.lock");
      const tryLock = () => {
        try {
          fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
          return true;
        } catch {
          return false;
        }
      };
      const acquireLock = () => {
        if (tryLock()) return true;
        let holderAlive = true;
        try {
          const holder = JSON.parse(fs.readFileSync(lockPath, "utf8"));
          try {
            process.kill(Number(holder.pid), 0);
          } catch {
            holderAlive = false;
          }
        } catch {
          holderAlive = false; // unreadable/legacy lock artifact: treat as dead
        }
        if (holderAlive) return false;
        try {
          fs.rmSync(lockPath, { recursive: true, force: true }); // dead holder; ENOENT fine
        } catch { /* another reaper got it */ }
        return tryLock(); // one O_EXCL winner among racing reapers
      };
      if (!acquireLock()) {
        out({ skipped: true, reason: "another sync holds the lock", lock: lockPath });
        break;
      }
      try {
        // Re-check ids under the lock — the racing sync may have won.
        const current = new Set(core.readRegister().map((l) => l.id));
        const stillNew = toAppend.filter((line) => !current.has(JSON.parse(line).id));
        if (stillNew.length) {
          fs.mkdirSync(path.dirname(core.REGISTER_JSONL), { recursive: true });
          fs.appendFileSync(core.REGISTER_JSONL, stillNew.join("\n") + "\n", { mode: 0o600 });
        }
        out({ dryRun: false, totalAppended: stillNew.length, projects: summary });
      } finally {
        fs.rmSync(lockPath, { force: true });
      }
      break;
    }
    out({ dryRun: args["dry-run"] === true, totalAppended: 0, projects: summary });
    break;
  }

  case "doctor": {
    // Integrity + liveness. Fail-open components (the hook) are silent when
    // broken — this is the external assertion that catches that.
    const issues = [];
    const rows = core.readRegister();
    const withoutExplicitId = fs.existsSync(core.REGISTER_JSONL)
      ? fs.readFileSync(core.REGISTER_JSONL, "utf8").split("\n").filter((l) => l.trim()).filter((l) => { try { return !JSON.parse(l).id; } catch { return false; } }).length
      : 0;
    if (withoutExplicitId > 0) issues.push(`${withoutExplicitId} register rows lack an explicit id — run writers from this package only`);
    for (const lesson of rows) {
      if (lesson.status !== "superseded" || !lesson.superseded_by) continue;
      const replacement = rows.find((other) => other.id === lesson.superseded_by);
      if (!replacement) {
        issues.push(`dangling superseded_by pointer: ${lesson.id} -> ${lesson.superseded_by}`);
      } else if (replacement.status === "superseded" || replacement.status === "deprecated") {
        issues.push(`superseded_by points at a retired lesson: ${lesson.id} -> ${lesson.superseded_by} (chains/cycles; re-point at the active replacement)`);
      }
    }
    for (const name of ["readRegister", "scoreLessonForQuery", "normalizeSearchText", "callTool"]) {
      if (typeof core[name] !== "function") issues.push(`runtime missing export ${name} — wrong or stale checkout?`);
    }
    const injLog = path.resolve(process.env.MUPHYS_INJECTION_LOG || path.join(core.MUPHYS_HOME, "injections.jsonl"));
    if (!fs.existsSync(injLog)) {
      // Only alarm if the hook appears MOUNTED somewhere — a fresh install
      // with no hook yet is healthy, not broken.
      let mounted = false;
      for (const settingsPath of [
        path.join(os.homedir(), ".claude", "settings.json"),
        path.join(process.cwd(), ".claude", "settings.json"),
      ]) {
        try {
          if (fs.readFileSync(settingsPath, "utf8").includes("lessons-recall-hook.mjs")) mounted = true;
        } catch { /* absent */ }
      }
      if (mounted) {
        issues.push(`hook is mounted but no injection log exists at ${injLog} — it has never fired. Verify by EFFECT: send a real prompt and watch this file. Reading settings back proves nothing (some harnesses never load the scope you installed into).`);
      }
    }
    out({ register: { total: rows.length, active: core.activeLessons().length }, issues, ok: issues.length === 0 });
    process.exit(issues.length ? 1 : 0);
    break;
  }

  case "stats": {
    const count = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).length : 0);
    out({
      home: core.MUPHYS_HOME,
      register: { total: core.readRegister().length, active: core.activeLessons().length },
      queries: count(core.QUERIES_JSONL),
      applications: count(core.USAGE_JSONL),
      candidates: count(core.CANDIDATES_JSONL),
      injections: count(path.resolve(process.env.MUPHYS_INJECTION_LOG || path.join(core.MUPHYS_HOME, "injections.jsonl"))),
    });
    break;
  }

  default:
    console.error(`muphys — lessons register CLI

  add | query | supersede | deprecate | dedupe | sync | doctor | stats

Data home: ${core.MUPHYS_HOME}  (override with MUPHYS_HOME)
MCP server: node lib/register.cjs   (stdio)
Recall hook: hooks/lessons-recall-hook.mjs  (Claude Code UserPromptSubmit)`);
    process.exit(command ? 2 : 0);
}
