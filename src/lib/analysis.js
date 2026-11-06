/* ───────────── Analysis orchestration ─────────────
   v3.23 — FEWER REQUESTS (Google's quota counts every one):

     ocr      → original_question_text                     fast model, no thinking
     words    → new_words                                  fast model, no thinking
     reason   → explanation + tricks   ONE request          fast model (balanced) — writes the lesson AND the traps together
                                        deep mode: a strong model first solves silently (solve), then the same single lesson request

   Before: ocr + words + solve + lessonA + lessonB = 5 requests (6-8 with glitch rewrites / duplicate fallbacks).
   Now:    ocr + words + reason                    = 3 requests (balanced) or 4 (deep, for the extra-careful solve).
   The lesson is still streamed token by token into the UI, and the "===EXPLANATION=== / ===TRICKS===" markers split it into the
   two cards. Each task can be retried or stopped on its own. */

import { MODES } from "./config.js";
import { buildOcrPrompt, buildWordsPrompt, buildSolvePrompt, buildLessonPrompt, buildStudySummaryPrompt, buildStudyLessonPrompt } from "./prompts.js";
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
  ocr: { tier: "fast", levels: ["minimal", "low"], budget: 0, maxOut: 4000, firstMs: 40000, idleMs: 30000 },
  words: { tier: "fast", levels: ["low", "minimal"], budget: 512, maxOut: 12000, firstMs: 40000, idleMs: 30000 },
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

  /* one model call (one request at a time; busy → retried with backoff inside runTask) */
  const stageOnce = (task, cfg, prompt, signal, onText) => runTask({
    apiKey, task,
    models: cfg.tier === "pro" ? proFirst : fastFirst,
    system: prompt.system + (L || task !== "ocr" ? ARABIC_RULE : ""),   // the OCR transcript must stay exactly as written
    parts: [...src, { text: note + prompt.user }],
    spec: { levels: cfg.levels, budget: cfg.budget },
    maxOut: cfg.maxOut, firstMs: cfg.firstMs, idleMs: cfg.idleMs,
    signal, onText,
    onNotice: onNotice ? (x) => onNotice(/^(solve|lesson)/.test(task) ? "reason" : task, x) : undefined,   // "Google is busy, trying again (n of 3)" → a calm note, not an error
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

  /* ── reason = ONE lesson request (deep mode: a silent strong-model solve first) ── */
  function runReason() {
    live.reason?.abort();
    const ctrl = new AbortController();
    live.reason = ctrl;
    const sig = ctrl.signal;

    const t0 = performance.now();
    const since = () => performance.now() - t0;
    let text = "", model = "", tSolve = 0, over = false;

    const compose = (final) => {
      const r = splitReason(text, final);
      return { explanation: r.explanation || (final ? "" : null), tricks: r.tricks };
    };
    const emit = (final) => {
      if (over || sig.aborted) return;
      onUpdate("reason", compose(final), { chars: text.length, model, final });
    };
    const fail = (err) => {
      if (over || sig.aborted) return;
      over = true;
      ctrl.abort();
      onError("reason", err, text ? compose(true) : null);
    };

    /* the single request that writes explanation + tricks */
    function writeLesson(brief) {
      if (over || sig.aborted) return;
      const words = wordsCap.a + wordsCap.b;
      /* no verified brief (balanced mode, or the solve stage failed) → this request also has to solve, so it gets the "solve" thinking budget */
      const solo = !L && !brief;
      const cfg = solo
        ? { ...mode.write, tier: mode.solve.tier, levels: mode.solve.levels, budget: mode.solve.budget,
            maxOut: mode.write.maxOut + mode.solve.maxOut, idleMs: mode.solve.idleMs, firstMs: mode.solve.firstMs }
        : L ? (mode.writeA || mode.write) : mode.write;
      const prompt = L ? buildStudyLessonPrompt({ history, extra, chips, words }) : buildLessonPrompt({ history, brief, extra, chips, words });
      stage(`lesson${brief ? "B" : "X"}:${mode.id}`, cfg, prompt, sig, (full, m) => {
        text = full; model = m; emit(false);
      }).then((res) => {
        if (over || sig.aborted) return;
        text = res.text; model = res.model; over = true;
        onUpdate("reason", compose(true), { chars: text.length, model, final: true });
        onDone("reason", { ms: since(), chars: text.length, model, stages: { solve: secs(tSolve), total: secs(since()) } });
      }).catch((err) => {
        if (isAbort(err) || sig.aborted) return;
        fail(err);
      });
    }

    /* deep mode only: a careful, silent strong-model solve → its short verified brief grounds the lesson.
       Balanced mode skips it (the lesson request thinks by itself): 3 requests per analysis instead of 5. */
    if (L || mode.id !== "deep") writeLesson(null);
    else stage(`solve:${mode.id}`, mode.solve, buildSolvePrompt(), sig, () => {})
      .then(({ text: t }) => { tSolve = since(); writeLesson(cleanBrief(t) || null); })
      .catch((err) => {
        if (isAbort(err) || sig.aborted) return;
        if (err.fatal || err.busy) return fail(err);   // Google is overloaded: another request right now would only make it worse
        tSolve = since();
        writeLesson(null);                              // no verified brief → the lesson request solves it by itself
      });
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
