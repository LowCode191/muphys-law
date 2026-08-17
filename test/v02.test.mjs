// v0.2 features: npx-mountable MCP subcommand, outcome analytics, and the
// optional embedding retriever (hybrid ranking, fail-open, cached).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { execFile, execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "bin", "muphys.mjs");

function freshHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Async CLI runner. execFileSync blocks this process's event loop — and the
// fake embeddings endpoint lives in THIS process, so a sync child would
// deadlock: its fetch waits on a server that can't respond until the child
// exits. (Found the hard way; the abort-after-exactly-timeout signature is
// the tell.)
function runCli(args, env) {
  return new Promise((resolve, reject) => {
    execFile("node", [CLI, ...args], { env, encoding: "utf8" }, (error, stdout) => {
      if (error && !stdout) reject(error);
      else resolve(stdout);
    });
  });
}

function seedRegister(home, lessons) {
  fs.writeFileSync(path.join(home, "lessons.jsonl"), lessons.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

test("mcp subcommand hosts the stdio server (initialize + tools/list)", async () => {
  const home = freshHome("muphys-v02mcp-");
  const proc = spawn("node", [CLI, "mcp"], { env: { ...process.env, MUPHYS_HOME: home } });
  const out = [];
  proc.stdout.on("data", (d) => out.push(d));
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } }) + "\n");
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
  proc.stdin.end();
  await new Promise((resolve) => proc.on("exit", resolve));
  const lines = Buffer.concat(out).toString("utf8").trim().split("\n").map((l) => JSON.parse(l));
  const init = lines.find((l) => l.id === 1);
  const list = lines.find((l) => l.id === 2);
  assert.equal(init.result.serverInfo.name, "muphys-law");
  assert.deepEqual(list.result.tools.map((t) => t.name).sort(), ["lessons_apply", "lessons_candidate", "lessons_query", "lessons_supersede"]);
});

test("stats rolls up apply outcomes; --by-lesson joins injections per lesson", () => {
  const home = freshHome("muphys-v02stats-");
  seedRegister(home, [
    { id: "llg-goodlesson1", title: "Good lesson", description: "Works when applied.", status: "active" },
    { id: "llg-otherlesson", title: "Other lesson", description: "Rarely used.", status: "active" },
  ]);
  const usage = [
    { id: "use-1", lessonIds: ["llg-goodlesson1"], outcome: "worked" },
    { id: "use-2", lessonIds: ["llg-goodlesson1"], outcome: "worked" },
    { id: "use-3", lessonIds: ["llg-goodlesson1", "llg-otherlesson"], outcome: "failed" },
    { id: "use-4", lessonIds: ["llg-otherlesson"] },
  ];
  fs.writeFileSync(path.join(home, "usage.jsonl"), usage.map((u) => JSON.stringify(u)).join("\n") + "\n");
  fs.writeFileSync(path.join(home, "injections.jsonl"),
    JSON.stringify({ id: "inj-1", lessons: [{ id: "llg-goodlesson1", rank: 1 }] }) + "\n" +
    JSON.stringify({ id: "inj-2", lessons: [{ id: "llg-goodlesson1", rank: 1 }, { id: "llg-otherlesson", rank: 2 }] }) + "\n");
  const env = { ...process.env, MUPHYS_HOME: home };
  const stats = JSON.parse(execFileSync("node", [CLI, "stats", "--by-lesson"], { env, encoding: "utf8" }));
  assert.deepEqual(stats.outcomes, { applies: 4, worked: 2, partial: 0, failed: 1, unknown: 0, unspecified: 1 });
  const good = stats.byLesson.find((l) => l.id === "llg-goodlesson1");
  assert.equal(good.title, "Good lesson");
  assert.equal(good.applies, 3);
  assert.equal(good.worked, 2);
  assert.equal(good.failed, 1);
  assert.equal(good.injections, 2);
  const other = stats.byLesson.find((l) => l.id === "llg-otherlesson");
  assert.equal(other.applies, 2);
  assert.equal(other.unspecified, 1);
  assert.equal(other.injections, 1);
});

test("doctor flags an active lesson that keeps failing; healthy lessons stay quiet", () => {
  const home = freshHome("muphys-v02doc-");
  seedRegister(home, [
    { id: "llg-failing0001", title: "Stale guidance", description: "Keeps failing when applied.", status: "active" },
    { id: "llg-healthy0001", title: "Healthy lesson", description: "Mostly works.", status: "active" },
  ]);
  const usage = [
    { id: "u1", lessonIds: ["llg-failing0001"], outcome: "failed" },
    { id: "u2", lessonIds: ["llg-failing0001"], outcome: "failed" },
    { id: "u3", lessonIds: ["llg-failing0001"], outcome: "worked" },
    { id: "u4", lessonIds: ["llg-healthy0001"], outcome: "failed" },
    { id: "u5", lessonIds: ["llg-healthy0001"], outcome: "worked" },
    { id: "u6", lessonIds: ["llg-healthy0001"], outcome: "worked" },
  ];
  fs.writeFileSync(path.join(home, "usage.jsonl"), usage.map((u) => JSON.stringify(u)).join("\n") + "\n");
  const env = { ...process.env, MUPHYS_HOME: home, HOME: home };
  let code = 0;
  let raw = "";
  try {
    raw = execFileSync("node", [CLI, "doctor"], { env, encoding: "utf8" });
  } catch (err) {
    code = err.status;
    raw = err.stdout;
  }
  assert.equal(code, 1, "a persistently failing lesson is a doctor issue");
  const doctor = JSON.parse(raw);
  assert.ok(doctor.issues.some((i) => i.includes("llg-failing0001") && i.includes("supersession")));
  assert.ok(!doctor.issues.some((i) => i.includes("llg-healthy0001")), "healthy lessons must not be flagged");
});

