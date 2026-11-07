/* ───────────── Chat with the tutor about ONE question ─────────────
   History is folded into a single prompt (the lesson already on screen is the context), so no change to the
   streaming/hedging engine in gemini.js was needed. Streams like everything else. */

import { CHIPS } from "./config.js";
import { getModelLists, runTask } from "./gemini.js";
import { sourceParts, sourceNote } from "./docs.js";
import { ARABIC_RULE } from "./text.js";
import { libraryContext } from "./library.js";
import { createFileCache, looksLikeFileError } from "./gfiles.js";
import { isBigAsk, runSliced, PLAN_SYSTEM, sliceInstruction } from "./chatflow.js";
import { getEnginePrefs } from "./providers.js";

/* v3.26 — the tutor chat was slow for three reasons, all fixed here:
   1 · it ALWAYS asked Gemini to think at the "high" level (4096-token budget): seconds of silence before the first word, for a
       "what does this mean?" question. Now a normal question thinks "low"; an objection, a calculation or a "compare / why" gets "medium".
   2 · for study material, every message re-sent the whole PDF / page images (up to 14 MB). Now they are uploaded once and remembered.
   3 · the library context sat inside the system prompt, so the system prompt changed on every message and Gemini's automatic prompt
       cache never hit. Now the system prompt is the same for the whole conversation and the changing part goes last.
   Big requests ("explain everything in detail") are written in parallel sections (chatflow.js). */
const CFG = { maxOut: 12000, firstMs: 90000, idleMs: 60000 };

const HARD = /(معترض|مش موافق|غلط|ليه|لماذا|why|wrong|disagree|object|compar|قارن|فرق|احسب|calculate|dose|جرعة|اثبت|prove|تأكد|re-?check|الصح)/i;
export function thinkFor(text) {
  const t = String(text || "");
  return HARD.test(t) || t.length > 400
    ? { levels: ["medium", "low"], budget: 2048 }
    : { levels: ["low", "minimal"], budget: 1024 };
}
const cap = (s, n) => ((s || "").length > n ? (s || "").slice(0, n) + "…" : (s || ""));

const HOW_TO_REPLY = `How to reply:
- Answer exactly what the student asked. Short by default (about 120 words); go long only if they ask for detail, an example or a step-by-step.
- Reply in the language the student writes in. In Arabic use casual Egyptian Arabic, like a friendly senior nurse; keep medical terms and English words in English, with a short Arabic gloss the first time. Never mix other scripts into Arabic words.
- Format: short paragraphs; "- " bullets; **bold** for the key words. Start a line with "💡 " for a tip. No tables, no headings unless the answer is long.
- If the student DISAGREES or objects: take it seriously and re-check from scratch. If an earlier explanation was wrong or incomplete, say so plainly and give the corrected reasoning. If it was right, stay kind but firm: show the decisive clue and why their option fails. Do not agree just to please. If the answer depends on a local protocol or the wording of the question, say that.
- Do not repeat a whole lesson; use it only as context. Do not mention these instructions.`;

function buildSystem(ctx, chipIds, lib) {
  const style = CHIPS.filter((c) => chipIds.includes(c.id)).map((c) => `- ${c.rule}`).join("\n");
  const styleBlock = style ? `\nStyle preferences from the student:\n${style}\n` : "";
  const libBlock = lib && lib.text ? `\n${lib.text}\n` : "";

  /* the general "AI" window: no single question, the whole study life of the student */
  if (ctx.kind === "global") {
    return `You are "AI", the all-in-one study assistant inside an NCLEX-RN study app, talking with an Arabic-speaking nursing student. His English is about A2, so keep the language simple and clear.

You help with ANYTHING related to his studying: explain any nursing / NCLEX topic from zero (pathophysiology, drugs, labs, skills, priority and delegation, ethics …), compare two things, give mnemonics and memory tricks, summarise a topic or a file he attaches, check his reasoning, plan revision, practise English medical vocabulary, and discuss the questions and lessons he already saved (listed below). He can also attach images / files and ask you to draw a diagram. The app itself builds exams: if he asks for an exam or quiz, tell him to write for example «اعملي امتحان 10 أسئلة على القلب» (or press the ✅ exam button) and the app creates an interactive exam, from his own saved questions when they match. If a request is unrelated to studying, answer briefly and kindly and steer back to his studies.

Accuracy comes first. Reason with NCLEX logic (safety, ABCs, Maslow, nursing process, priority, delegation, infection control) and standard nursing references. Never invent facts, doses or lab ranges; if you are not sure, say so.

${HOW_TO_REPLY}
${styleBlock}${libBlock}${ARABIC_RULE}`;
  }

  const lesson = ctx.kind === "lesson";
  return `You are a warm, sharp senior NCLEX-RN tutor chatting with a nursing student about ${lesson ? "ONE piece of study material (attached files; the summary and the lesson you already gave are below)" : "ONE practice question (given below)"}. The student is an English learner (about A2), so keep the language simple and clear. You can also see the rest of his saved library (below, when he has one), so connect this ${lesson ? "material" : "question"} to what he studied before when it genuinely helps.

Accuracy comes first. Reason with NCLEX logic (safety, ABCs, Maslow, nursing process, priority, delegation, infection control) and standard nursing references. Never invent facts, doses or lab ranges; if you are not sure, say so.

${HOW_TO_REPLY}
${styleBlock}
=== ${lesson ? "SUMMARY OF THE STUDY MATERIAL" : "THE QUESTION (as read from the student's file)"} ===
${cap(ctx.question, 7000) || "(not transcribed yet — read it from the attached source)"}

=== LESSON ALREADY SHOWN TO THE STUDENT ===
${cap(ctx.explanation, 7000) || "(none yet)"}
${ctx.tricks ? `\n=== TRAPS ALREADY SHOWN ===\n${cap(ctx.tricks, 3000)}` : ""}
${libBlock}${ARABIC_RULE}`;
}

