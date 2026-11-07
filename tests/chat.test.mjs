import test from "node:test";
import assert from "node:assert/strict";
import { installFetch, script, reset, log } from "./mockfetch.mjs";
import * as R from "../src/lib/router.js";
import { setExtKeys, setEnginePrefs } from "../src/lib/providers.js";
import { isBigAsk, cleanOutline, compose, runSliced } from "../src/lib/chatflow.js";
import { createFileCache } from "../src/lib/gfiles.js";

installFetch();

test("isBigAsk: only genuinely big requests", () => {
  for (const t of ["اشرحلي أمراض القلب بالتفصيل", "اعملي ملخص شامل للفصل ده", "explain heart failure in detail and in depth", "Give me a complete guide to insulin"]) assert.ok(isBigAsk(t), t);
  for (const t of ["ليه الإجابة B؟", "كمّل", "what does NPO mean?", "اديني مثال شبهه"]) assert.ok(!isBigAsk(t), t);
  assert.ok(isBigAsk("لخصلي الملف ده", { files: 1 }));                          // "summarise the file" is a big ask
  assert.ok(!isBigAsk("اشرح ده", { files: 1 }));                                 // too short
  assert.ok(isBigAsk("لخصلي الملف اللي رفعته ده كله لو سمحت", { files: 1 }));
});

test("cleanOutline: 2–4 sections, rejects junk and single sections", () => {
  assert.equal(cleanOutline("not json"), null);
  assert.equal(cleanOutline('{"sections":[{"title":"A","focus":"x"}]}'), null);
  const o = cleanOutline('```json\n{"sections":[{"title":"A","focus":"a"},{"title":"B"},{"title":"C"},{"title":"D"}]}\n```', 3);
  assert.deepEqual(o.map((s) => s.title), ["A", "B", "C"]);
});

test("compose: sections appear in order and never jump", () => {
  assert.equal(compose(["one", "two", ""], [false, true, false], false), "one");
  assert.equal(compose(["one", "two", ""], [true, false, false], false), "one\n\ntwo");
  assert.equal(compose(["one", "two", "three"], [true, true, true], true), "one\n\ntwo\n\nthree");
});

test("runSliced: sections are written AT THE SAME TIME (wall clock ≈ the longest one, not the sum)", async () => {
  const t0 = Date.now();
  const ask = async (kind, cb) => {
    if (kind === "plan") return { text: '{"sections":[{"title":"أ"},{"title":"ب"},{"title":"ج"}]}' };
    await new Promise((r) => setTimeout(r, 300));
    cb && cb("part " + kind.slice, "m");
    return { text: "## " + kind.outline[kind.slice].title + "\nbody", model: "m" };
  };
  const shown = [];
  const r = await runSliced({ ask, onText: (t) => shown.push(t) });
  assert.ok(Date.now() - t0 < 700, "three 300 ms writers took " + (Date.now() - t0));
  assert.equal(r.sections, 3);
  assert.equal(r.text, "## أ\nbody\n\n## ب\nbody\n\n## ج\nbody");
  assert.ok(shown.every((t) => !t.includes("## ب") || t.includes("## أ")), "section 2 never shows before section 1");
});

test("runSliced: a bad plan falls back to the normal single answer; one failed section keeps the others and says which", async () => {
  assert.deepEqual(await runSliced({ ask: async () => ({ text: "nonsense" }) }), { sliced: false });
  const ask = async (kind) => {
    if (kind === "plan") return { text: '{"sections":[{"title":"A"},{"title":"B"}]}' };
    if (kind.slice === 1) throw Object.assign(new Error("boom"), { detail: "d" });
    return { text: "## A\nbody", model: "m" };
  };
  let shown = "";
  await assert.rejects(runSliced({ ask, onText: (t) => { shown = t; } }), (e) => /«B»/.test(e.message) && e.partial.includes("## A"));
  assert.ok(shown.includes("## A"));
});

test("file cache: an upload is remembered and not repeated (chat turns, restarts)", async () => {
  const mem = {}; const store = { load: () => JSON.parse(JSON.stringify(mem.m || {})), save: (m) => { mem.m = m; } };
  let uploads = 0;
  const upload = async () => { uploads++; return { fileUri: "https://g/files/abc", mimeType: "application/pdf" }; };
  const big = { inlineData: { mimeType: "application/pdf", data: "A".repeat(1_200_000) } };
  const mk = () => createFileCache({ apiKey: "AIzaKEY12345678", upload, persist: true, store });
  const c1 = mk(); const out1 = await c1.swap([big, { text: "q1" }]);
  assert.equal(out1[0].fileData.fileUri, "https://g/files/abc");
  const c2 = mk(); const out2 = await c2.swap([big, { text: "q2" }]);         // a later chat turn
  assert.equal(out2[0].fileData.fileUri, "https://g/files/abc");
  assert.equal(uploads, 1, "uploaded once for the whole conversation");
  const c3 = createFileCache({ apiKey: "AIzaOTHERKEY0000", upload, persist: true, store });   // another key = another project: its own upload
  await c3.swap([big]);
  assert.equal(uploads, 2);
  c2.disable();                                                                // Google refused the link → forgotten
  assert.deepEqual(store.load(), {});
});

test("askChat end-to-end: a short question = ONE request with low thinking; a big one = plan + parallel sections", async () => {
  const { askChat, thinkFor } = await import("../src/lib/chat.js");
  assert.deepEqual(thinkFor("what does NPO mean?").levels, ["low", "minimal"]);
  assert.deepEqual(thinkFor("أنا معترض على الإجابة").levels, ["medium", "low"]);

  reset(); R.__resetRouter(); window.localStorage.clear(); setExtKeys({}); setEnginePrefs({ mode: "auto", slice: true });
  const key = "AIzaCHATKEY00001";
  const history = (t) => [{ role: "user", text: t }];
  const ctx = { kind: "global" };
  await askChat({ apiKey: key, history: history("what does NPO mean?"), ctx, onText() {} });
  const calls1 = log.filter((l) => l.lane !== "list");
  assert.equal(calls1.length, 1);
  assert.equal(calls1[0].body.generationConfig.thinkingConfig.thinkingLevel, "low");

  reset(); R.__resetRouter();
  script("gemini:gemini-flash-latest", { ok: '{"sections":[{"title":"A","focus":"a"},{"title":"B","focus":"b"}]}' }, { ok: "## X\ntext" });
  const out = await askChat({ apiKey: key, history: history("اشرحلي أمراض القلب بالتفصيل"), ctx, onText() {} });
  const calls2 = log.filter((l) => l.lane !== "list");
  assert.equal(calls2.length, 3, "1 plan + 2 sections");
  assert.ok(out.text.includes("## X"));
  // the system prompt of every section is identical to the normal one + the section instruction (cache-friendly prefix)
  assert.ok(calls2[1].body.systemInstruction.parts[0].text.includes("PARALLEL WRITING"));
});