// ---------------------------------------------------------------------------
// Embedding retriever — against a local fake OpenAI-compatible endpoint.
// ---------------------------------------------------------------------------

function startFakeEmbeddings() {
  // Paraphrase pair maps to near-identical vectors; everything else is far.
  const vectorFor = (text) => {
    const t = String(text).toLowerCase();
    if (t.includes("live in production") || t.includes("actually shipped")) return [0.99, 0.05, 0.0];
    if (t.includes("unrelated")) return [0.0, 0.05, 0.99];
    return [0.1, 0.95, 0.1];
  };
  const state = { requests: 0, embedded: 0 };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      state.requests += 1;
      const parsed = JSON.parse(body);
      const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
      state.embedded += inputs.length;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: inputs.map((text, index) => ({ index, embedding: vectorFor(text) })) }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, state, port: server.address().port }));
  });
}

const PARAPHRASE_HOME = freshHome("muphys-v02emb-");
seedRegister(PARAPHRASE_HOME, [
  { id: "llg-target00001", title: "Confirm the fix is live in production", description: "A change is not done until it is verified live in production, not just merged.", status: "active", tags: ["ops"] },
  { id: "llg-decoy000001", title: "Deployment checklist hygiene", description: "Keep the deployment verify checklist versioned and reviewed.", status: "active", tags: ["ops"] },
  { id: "llg-noise000001", title: "Unrelated database tuning", description: "Completely unrelated indexing guidance.", status: "active", tags: ["db"] },
]);
// Paraphrase with near-zero useful lexical overlap with the target
// ("verify"/"deployment" appear in the DECOY, steering lexical the wrong way).
const PARAPHRASE = "verify the deployment actually shipped";

test("hybrid retrieval re-ranks a paraphrase the lexical scorer gets wrong", async () => {
  const { server, port } = await startFakeEmbeddings();
  try {
    const env = { ...process.env, MUPHYS_HOME: PARAPHRASE_HOME };
    const lexical = JSON.parse(await runCli(["query", PARAPHRASE], env));
    assert.equal(lexical.retriever, "lexical");
    assert.notEqual(lexical.lessons[0]?.id, "llg-target00001", "sanity: lexical alone must NOT already rank the paraphrase target first");
    const hybridEnv = { ...env, MUPHYS_EMBEDDINGS_URL: `http://127.0.0.1:${port}/v1/embeddings`, MUPHYS_EMBEDDINGS_MODEL: "fake-model" };
    const hybrid = JSON.parse(await runCli(["query", PARAPHRASE], hybridEnv));
    assert.equal(hybrid.retriever, "hybrid");
    assert.equal(hybrid.lessons[0].id, "llg-target00001", "embedding similarity must lift the true paraphrase to rank 1");
  } finally {
    server.close();
  }
});

test("embedding vectors are cached: a repeat query costs zero new embedding calls", async () => {
  const { server, state, port } = await startFakeEmbeddings();
  try {
    const env = {
      ...process.env,
      MUPHYS_HOME: PARAPHRASE_HOME,
      MUPHYS_EMBEDDINGS_URL: `http://127.0.0.1:${port}/v1/embeddings`,
      MUPHYS_EMBEDDINGS_MODEL: "fake-cache-model",
    };
    JSON.parse(await runCli(["query", PARAPHRASE], env));
    const afterFirst = state.embedded;
    assert.ok(afterFirst >= 4, "first run embeds the query and the register");
    const second = JSON.parse(await runCli(["query", PARAPHRASE], env));
    assert.equal(second.retriever, "hybrid");
    assert.equal(state.embedded, afterFirst, "second run must be served entirely from the cache");
  } finally {
    server.close();
  }
});

test("embedding backend failure is fail-open: lexical results, no error", () => {
  const env = {
    ...process.env,
    MUPHYS_HOME: PARAPHRASE_HOME,
    MUPHYS_EMBEDDINGS_URL: "http://127.0.0.1:1/v1/embeddings", // nothing listens here
    MUPHYS_EMBEDDINGS_MODEL: "fake-model",
    MUPHYS_EMBEDDINGS_TIMEOUT_MS: "600",
  };
  const result = JSON.parse(execFileSync("node", [CLI, "query", "deployment verify checklist"], { env, encoding: "utf8" }));
  assert.equal(result.retriever, "lexical", "a dead backend must degrade to lexical, never to an error");
  assert.ok(result.count >= 1, "lexical results still flow");
});