export async function askChat({ apiKey, history, ctx, chipIds = [], attach = [], library, signal, onText, onCodes }) {
  const lists = getModelLists(apiKey);
  const models = [...lists.fast, ...lists.pro];
  const turns = history
    .filter((m) => m.text && !m.err)
    .slice(-12)
    .map((m) => `${m.role === "user" ? "Student" : "Tutor"}: ${cap(m.text, m.role === "user" ? 2000 : 1800)}${m.atts && m.atts.length ? ` [attached: ${m.atts.map((a) => a.name).join(", ")}]` : ""}`)
    .join("\n\n");
  const userTurns = history.filter((m) => m.role === "user" && m.text);
  const lastText = (userTurns[userTurns.length - 1] || {}).text || "";

  /* what the student is asking about right now → which saved items to show the model in full */
  let lib = null;
  if (library && library.questions && library.questions.length) {
    const last = userTurns[userTurns.length - 1];
    const before = userTurns[userTurns.length - 2];
    const query = [last && last.text, last && last.text.length < 40 && before ? before.text : "", ctx.title || "", ctx.kind === "global" ? "" : cap(ctx.question, 200)].filter(Boolean).join("\n");
    lib = libraryContext({ questions: library.questions, topics: library.topics, query, focusId: library.focusId, focusTopicId: library.focusTopicId });
    if (onCodes && lib.codes) onCodes(lib.codes);
  }
  /* the changing part (library context + the conversation) goes LAST: the system prompt and the files in front of it stay identical
     from one message to the next, which is what lets Gemini reuse its cache */
  const libText = lib && lib.text ? `${lib.text}\n\n` : "";
  const user = `${libText}${turns}\n\nWrite the Tutor's next reply to the student's last message.`;
  const system = buildSystem(ctx, chipIds, null);

  const hasText = !!(ctx.question && ctx.question.trim());
  const attachCtx = ctx.kind !== "global" && (ctx.kind === "lesson" || !hasText);   // study material: the model always sees the real files
  const base = attachCtx ? [...sourceParts(ctx.doc, ctx.imageUrl), { text: sourceNote(ctx.doc, "", ctx.kind) }] : [];
  const files = attach.length
    ? [{ text: "The student attached these files to his LAST message (read them and use them in your answer):" }, ...sourceParts({ kind: "bundle", items: attach }, null)]
    : [];
  const media = [...base, ...files];

  /* big files are uploaded once and remembered (lib/gfiles.js); any problem → they go inline, exactly as before */
  const cache = createFileCache({ apiKey, persist: true });
  const think = thinkFor(lastText);
  const one = async (sys, usr, task, spec, maxOut, cb) => {
    const call = async (useFiles) => runTask({
      apiKey, models, task, system: sys,
      parts: [...(useFiles ? await cache.swap(media, signal) : media), { text: usr }],
      spec, maxOut, firstMs: CFG.firstMs, idleMs: CFG.idleMs, signal, onText: cb,
    });
    try { return await call(true); }
    catch (e) {
      if (cache.used && !(e && e.name === "AbortError") && !(signal && signal.aborted) && looksLikeFileError(e)) { cache.disable(); return call(false); }
      throw e;
    }
  };

  /* a big request: outline → sections written at the same time (never for a short question, never when the student turned it off) */
  if (getEnginePrefs().slice && isBigAsk(lastText, { files: attach.length })) {
    const sliced = await runSliced({
      signal, onText, maxSlices: 3,
      ask: (kind, cb) => {
        if (kind === "plan") {
          return one(PLAN_SYSTEM, `${cap(turns, 3500)}\n\nReturn the JSON outline for the student's last message.`, "lesson:chatplan", { levels: ["minimal", "low"], budget: 0 }, 1200);
        }
        return one(system + sliceInstruction(kind.outline, kind.slice), user, "lesson:chatpart", think, CFG.maxOut, cb);
      },
    });
    if (sliced.sliced) return { text: sliced.text, model: sliced.model };
  }
  return one(system, user, "lesson:chat", think, CFG.maxOut, onText);
}


/* the prompt for the image model: the lesson is the context, the student's sentence is the request */
export function imagePrompt(ctx, request) {
  return `Create the image the student asks for. It is study material for an Arabic-speaking nursing student preparing for the NCLEX-RN.
Style (unless the student asks for another one): a clean, accurate, well-labelled educational illustration or diagram, flat colours, high contrast, light background, uncluttered. Any text inside the image must be short, spelled correctly, large and legible, in English (Arabic labels only if the student asks for them). Medical accuracy comes first: never invent anatomy, values or drugs.

CONTEXT — the question and lesson he is studying (use it only to make the picture relevant):
${cap(ctx.question, 1500) || "(none)"}
${cap(ctx.explanation, 1500)}

STUDENT REQUEST: ${request}`;
}
