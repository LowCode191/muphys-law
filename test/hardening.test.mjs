// Regressions for the pre-release practitioner review findings.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "muphys-hardening-"));
process.env.MUPHYS_HOME = HOME;

const require = createRequire(import.meta.url);
const core = require("../lib/register.cjs");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "bin", "muphys.mjs");
const HOOK = path.join(HERE, "..", "hooks", "lessons-recall-hook.mjs");

function cli(cliArgs, env = {}) {
  return execFileSync("node", [CLI, ...cliArgs], { env: { ...process.env, MUPHYS_HOME: HOME, ...env }, encoding: "utf8" });
}

before(() => {
  core.appendLessons(core.lessonEntries({ lessons: [
    { title: "Alpha rule", description: "First version of the alpha guidance for the fleet." },
    { title: "Alpha rule v2", description: "Second, better version of the alpha guidance for the fleet." },
    { title: "日本語のみの教訓", description: "説明も完全に非ラテン文字です。" },
    { title: "완전히 한국어로 된 교훈", description: "설명도 한국어로만 되어 있습니다." },
  ] }), { author: "test" });
});

test("supersede refuses a retired replacement (cycles unrepresentable)", () => {
  const [a, b] = core.readRegister();
  core.callTool("lessons_supersede", { ids: [a.id], supersededBy: b.id, reason: "v2 wins" });
  // b now active, a retired. Retiring b toward a must fail: a is retired.
  assert.throws(
    () => core.callTool("lessons_supersede", { ids: [b.id], supersededBy: a.id, reason: "cycle attempt" }),
    /must be an ACTIVE lesson/,
  );
});

test("dedupe never groups non-Latin lessons on empty fold keys", () => {
  const result = JSON.parse(cli(["dedupe"]));
  const planned = JSON.stringify(result.wouldRetire || []);
  assert.ok(!planned.includes("llg-") || !/日本語|한국어/.test(planned), "non-Latin lessons must not appear in dedupe plans");
  const rows = core.readRegister();
  const nonLatin = rows.filter((r) => /日本語|한국어/.test(r.title));
  assert.equal(nonLatin.length, 2);
  for (const row of nonLatin) assert.notEqual(row.status, "superseded");
});

test("sync respects a held lock and appends nothing", () => {
  fs.writeFileSync(path.join(HOME, "projects.json"), JSON.stringify({ projects: [{ slug: "demo", root: HOME }] }));
  fs.writeFileSync(path.join(HOME, "LESSONS-LEARNED.jsonl"), JSON.stringify({ title: "Sync lesson", description: "A lesson captured at the project." }) + "\n");
  fs.writeFileSync(path.join(HOME, ".sync.lock"), JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));
  try {
    const before_ = core.readRegister().length;
    const result = JSON.parse(cli(["sync"]));
    assert.equal(result.skipped, true);
    assert.equal(core.readRegister().length, before_, "no append under a held lock");
  } finally {
    fs.rmSync(path.join(HOME, ".sync.lock"), { force: true });
  }
  const applied = JSON.parse(cli(["sync"]));
  assert.equal(applied.totalAppended, 1, "sync proceeds once the lock is free");
});

test("invalid cwd-filter regex exits 0, stays silent, never blocks the prompt", () => {
  const out = execFileSync("node", [HOOK], {
    input: JSON.stringify({ session_id: "rex", cwd: "/tmp", prompt: "update the alpha guidance rule for the fleet so the second better version applies everywhere" }),
    env: { ...process.env, MUPHYS_HOME: HOME, MUPHYS_HOOK_CWD_FILTER: "([unclosed" },
    encoding: "utf8",
  });
  assert.equal(out, "");
});

test("malformed hook state degrades to sane defaults, not a reset cap or crash", () => {
  const stateDir = path.join(HOME, "hook-state");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "clamp.json"), '{"injectedIds": "not-an-array", "injectionEvents": "NaN-ish"}');
  const out = execFileSync("node", [HOOK], {
    input: JSON.stringify({ session_id: "clamp", cwd: "/tmp", prompt: "update the alpha guidance rule for the fleet so the second better version applies everywhere" }),
    env: { ...process.env, MUPHYS_HOME: HOME },
    encoding: "utf8",
  });
  assert.match(out, /<lessons-recall>/, "clamped state must still allow recall");
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "clamp.json"), "utf8"));
  assert.ok(Array.isArray(state.injectedIds) && state.injectedIds.length > 0);
  assert.equal(state.injectionEvents, 1);
});

test("literal JSON null state (valid JSON!) still recalls — never silently disables", () => {
  const stateDir = path.join(HOME, "hook-state");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "nullstate.json"), "null");
  const out = execFileSync("node", [HOOK], {
    input: JSON.stringify({ session_id: "nullstate", cwd: "/tmp", prompt: "update the alpha guidance rule for the fleet so the second better version applies everywhere" }),
    env: { ...process.env, MUPHYS_HOME: HOME },
    encoding: "utf8",
  });
  assert.match(out, /<lessons-recall>/);
});

test("dedupe: mixed-language lessons sharing ASCII tokens are NOT conflated", () => {
  const pair = core.appendLessons(core.lessonEntries({ lessons: [
    { title: "API 本番環境では必ずバックアップを取る production", description: "本番環境の API を変更する前にバックアップ。production の教訓。" },
    { title: "API レート制限は指数バックオフで処理する production", description: "API のレート制限エラーは指数バックオフ。production の別の教訓。" },
  ] }), { author: "test" });
  const plan = JSON.parse(cli(["dedupe"]));
  const planned = JSON.stringify(plan.wouldRetire || []);
  for (const record of pair) assert.ok(!planned.includes(record.id), "distinct mixed-language lessons must never be dedupe candidates");
});

