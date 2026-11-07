import test from "node:test";
import assert from "node:assert/strict";
import { installFetch, script, reset, log } from "./mockfetch.mjs";
import * as R from "../src/lib/router.js";
import { setExtKeys, setEnginePrefs, PROVIDERS, pickLanes, stripThink } from "../src/lib/providers.js";
import { runTask } from "../src/lib/gemini.js";

installFetch();
let KEY = "AIzaTESTKEY0001", seq = 0;
const G = (m) => `gemini:${m}`;
const base = (over = {}) => ({
  apiKey: KEY, task: "lesson:chat", system: "sys", parts: [{ text: "hi" }], spec: { levels: ["low"], budget: 0 },
  maxOut: 2000, firstMs: 3000, idleMs: 3000, ...over,
});
const fresh = (mode = "auto", keys = {}) => {
  KEY = `AIzaTESTKEY${String(++seq).padStart(6, "0")}`;           // the app remembers dead models per key: a new key = a clean slate
  reset(); R.__resetRouter(); window.localStorage.clear();
  setExtKeys(keys); setEnginePrefs({ mode });
  R.HEDGE_MS.chat = { min: 120, max: 250 }; R.HEDGE_MS.write = { min: 120, max: 250 }; R.HEDGE_MS.quick = { min: 120, max: 250 };
};
const lanesUsed = () => log.filter((l) => l.lane !== "list").map((l) => l.lane);

test("taskClass maps every task name the app uses", () => {
  const c = R.taskClass;
  assert.equal(c("ocr"), "ocr"); assert.equal(c("batch:detect"), "ocr"); assert.equal(c("solve:deep"), "solve");
  assert.equal(c("lesson:chat"), "chat"); assert.equal(c("lesson:topic"), "chat");
  for (const t of ["lessonA:balanced", "lessonB:deep", "lessonBx:balanced", "lessonM:balanced", "lessonT:balanced", "lessonX:balanced", "lessonS", "lessonH", "exam:part"]) assert.equal(c(t), "write", t);
  for (const t of ["words", "word:tr", "topics:org", "lesson:diagram"]) assert.equal(c(t), "quick", t);
});

test("planLanes balances equal-quality lanes by live load (three parallel stages → three models)", () => {
  R.__resetRouter();
  const models = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"];
  const pick = () => { const p = R.planLanes({ geminiModels: models, cls: "write", mode: "auto", media: { any: false } }); return p.lanes[0]; };
  const a = pick(); const endA = R.begin(a.id);
  const b = pick(); const endB = R.begin(b.id);
  assert.notEqual(a.id, b.id, "second request must go to the other flash lane");
  assert.equal(a.kind, "flash"); assert.equal(b.kind, "flash");
  const c = pick();
  assert.equal(c.kind, "flash", "a lite lane is never chosen while two flash lanes exist");
  endA(); endB();
});

test("lite lanes are not 'equivalent' to flash lanes, and a cooling lane sinks", () => {
  R.__resetRouter();
  const models = ["gemini-3.8-flash", "gemini-3.6-flash"];
  R.noteBusy(G("gemini-3.8-flash"), { status: 429, retryAfterMs: 20000 });
  const p = R.planLanes({ geminiModels: models, cls: "write", mode: "auto", media: { any: false } });
  assert.equal(p.lanes[0].model, "gemini-3.6-flash");
});

test("external lanes never receive PDFs, and never prompts bigger than their token window", () => {
  R.__resetRouter();
  const ext = pickLanes("groq", [{ id: "openai/gpt-oss-120b" }]);
  assert.equal(ext.length, 1);
  assert.equal(R.fits(ext[0], { media: { any: true, pdf: true }, tokens: 100 }), false);
  assert.equal(R.fits(ext[0], { media: { any: false }, tokens: 9000 }), false);
  assert.equal(R.fits(ext[0], { media: { any: false }, tokens: 3000 }), true);
});

