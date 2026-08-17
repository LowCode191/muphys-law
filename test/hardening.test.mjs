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

// Round 7 split the dedupe surfaces: wouldRetire (destructive, NFC-exact
// only) and reviewCandidates (report-only fold near-matches). Distinctness
// tests must assert absence from BOTH.
function dedupePlan() {
  const plan = JSON.parse(cli(["dedupe"]));
  return {
    plan,
    retire: JSON.stringify(plan.wouldRetire || []),
    review: JSON.stringify(plan.reviewCandidates || []),
  };
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
  const { retire, review } = dedupePlan();
  for (const surface of [retire, review]) assert.ok(!/日本語|한국어/.test(surface), "distinct non-Latin lessons must not surface in either dedupe tier");
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
  const { retire, review } = dedupePlan();
  for (const record of pair) {
    assert.ok(!retire.includes(record.id), "distinct mixed-language lessons must never auto-retire");
    assert.ok(!review.includes(record.id), "distinct mixed-language lessons must not even be review candidates");
  }
});

test("dedupe: exact non-Latin duplicates ARE grouped (NFC-exact tier)", () => {
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
  const { retire, review } = dedupePlan();
  for (const record of pair) {
    assert.ok(!retire.includes(record.id), "mark-distinguished Devanagari lessons must never auto-retire");
    assert.ok(!review.includes(record.id), "mark-distinguished Devanagari lessons must not even be review candidates");
  }
});

test("dedupe fold NFC-normalizes: precomposed and decomposed forms of the same text ARE grouped", () => {
  const precomposed = "café lesson";               // é as U+00E9
  const decomposed = "café lesson";               // e + combining acute
  assert.notEqual(precomposed, decomposed, "sanity: different code points");
  const dupes = core.appendLessons(core.lessonEntries({ lessons: [
    { title: precomposed, description: `${precomposed} description body.` },
    { title: decomposed, description: `${decomposed} description body.` },
  ] }), { author: "test" });
  const { retire } = dedupePlan();
  assert.ok(dupes.some((record) => retire.includes(record.id)), "canonically-equivalent forms are the same text — NFC-exact tier must auto-retire one");
});

test("dedupe never merges emoji-distinguished lessons (✅ vs ❌ are opposites)", () => {
  const pair = core.appendLessons(core.lessonEntries({ lessons: [
    { title: "deploy check ✅ before restart", description: "Run the deploy check ✅ before any restart of the service." },
    { title: "deploy check ❌ before restart", description: "Run the deploy check ❌ before any restart of the service." },
  ] }), { author: "test" });
  const { retire, review } = dedupePlan();
  for (const record of pair) {
    assert.ok(!retire.includes(record.id), "emoji-distinguished lessons must never auto-retire");
    assert.ok(!review.includes(record.id), "emoji-distinguished lessons must not even be review candidates");
  }
});

test("dedupe treats case variants as DISTINCT (locale-safe by design: IŞIK ≠ ışık)", () => {
  const pair = core.appendLessons(core.lessonEntries({ lessons: [
    { title: "IŞIK KONTROL YAP KURALI", description: "BÜYÜK HARFLİ DERS METNİ BURADA." },
    { title: "ışık kontrol yap kuralı", description: "büyük harfli ders metni burada.".toLowerCase() },
  ] }), { author: "test" });
  const { retire, review } = dedupePlan();
  for (const record of pair) {
    assert.ok(!retire.includes(record.id), "case variants must never auto-retire (Turkish casing is unfixable by folding)");
    assert.ok(!review.includes(record.id), "case variants are deliberately not even review candidates");
  }
});

test("round 7: typographic quote/dash variants are review candidates, never auto-retired", () => {
  // The original backfill class this command was built for — but a lesson can
  // be ABOUT an exact character („ vs "), so the typographic map is lossy and
  // lossy never gates destruction. The curator sees the pair and decides.
  const dupes = core.appendLessons(core.lessonEntries({ lessons: [
    { title: "Don't pipe ‘sensitive’ output — mask it", description: "The rule… applies to “every” pipeline — always." },
    { title: "Don't pipe 'sensitive' output - mask it", description: "The rule... applies to \"every\" pipeline - always." },
  ] }), { author: "test" });
  const { retire, review } = dedupePlan();
  for (const record of dupes) assert.ok(!retire.includes(record.id), "typographic variants are not NFC-exact — they must never auto-retire");
  assert.ok(dupes.every((record) => review.includes(record.id)), "typographic-variant copies must surface together for curator review");
});

test("dedupe: a dash glued to the last token is content, not separator noise (A- ≠ A)", () => {
  const pair = core.appendLessons(core.lessonEntries({ lessons: [
    { title: "service tier is A-", description: "The service tier grade here is A- for this quarter." },
    { title: "service tier is A", description: "The service tier grade here is A for this quarter." },
  ] }), { author: "test" });
  const { retire, review } = dedupePlan();
  for (const record of pair) {
    assert.ok(!retire.includes(record.id), "grade A- and grade A must never auto-retire");
    assert.ok(!review.includes(record.id), "grade A- and grade A must not even be review candidates");
  }
});

