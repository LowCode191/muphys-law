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
  fs.mkdirSync(path.join(HOME, ".sync.lock"));
  try {
    const before_ = core.readRegister().length;
    const result = JSON.parse(cli(["sync"]));
    assert.equal(result.skipped, true);
    assert.equal(core.readRegister().length, before_, "no append under a held lock");
  } finally {
    fs.rmSync(path.join(HOME, ".sync.lock"), { recursive: true, force: true });
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
