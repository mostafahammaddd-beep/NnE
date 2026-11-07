/* ───────────── Big chat answers, written in parallel (v3.26) ─────────────
   Why "a big request" was so slow: a long answer (1,500+ words) is ONE stream written word after word; time = length ÷ speed.
   Thinking harder or a faster network does not change that. What does: several writers, each writing ONE section of the same answer
   at the same moment (on different models = different quotas, see router.js).

     1. plan   one tiny request (no thinking, ~2–4 s) → an outline of 2–4 sections
     2. write  one request per section, all at once; every writer gets the SAME instructions and context as a normal answer, plus the whole
               outline and the single section it owns, so nothing is repeated and nothing is skipped
     3. show   in order, never jumping: section k appears when sections 1…k-1 are complete (the one being written streams live)

   Small questions never come here (they are already short); anything that goes wrong in the plan falls back to the normal single answer.
   Plain logic: `ask(kind, system, user, onText)` is injected (chat.js → runTask), so this file is tested without a network. */

const BIG_AR = /(بالتفصيل|بتفصيل|تفصيل|مفصّ?ل|مفصلة|شامل|كامل(?:ة)?|من الصفر|بعمق|بالعمق|اشرح(?:لي|ها|ه)?\s+(?:كل|كله)|كل\s+(?:حاجة|شيء|ما)|لخّ?ص(?:لي)?\s+(?:كل|الملف|الكتاب|المادة|الفصل|الباب)|ملخص\s+(?:شامل|كامل)|خطة\s+(?:مراجعة|مذاكرة)|مقارنة\s+(?:شاملة|تفصيلية)|جدول\s+(?:شامل|كامل)|اكتب(?:لي)?\s+(?:مقال|تقرير|شرح))/;
const BIG_EN = /\b(detailed|in[- ]depth|comprehensive|thorough(?:ly)?|step[- ]by[- ]step|everything|full\s+(?:summary|guide|explanation|plan)|complete\s+(?:guide|summary|explanation|plan)|from\s+scratch|write\s+(?:an?\s+)?(?:essay|report|article))\b/i;

export function isBigAsk(text, { files = 0 } = {}) {
  const t = String(text || "").trim();
  if (t.length < 14) return false;
  if (BIG_AR.test(t) || BIG_EN.test(t)) return true;
  return files > 0 && /(لخّ?ص|اشرح|summari[sz]e|explain)/i.test(t) && t.length > 30;
}

/* "{...}" out of a model reply */
function parseJson(t) {
  const s = String(t || "").replace(/^```[a-z]*\n?|\n?```$/gim, "").trim();
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  return JSON.parse(a >= 0 && b > a ? s.slice(a, b + 1) : s);
}

export function cleanOutline(raw, maxSlices = 3) {
  let data;
  try { data = parseJson(raw); } catch (e) { return null; }
  const list = Array.isArray(data) ? data : Array.isArray(data && data.sections) ? data.sections : null;
  if (!list) return null;
  const secs = list.map((x) => ({
    title: String((x && (x.title || x.name)) || "").replace(/\s+/g, " ").trim().slice(0, 80),
    focus: String((x && (x.focus || x.brief || x.about)) || "").replace(/\s+/g, " ").trim().slice(0, 240),
  })).filter((x) => x.title);
  if (secs.length < 2) return null;                       // one section = nothing to parallelise: the normal single answer is better
  return secs.slice(0, Math.max(2, maxSlices));
}

export const PLAN_SYSTEM = `You plan a long, well-organised answer for a nursing student. Return ONLY one JSON object, nothing else:
{"sections":[{"title":"<short heading>","focus":"<one sentence: exactly what this section must cover>"}]}
Rules: 2 to 4 sections (3 is typical) that TOGETHER answer the student's last message completely, in a sensible teaching order, with no overlap and nothing missing. Headings are short and written in the language the student writes in. No introduction section and no "conclusion" section unless the student asked for one.`;

export function sliceInstruction(outline, k) {
  const n = outline.length;
  const map = outline.map((s, i) => `${i + 1}. ${s.title} — ${s.focus || ""}`).join("\n");
  const me = outline[k];
  return `\n\nPARALLEL WRITING — this answer is written by ${n} tutors at the same moment, each owning ONE section. The outline of the whole answer:\n${map}\n\nYou write ONLY section ${k + 1} of ${n}: «${me.title}»${me.focus ? ` (${me.focus})` : ""}.\n- Start directly with the heading line "## ${me.title}".\n- Cover this section completely and with full depth: the same depth, accuracy, style and language rules as a normal answer. Do NOT shorten it because other tutors exist.\n- Do not write an introduction, a conclusion, a greeting or any other section; do not repeat what the other sections cover.`;
}

/* the screen shows the sections in order and never jumps: a section is shown once everything before it is complete */
export function compose(texts, done, final) {
  const out = [];
  for (let i = 0; i < texts.length; i++) {
    if (texts[i]) out.push(texts[i].trim());
    if (!final && !done[i]) break;
  }
  return out.join("\n\n");
}

/* ask(kind, system?, user?, onText?) → Promise<{ text }>   kind: "plan" | { slice: k }
   Resolves { text, sliced:true } or { sliced:false } when the normal single answer should be used instead. */
export async function runSliced({ ask, outlineFrom, maxSlices = 3, onText, signal }) {
  let outline = null;
  try { outline = cleanOutline((await ask("plan")).text, maxSlices); }
  catch (e) { if (e && e.name === "AbortError") throw e; outline = null; }
  if (!outline) return { sliced: false };
  if (outlineFrom) outlineFrom(outline);

  const n = outline.length;
  const texts = Array(n).fill(""), done = Array(n).fill(false), errs = Array(n).fill(null);
  let model = "";
  const emit = (final) => onText && onText(compose(texts, done, final), model);

  await Promise.all(outline.map((_, k) => ask({ slice: k, outline }, (t, m) => { texts[k] = t; model = m || model; emit(false); })
    .then((r) => { texts[k] = r.text; model = r.model || model; done[k] = true; emit(false); })
    .catch((e) => { if (e && e.name === "AbortError") throw e; errs[k] = e; done[k] = true; emit(false); })));
  if (signal && signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });

  const failed = errs.findIndex(Boolean);
  const text = compose(texts, done, true);
  if (failed >= 0) {
    /* a section that could not be written: keep every other section and say which one is missing */
    const e = errs[failed];
    const err = new Error(`قسم «${outline[failed].title}» ما اتكتبش: ${e.message || "حصلت مشكلة"}. دوس إعادة المحاولة.`);
    err.detail = e.detail; err.partial = text;
    if (onText) onText(text, model);                      // what was written stays on screen next to the error
    throw err;
  }
  return { sliced: true, text, model, sections: n };
}