test("round 7: separator-dash variants are review candidates, never auto-retired", () => {
  // A trailing "—" is usually decoration — but "Required delimiter is —" is a
  // lesson ABOUT a terminal dash, and no trim can tell those apart. Report,
  // never retire.
  const dupes = core.appendLessons(core.lessonEntries({ lessons: [
    { title: "Always verify the backup restore path —", description: "Backups without a tested restore path are decorative —" },
    { title: "Always verify the backup restore path", description: "Backups without a tested restore path are decorative" },
  ] }), { author: "test" });
  const { retire, review } = dedupePlan();
  for (const record of dupes) assert.ok(!retire.includes(record.id), "separator-dash variants are not NFC-exact — they must never auto-retire");
  assert.ok(dupes.every((record) => review.includes(record.id)), "separator-dash variants must surface together for curator review");
});

// ---------------------------------------------------------------------------
// Round 7: the four confirmed fold collisions must be unrepresentable in the
// destructive path — proven under a real --apply, not a dry run.
// ---------------------------------------------------------------------------

test("round 7: --apply retires only NFC-exact duplicates; every semantic near-match survives", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muphys-r7-"));
  const seed = [
    // (1) composite-key delimiter injection
    { title: "a|b", description: "c" },
    { title: "a", description: "b|c" },
    // (2) a lesson ABOUT a terminal dash vs its dash-less sibling
    { title: "Delimiter rule", description: "Required delimiter is —" },
    { title: "Delimiter rule", description: "Required delimiter is" },
    // (3) whitespace is semantic in payloads
    { title: "Printf payload", description: "line one\npayload line two" },
    { title: "Printf payload", description: "line one payload line two" },
    // (4) lessons about exact characters
    { title: "Charset rule", description: "Reject character „" },
    { title: "Charset rule", description: 'Reject character "' },
    // (5) a true byte-identical duplicate — the one pair that must still die
    { title: "True duplicate", description: "Identical description body." },
    { title: "True duplicate", description: "Identical description body." },
  ];
  for (const lesson of seed) {
    execFileSync("node", [CLI, "add", "--title", lesson.title, "--description", lesson.description],
      { env: { ...process.env, MUPHYS_HOME: home }, encoding: "utf8" });
  }
  const result = JSON.parse(execFileSync("node", [CLI, "dedupe", "--apply"],
    { env: { ...process.env, MUPHYS_HOME: home }, encoding: "utf8" }));

  assert.equal(result.retired, 1, "exactly the byte-identical pair auto-retires — nothing else");
  const rows = fs.readFileSync(path.join(home, "lessons.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const superseded = rows.filter((r) => r.status === "superseded");
  assert.equal(superseded.length, 1);
  assert.equal(superseded[0].title, "True duplicate");
  const active = rows.filter((r) => r.status === "active");
  assert.equal(active.length, 9, "all eight semantic near-matches plus the kept duplicate stay active");

  const review = JSON.stringify(result.reviewCandidates || []);
  const byContent = (title, desc) => rows.find((r) => r.title === title && r.description === desc);
  // fold-equal near-matches surface for the curator...
  for (const [title, desc] of [
    ["Delimiter rule", "Required delimiter is —"], ["Delimiter rule", "Required delimiter is"],
    ["Printf payload", "line one\npayload line two"], ["Printf payload", "line one payload line two"],
    ["Charset rule", "Reject character „"], ["Charset rule", 'Reject character "'],
  ]) {
    assert.ok(review.includes(byContent(title, desc).id), `review candidates must include ${title} / ${desc}`);
  }
  // ...the structurally-distinct pipe pair appears NOWHERE...
  for (const [title, desc] of [["a|b", "c"], ["a", "b|c"]]) {
    const id = byContent(title, desc).id;
    assert.ok(!review.includes(id), "pipe-injection pair must not be review candidates — the structural key keeps them distinct");
  }
  // ...and the retired pair is not double-reported as a candidate.
  assert.ok(!review.includes("True duplicate"), "NFC-exact groups belong to the retire plan, not the review list");
});

test("round 7: sync content ids are delimiter-proof (a|b + c ≠ a + b|c)", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muphys-r7sync-"));
  fs.writeFileSync(path.join(home, "projects.json"), JSON.stringify({ projects: [{ slug: "inj", root: home }] }));
  fs.writeFileSync(path.join(home, "LESSONS-LEARNED.jsonl"),
    JSON.stringify({ title: "a|b", description: "c" }) + "\n" +
    JSON.stringify({ title: "a", description: "b|c" }) + "\n");
  execFileSync("node", [CLI, "sync"], { env: { ...process.env, MUPHYS_HOME: home }, encoding: "utf8" });
  const rows = fs.readFileSync(path.join(home, "lessons.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 2, "both pipe-shifted lessons land — neither is swallowed as the other's duplicate");
  assert.notEqual(rows[0].id, rows[1].id, "structural tuple hash gives distinct ids");
});