test("pickLanes chooses by preference, skips junk, and OpenRouter keeps only the two biggest :free models", () => {
  const g = pickLanes("groq", [{ id: "whisper-large-v3" }, { id: "openai/gpt-oss-20b" }, { id: "openai/gpt-oss-120b" }, { id: "llama-guard-4" }]);
  assert.deepEqual(g.map((l) => l.model), ["openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
  const o = pickLanes("openrouter", [
    { id: "a/small-8b:free", context_length: 32000 }, { id: "b/big-120b:free", context_length: 128000 },
    { id: "c/mid-31b:free", context_length: 128000 }, { id: "d/paid-70b", pricing: { prompt: "0.1", completion: "0.2" } },
    { id: "e/vision-90b:free", context_length: 100000 },
  ]);
  assert.deepEqual(o.map((l) => l.model), ["b/big-120b:free", "c/mid-31b:free"]);
});

test("stripThink hides finished, unfinished and half-written think blocks", () => {
  assert.equal(stripThink("<think>abc</think>Hello"), "Hello");
  assert.equal(stripThink("Hello<think>still thinking"), "Hello");
  assert.equal(stripThink("Hello<thi"), "Hello");
  assert.equal(stripThink("a < b"), "a < b");
});

test("happy path: one Gemini lane answers and streams", async () => {
  fresh();
  const seen = [];
  const r = await runTask(base({ models: ["gemini-3.8-flash"], onText: (t) => seen.push(t) }));
  assert.equal(r.text, "hello from gemini:gemini-3.8-flash");
  assert.ok(seen.length > 1, "streamed in several pieces");
  assert.equal(r.model, "gemini-3.8-flash");
});

test("FAILOVER: a 429 on the first model moves to the next model at once — no waiting", async () => {
  fresh();
  script(G("gemini-3.8-flash"), { status: 429, msg: "Quota exceeded for metric PerMinute, limit: 5", retry: 30 });
  const t0 = Date.now();
  const r = await runTask(base({ task: "lessonA:balanced", models: ["gemini-3.8-flash", "gemini-3.6-flash"] }));
  const ms = Date.now() - t0;
  assert.equal(r.model, "gemini-3.6-flash");
  assert.ok(ms < 800, `failover took ${ms} ms (old engine: 2000+ ms of backoff)`);
  assert.deepEqual(lanesUsed(), [G("gemini-3.8-flash"), G("gemini-3.6-flash")]);
  assert.ok(R.isCooling(G("gemini-3.8-flash")), "the busy lane sleeps for Google's hint");
});

test("a lane that is asleep is skipped by the NEXT request (no wasted round trip)", async () => {
  fresh();
  script(G("gemini-3.8-flash"), { status: 503, msg: "overloaded" });
  await runTask(base({ task: "lessonA:balanced", models: ["gemini-3.8-flash", "gemini-3.6-flash"] }));
  log.length = 0;
  await runTask(base({ task: "lessonA:balanced", models: ["gemini-3.8-flash", "gemini-3.6-flash"] }));
  assert.deepEqual(lanesUsed(), [G("gemini-3.6-flash")]);
});

test("a DAILY quota 429 makes the lane dead and the next lane answers", async () => {
  fresh();
  script(G("gemini-3.8-flash"), { status: 429, msg: "Quota exceeded: GenerateRequestsPerDayPerProjectPerModel-FreeTier, limit: 20" });
  const r = await runTask(base({ task: "words", models: ["gemini-3.8-flash", "gemini-3.5-flash-lite"] }));
  assert.equal(r.model, "gemini-3.5-flash-lite");
  assert.ok(R.isDead(G("gemini-3.8-flash")));
});

test("HEDGING: a silent first lane is raced by the second; the first sign of life wins and the loser is cancelled", async () => {
  fresh();
  script(G("gemini-3.8-flash"), { wait: 5000, ok: "slow" });
  script(G("gemini-3.6-flash"), { ok: "fast answer" });
  const t0 = Date.now();
  const r = await runTask(base({ task: "lessonA:balanced", models: ["gemini-3.8-flash", "gemini-3.6-flash"] }));
  assert.equal(r.text, "fast answer");
  assert.ok(Date.now() - t0 < 1500, "did not wait for the silent lane");
  assert.equal(lanesUsed().length, 2);
});

test("auto mode, chat: when Google is slow, the extra free engine (Groq) answers", async () => {
  fresh("auto", { groq: "gsk_test" });
  script(G("gemini-3.8-flash"), { wait: 5000, ok: "slow" });
  script("groq:openai/gpt-oss-120b", { ok: "groq says hi" });
  const r = await runTask(base({ models: ["gemini-3.8-flash"] }));
  assert.equal(r.text, "groq says hi");
  assert.equal(r.provider, "groq");
});

test("speed mode, chat: the fast lane goes FIRST and Google is not touched", async () => {
  fresh("speed", { groq: "gsk_test" });
  const r = await runTask(base({ models: ["gemini-3.8-flash"] }));
  assert.equal(r.provider, "groq");
  assert.deepEqual(lanesUsed(), ["groq:openai/gpt-oss-120b"]);
  const body = log.find((l) => l.lane.startsWith("groq")).body;
  assert.equal(body.reasoning_effort, "low");
  assert.equal(body.messages[0].role, "system");
});

test("quality mode never hands a lesson to an extra engine while Gemini is available", async () => {
  fresh("quality", { groq: "gsk_test" });
  script(G("gemini-3.8-flash"), { wait: 600, ok: "gemini wrote it" });
  const r = await runTask(base({ task: "lessonA:balanced", models: ["gemini-3.8-flash"] }));
  assert.equal(r.provider, "gemini");
  assert.ok(!lanesUsed().some((l) => l.startsWith("groq")));
});

test("write tasks (lessons) in auto mode use Groq only as a LAST resort, after every Gemini lane failed", async () => {
  fresh("auto", { groq: "gsk_test" });
  script(G("gemini-3.8-flash"), { status: 503, msg: "overloaded" });
  script(G("gemini-3.6-flash"), { status: 503, msg: "overloaded" });
  const r = await runTask(base({ task: "lessonM:balanced", models: ["gemini-3.8-flash", "gemini-3.6-flash"] }));
  assert.equal(r.provider, "groq");
  assert.deepEqual(lanesUsed().slice(0, 2).sort(), [G("gemini-3.6-flash"), G("gemini-3.8-flash")].sort());
});

test("a PDF/scan stays on Gemini: no extra engine is ever asked to read it", async () => {
  fresh("speed", { groq: "gsk_test" });
  const parts = [{ inlineData: { mimeType: "application/pdf", data: "AAAA" } }, { text: "read it" }];
  const r = await runTask(base({ task: "ocr", parts, models: ["gemini-3.8-flash"] }));
  assert.equal(r.provider, "gemini");
  assert.ok(!lanesUsed().some((l) => l.startsWith("groq")));
});

test("a prompt too big for Groq's 8K-token minute window is not sent there", async () => {
  fresh("speed", { groq: "gsk_test" });
  const big = "x".repeat(30000);                                      // ≈ 10,000 tokens
  const r = await runTask(base({ parts: [{ text: big }], models: ["gemini-3.8-flash"] }));
  assert.equal(r.provider, "gemini");
});

test("a Groq reply that hit the token limit is never shown as complete: Gemini rewrites it", async () => {
  fresh("speed", { groq: "gsk_test" });
  script("groq:openai/gpt-oss-120b", { ok: "half an ans", finish: "length" });
  const r = await runTask(base({ models: ["gemini-3.8-flash"] }));
  assert.equal(r.provider, "gemini");
});

test("a bad extra key never kills the task and the lane is put aside", async () => {
  fresh("speed", { groq: "gsk_bad" });
  script("groq:openai/gpt-oss-120b", { status: 401, msg: "Invalid API Key" });
  const r = await runTask(base({ models: ["gemini-3.8-flash"] }));
  assert.equal(r.provider, "gemini");
  assert.ok(R.isDead("groq:openai/gpt-oss-120b"));
});

test("when EVERY lane sleeps the engine waits for the first to wake (and says so), then answers", async () => {
  fresh();
  script(G("gemini-3.8-flash"), { status: 429, msg: "limit PerMinute", retry: 1 }, { ok: "back again" });
  const notes = [];
  const r = await runTask(base({ task: "words", models: ["gemini-3.8-flash"], onNotice: (n) => notes.push(n) }));
  assert.equal(r.text, "back again");
  assert.equal(notes.length, 1);
  assert.ok(notes[0].waitMs >= 900 && notes[0].waitMs < 2500);
});

test("Google asking for a long pause (>25 s) → an honest 'busy' at once, not a silent minute", async () => {
  fresh();
  script(G("gemini-3.8-flash"), { status: 429, msg: "limit PerMinute", retry: 45 });
  await assert.rejects(runTask(base({ task: "words", models: ["gemini-3.8-flash"] })), (e) => e.busy === true);
});

test("a bad Google key stops at once (and does not burn other lanes)", async () => {
  fresh();
  script(G("gemini-3.8-flash"), { status: 400, msg: "API key not valid. Please pass a valid API key." });
  await assert.rejects(runTask(base({ models: ["gemini-3.8-flash", "gemini-3.6-flash"] })), (e) => e.fatal === true);
  assert.equal(lanesUsed().length, 1);
});

test("abort: cancelling stops every running lane", async () => {
  fresh();
  script(G("gemini-3.8-flash"), { wait: 5000, ok: "x" });
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 80);
  await assert.rejects(runTask(base({ models: ["gemini-3.8-flash", "gemini-3.6-flash"], signal: ctrl.signal })), (e) => e.name === "AbortError");
});

test("the Google usage meter does not count extra-engine requests", async () => {
  fresh("speed", { groq: "gsk_test" });
  const { readUsage } = await import("../src/lib/usage.js");
  const before = readUsage().total;
  await runTask(base({ models: ["gemini-3.8-flash"] }));
  const u = readUsage();
  assert.equal(u.total, before);
  assert.equal(u.ext, 1);
});
