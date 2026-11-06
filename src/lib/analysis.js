/* ───────────── Analysis orchestration ─────────────
   Everything that does not depend on something else starts at the same instant:

     ocr      → original_question_text                     fast model, no thinking
     words    → new_words                                  fast model, no thinking
     solve    → (hidden) verified answer brief             strong model, thinks, writes ~200 tokens
     lessonA  → first half of the explanation              fast model, needs no answer
     lessonB  → second half + tricks                       fast model, starts the moment `solve` has the answer

   The student-facing task "reason" = solve + lessonA + lessonB. The long lesson text used to be ONE sequential
   stream from a slow model; now it is two short streams written in parallel by a fast model, while the slow,
   careful thinking only has to produce a tiny brief. Lesson A is on screen while B is still being written.
   Each task streams into the UI as it is written and can be retried or stopped on its own. */

import { MODES } from "./config.js";
import { buildOcrPrompt, buildWordsPrompt, buildSolvePrompt, buildLessonAPrompt, buildLessonBPrompt, buildStudySummaryPrompt, buildStudyAPrompt, buildStudyBPrompt } from "./prompts.js";
import { fixText, looksGlitched, ARABIC_RULE } from "./text.js";
import { cleanOcr, cleanWords, cleanBrief, splitReason } from "./parse.js";
import { getModelLists, runTask } from "./gemini.js";
import { sourceParts, sourceNote } from "./docs.js";

export const TASK_KEYS = {
  ocr: ["original_question_text"],
  words: ["new_words"],
  reason: ["explanation", "tricks"],
};

const SIMPLE_CFG = {
  ocr: { tier: "fast", levels: ["minimal", "low"], budget: 0, maxOut: 4000, firstMs: 40000, idleMs: 30000, hedgeMs: 4500 },
  words: { tier: "fast", levels: ["low", "minimal"], budget: 512, maxOut: 12000, firstMs: 40000, idleMs: 30000, hedgeMs: 5500 },
};

const isAbort = (err) => !err || err.name === "AbortError";
const secs = (ms) => Math.round(ms / 100) / 10;