test("dedupe: exact non-Latin duplicates ARE now grouped (unicode fold)", () => {
  const dupes = core.appendLessons(core.lessonEntries({ lessons: [
    { title: "重複した教訓のタイトル", description: "全く同じ説明文です。" },
    { title: "重複した教訓のタイトル", description: "全く同じ説明文です。" },
  ] }), { author: "test" });
  const plan = JSON.parse(cli(["dedupe"]));
  const planned = JSON.stringify(plan.wouldRetire || []);
  assert.ok(dupes.some((record) => planned.includes(record.id)), "exact non-Latin duplicates must be dedupe candidates");
});

test("sync: concurrent runs against a STALE lock never write duplicate ids", async () => {
  const raceHome = fs.mkdtempSync(path.join(os.tmpdir(), "muphys-race-"));
  fs.writeFileSync(path.join(raceHome, "projects.json"), JSON.stringify({ projects: [{ slug: "race", root: raceHome }] }));
  fs.writeFileSync(path.join(raceHome, "LESSONS-LEARNED.jsonl"),
    JSON.stringify({ title: "Race lesson one", description: "First lesson for the race test." }) + "\n" +
    JSON.stringify({ title: "Race lesson two", description: "Second lesson for the race test." }) + "\n");
  const staleLock = path.join(raceHome, ".sync.lock");
  fs.writeFileSync(staleLock, JSON.stringify({ pid: 999999999, ts: "2026-01-01T00:00:00Z" }));
  const { execFile } = await import("node:child_process");
  const run = () => new Promise((resolve) => execFile("node", [CLI, "sync"], { env: { ...process.env, MUPHYS_HOME: raceHome } }, () => resolve()));
  await Promise.all([run(), run(), run()]);
  // settle: one more sync with no lock contention picks up any stragglers
  await run();
  const register = path.join(raceHome, "lessons.jsonl");
  const ids = fs.readFileSync(register, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).id);
  assert.equal(new Set(ids).size, ids.length, `duplicate ids written under contention: ${ids.join(",")}`);
  assert.equal(ids.length, 2, "both lessons land exactly once");
});

test("dedupe fold preserves combining marks: Devanagari क and कि never collide", () => {
  const pair = core.appendLessons(core.lessonEntries({ lessons: [
    { title: "क के बारे में सबक", description: "पहला सबक क अक्षर के बारे में है।" },
    { title: "कि के बारे में सबक", description: "पहला सबक कि अक्षर के बारे में है।" },
  ] }), { author: "test" });
  const plan = JSON.parse(cli(["dedupe"]));
  const planned = JSON.stringify(plan.wouldRetire || []);
  for (const record of pair) assert.ok(!planned.includes(record.id), "mark-distinguished Devanagari lessons must never be dedupe candidates");
});

test("dedupe fold NFC-normalizes: precomposed and decomposed forms of the same text ARE grouped", () => {
  const precomposed = "café lesson";               // é as U+00E9
  const decomposed = "café lesson";               // e + combining acute
  assert.notEqual(precomposed, decomposed, "sanity: different code points");
  const dupes = core.appendLessons(core.lessonEntries({ lessons: [
    { title: precomposed, description: `${precomposed} description body.` },
    { title: decomposed, description: `${decomposed} description body.` },
  ] }), { author: "test" });
  const plan = JSON.parse(cli(["dedupe"]));
  const planned = JSON.stringify(plan.wouldRetire || []);
  assert.ok(dupes.some((record) => planned.includes(record.id)), "same text in different normalization forms must be dedupe candidates");
});

test("dedupe never merges emoji-distinguished lessons (✅ vs ❌ are opposites)", () => {
  const pair = core.appendLessons(core.lessonEntries({ lessons: [
    { title: "deploy check ✅ before restart", description: "Run the deploy check ✅ before any restart of the service." },
    { title: "deploy check ❌ before restart", description: "Run the deploy check ❌ before any restart of the service." },
  ] }), { author: "test" });
  const planned = JSON.stringify(JSON.parse(cli(["dedupe"])).wouldRetire || []);
  for (const record of pair) assert.ok(!planned.includes(record.id), "emoji-distinguished lessons must never be dedupe candidates");
});

test("dedupe treats case variants as DISTINCT (locale-safe by design: IŞIK ≠ ışık)", () => {
  const pair = core.appendLessons(core.lessonEntries({ lessons: [
    { title: "IŞIK KONTROL YAP KURALI", description: "BÜYÜK HARFLİ DERS METNİ BURADA." },
    { title: "ışık kontrol yap kuralı", description: "büyük harfli ders metni burada.".toLowerCase() },
  ] }), { author: "test" });
  const planned = JSON.stringify(JSON.parse(cli(["dedupe"])).wouldRetire || []);
  for (const record of pair) assert.ok(!planned.includes(record.id), "case variants must never be dedupe candidates (Turkish casing is unfixable by folding)");
});

test("dedupe still groups the original backfill class: typographic quote/dash variants", () => {
  const dupes = core.appendLessons(core.lessonEntries({ lessons: [
    { title: "Don't pipe ‘sensitive’ output — mask it", description: "The rule… applies to “every” pipeline — always." },
    { title: "Don't pipe 'sensitive' output - mask it", description: "The rule... applies to \"every\" pipeline - always." },
  ] }), { author: "test" });
  const planned = JSON.stringify(JSON.parse(cli(["dedupe"])).wouldRetire || []);
  assert.ok(dupes.some((record) => planned.includes(record.id)), "typographic-variant copies of the same lesson must group");
});