export function createAnalysis({ kind = "question", history, dataUrl, doc, extra, chips, apiKey, modeId, onUpdate, onDone, onError, onNotice }) {
  const L = kind === "lesson";                 // study material (books, notes, slides, pasted text) instead of one exam question
  const mode = MODES[modeId] || MODES.balanced;
  const wordsCap = L ? { a: Math.round(mode.write.words.a * 1.7), b: Math.round(mode.write.words.b * 1.4) } : mode.write.words;
  const lists = getModelLists(apiKey);
  const src = sourceParts(doc, dataUrl);       // the screenshot, the PDF or the text document
  const note = sourceNote(doc, extra, kind);   // "" for a plain screenshot
  const live = {};

  const fastFirst = [...lists.fast, ...lists.pro];
  const proFirst = [...lists.pro, ...lists.fast];

  /* one model call (hedged across the tier's models) */
  const stageOnce = (task, cfg, prompt, signal, onText) => runTask({
    apiKey, task,
    models: cfg.tier === "pro" ? proFirst : fastFirst,
    system: prompt.system + (L || task !== "ocr" ? ARABIC_RULE : ""),   // the OCR transcript must stay exactly as written
    parts: [...src, { text: note + prompt.user }],
    spec: { levels: cfg.levels, budget: cfg.budget },
    maxOut: cfg.maxOut, hedgeMs: cfg.hedgeMs, firstMs: cfg.firstMs, idleMs: cfg.idleMs,
    signal, onText,
    onNotice: onNotice ? (x) => onNotice(/^(solve|lesson)/.test(task) ? "reason" : task, x) : undefined,   // "Google is busy, trying again" → a calm note, not an error
  });

  /* the model now and then drops stray letters of another script, or Latin fragments, inside Arabic words.
     text.js removes them from the screen; when we see it we also ask for ONE clean rewrite (rare, so almost free). */
  const STRICT = "\n\nQUALITY ALERT: your previous attempt put stray letters of another script, or Latin fragments, inside Arabic words. Rewrite the whole answer carefully now: every Arabic word spelled completely with standard Arabic letters only; every English word whole and separate, with spaces around it.";
  const stage = async (task, cfg, prompt, signal, onText) => {
    const res = await stageOnce(task, cfg, prompt, signal, onText);
    if (signal.aborted || !(L || task !== "ocr") || /^solve/.test(task) || !looksGlitched(res.text)) return res;
    try { return await stageOnce(task, cfg, { ...prompt, system: prompt.system + STRICT }, signal, onText); }
    catch (e) { if (isAbort(e) || signal.aborted) throw e; return res; }
  };

  /* ── ocr + words: one stage each ── */
  const SIMPLE = {
    ocr: L
      ? { prompt: () => buildStudySummaryPrompt(chips, extra), apply: (full) => ({ original_question_text: fixText(String(full || "").replace(/^```[a-z]*\n?|\n?```$/gim, "").trim()) }) }
      : { prompt: () => buildOcrPrompt(), apply: (full) => ({ original_question_text: cleanOcr(full) }) },
    words: { prompt: () => buildWordsPrompt(chips, kind), apply: (full, final) => ({ new_words: cleanWords(full, final) }) },
  };

  function runSimple(name) {
    const def = SIMPLE[name];
    live[name]?.abort();
    const ctrl = new AbortController();
    live[name] = ctrl;

    const t0 = performance.now();
    let lastFull = "", ttft = null;
    stage(name, L && name === "words" ? { ...SIMPLE_CFG.words, maxOut: 14000 } : SIMPLE_CFG[name], def.prompt(), ctrl.signal, (full, model) => {
      if (ctrl.signal.aborted) return;
      if (ttft === null) ttft = performance.now() - t0;
      lastFull = full;
      onUpdate(name, def.apply(full, false), { chars: full.length, model, final: false });
    }).then(({ text, model }) => {
      if (ctrl.signal.aborted) return;
      onUpdate(name, def.apply(text, true), { chars: text.length, model, final: true });
      onDone(name, { ms: performance.now() - t0, chars: text.length, model, ttft });
    }).catch((err) => {
      if (isAbort(err) || ctrl.signal.aborted) return;
      onError(name, err, lastFull ? def.apply(lastFull, true) : null);
    });
  }

  /* ── reason = solve ∥ lessonA, then lessonB ── */
  function runReason() {
    live.reason?.abort();
    const ctrl = new AbortController();
    live.reason = ctrl;
    const sig = ctrl.signal;

    const t0 = performance.now();
    const since = () => performance.now() - t0;
    const S = { a: "", b: "", aDone: false, aFail: null, bDone: false, bFail: null, aModel: "", bModel: "", t: {} };
    let over = false;

    /* What the student sees: part A as it streams; part B is appended once A is complete, so the text he is
       already reading never jumps. `tricks` comes from B's second marker. */
    const compose = (final) => {
      const a = splitReason(S.a, final || S.aDone).explanation;
      const b = splitReason(S.b, final);
      const withB = final || S.aDone || !!S.aFail;
      const text = withB ? [a, b.explanation].filter(Boolean).join("\n") : a;
      return { explanation: text || (final ? "" : null), tricks: b.tricks };
    };
    const chars = () => S.a.length + S.b.length;
    const emit = (final) => {
      if (over || sig.aborted) return;
      onUpdate("reason", compose(final), { chars: chars(), model: S.bModel || S.aModel, final });
    };
    const fail = (err) => {
      if (over || sig.aborted) return;
      over = true;
      ctrl.abort(); // stop whatever is still running
      onError("reason", err, S.a || S.b ? compose(true) : null);
    };
    const settle = () => {
      if (over || sig.aborted) return;
      if (!(S.aDone || S.aFail) || !(S.bDone || S.bFail)) return;
      const err = S.bFail || S.aFail;
      if (err) return fail(err);
      over = true;
      onUpdate("reason", compose(true), { chars: chars(), model: S.bModel, final: true });
      onDone("reason", {
        ms: since(), chars: chars(), model: S.bModel,
        stages: { solve: secs(S.t.solve || 0), a: secs(S.t.a || 0), b: secs(since()) },
      });
    };

    /* the careful, silent stage (study material has no single answer to verify → part B starts at once) */
    if (L) { S.t.solve = 0; startB(null); }
    else stage(`solve:${mode.id}`, mode.solve, buildSolvePrompt(), sig, () => {})
      .then(({ text }) => { S.t.solve = since(); startB(cleanBrief(text) || null); })
      .catch((err) => {
        if (isAbort(err) || sig.aborted) return;
        if (err.fatal) return fail(err);
        S.t.solve = since();
        startB(null); // could not get a verified brief → lesson B solves it by itself
      });

    /* part A: no answer needed → starts together with `solve` */
    stage(`lessonA:${mode.id}`, mode.writeA || mode.write, L ? buildStudyAPrompt({ history, extra, chips, words: wordsCap.a }) : buildLessonAPrompt({ history, extra, chips, words: wordsCap.a }), sig, (full, model) => {
      S.a = full; S.aModel = model; emit(false);
    }).then(({ text, model }) => {
      S.a = text; S.aModel = model; S.aDone = true; S.t.a = since();
      emit(false); settle();
    }).catch((err) => {
      if (isAbort(err) || sig.aborted) return;
      if (err.fatal) return fail(err);
      S.aFail = err; emit(false); settle();
    });

    /* part B: steps · options · answer · memo · tricks */
    function startB(brief) {
      if (over || sig.aborted) return;
      const cfg = brief || L
        ? mode.write
        : { ...mode.write, tier: mode.solve.tier, levels: mode.solve.levels, budget: mode.solve.budget,
            maxOut: mode.write.maxOut + mode.solve.maxOut, hedgeMs: mode.solve.hedgeMs, idleMs: mode.solve.idleMs, firstMs: mode.solve.firstMs };
      stage(`${brief ? "lessonB" : "lessonBx"}:${mode.id}`, cfg, L ? buildStudyBPrompt({ history, extra, chips, words: wordsCap.b }) : buildLessonBPrompt({ history, brief, extra, chips, words: wordsCap.b }), sig, (full, model) => {
        S.b = full; S.bModel = model; emit(false);
      }).then(({ text, model }) => {
        S.b = text; S.bModel = model; S.bDone = true;
        settle();
      }).catch((err) => {
        if (isAbort(err) || sig.aborted) return;
        if (err.fatal) return fail(err);
        S.bFail = err; settle();
      });
    }
  }

  function run(name) {
    if (name === "reason") runReason();
    else runSimple(name);
  }

  return {
    start() { ["ocr", "reason", "words"].forEach(run); }, // ocr first: it is what the student sees first
    retry(name) { if (TASK_KEYS[name]) run(name); },
    stop(name) { live[name]?.abort(); },
    cancel() { Object.values(live).forEach((c) => c.abort()); },
  };
}
