import { fixText } from "./text.js";
/* ───────────── Text helpers & stream splitters ───────────── */

export const hasArabic = (s) => /[؀-ۿ]/.test(s || "");

const BULLET = /^\s*(?:[-•*·]+|\d{1,2}[.)])\s+/;

/* New-words text → clean lines (one entry per line) */
export const wordLines = (text) =>
  fixText(text || "").split("\n").map((l) => l.replace(BULLET, "").trim()).filter(Boolean);

const SEP = /\s[—–]\s|\s\|\s/;

export function parseWord(line) {
  let parts = line.split(SEP);
  if (parts.length === 1 && / - /.test(line)) parts = [line.slice(0, line.indexOf(" - ")), line.slice(line.indexOf(" - ") + 3)];
  const [term, meaning, ...note] = parts;
  return { term: (term || "").trim(), meaning: (meaning || "").trim(), note: note.join(" — ").trim() };
}

const stripFences = (t) => t.replace(/^\s*```[a-z]*\s*$/gim, "");

/* OCR text: show everything as it streams (even the unfinished last line) */
export function cleanOcr(raw) {
  return fixText(stripFences(raw || "")).replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

/* New words: while streaming only COMPLETE lines are shown (no flickering half-words).

   Two independent checks decide whether an entry is a real "new word" (B2 or higher / medical):
   1. the level the AI had to WRITE next to every entry:   "[C1] adverse — ضارّ"   (A1 A2 B1 B2 C1 C2, MED = medical / nursing term, ABBR = abbreviation)
      → an entry the AI itself labels A1 / A2 / B1 is dropped here.
   2. a local dictionary of everyday English (BASIC = A1/A2 + COMMON = A1–B1): an entry made only of those words is dropped
      whatever level the AI claimed — the AI can no longer talk its way past the filter.
   Medical terms and abbreviations are never dropped (a single common word tagged MED, like "pain", still is: it is not a new term). */
import { BASIC } from "./basicwords.js";
import { COMMON } from "./commonwords.js";

const KNOWN = (w) => BASIC.has(w) || COMMON.has(w);
/* base forms of an inflected word: plural, -ed, -ing, -ly, -er/-est (a stem must still be a real word of 3+ letters) */
const stems = (w) => {
  const o = [w.replace(/'s$/, ""), w.replace(/ies$/, "y"), w.replace(/(sh|ch|x|ss|zz|o)es$/, "$1"), w.replace(/s$/, ""),
    w.replace(/ied$/, "y"), w.replace(/ed$/, ""), w.replace(/d$/, ""), w.replace(/(.)\1ed$/, "$1"),
    w.replace(/ing$/, ""), w.replace(/ing$/, "e"), w.replace(/(.)\1ing$/, "$1"), w.replace(/ily$/, "y"), w.replace(/ly$/, ""),
    w.replace(/ier$/, "y"), w.replace(/er$/, ""), w.replace(/r$/, ""), w.replace(/iest$/, "y"), w.replace(/est$/, ""), w.replace(/(.)\1(er|est)$/, "$1")];
  return o;
};
const isBasicWord = (w) => KNOWN(w) || stems(w).some((f) => f.length >= 3 && f !== w && KNOWN(f));

/* every token of the term is everyday English? (abbreviations such as NPO / IV / I&O are never "everyday") */
export function isEasy(term) {
  const raw = String(term || "").trim();
  if (!raw || !/[a-z]/i.test(raw)) return false;
  if (/^[A-Z0-9&/.\-]{2,}$/.test(raw)) return false;               // NPO, IV, BID, I&O, mmHg is caught below (mixed case)
  const toks = raw.toLowerCase().replace(/[^a-z' -]/g, " ").split(/[\s-]+/).filter(Boolean);
  if (!toks.length) return false;
  if (toks.length === 1 && toks[0].length <= 2) return !/[a-z][A-Z]|[A-Z]{2}/.test(raw);
  return toks.every(isBasicWord);
}

const TAG_RE = /^\s*[[(]\s*(A1|A2|B1|B2|C1|C2|MED|ABBR)\s*[\])]\s*[:\-–—]?\s*/i;
const LOW = new Set(["A1", "A2", "B1"]);

/* one entry: should it stay in the list? */
export function keepEntry(tag, term) {
  const tg = String(tag || "").toUpperCase();
  if (LOW.has(tg)) return false;                                     // the AI itself says it is easy
  if (tg === "ABBR") return true;
  if (tg === "MED") {                                                // a medical phrase stays; one plain everyday word does not
    const toks = String(term || "").toLowerCase().replace(/[^a-z' -]/g, " ").split(/[\s-]+/).filter(Boolean);
    return !(toks.length === 1 && isBasicWord(toks[0]));
  }
  if (!isEasy(term)) return true;
  /* a phrase of known words (rule out, requires further teaching) is the hardest kind of English for a learner: when the AI
     labels it B2+, it stays */
  const toks = String(term || "").toLowerCase().replace(/[^a-z' -]/g, " ").split(/[\s-]+/).filter(Boolean);
  return ["B2", "C1", "C2"].includes(tg) && toks.length >= 2 && toks.length <= 5;
}

/* split off the level tag:  "[C1] adverse — …"  →  { tag: "C1", line: "adverse — …" } */
export function takeTag(line) {
  const m = TAG_RE.exec(line);
  return m ? { tag: m[1].toUpperCase(), line: line.slice(m[0].length).trim() } : { tag: "", line };
}

export function cleanWords(raw, final) {
  let lines = stripFences(raw || "").replace(/\r/g, "").split("\n");
  if (!final) lines = lines.slice(0, -1);
  lines = lines.map((l) => l.replace(BULLET, "").replace(/\*\*/g, "").trim()).filter(Boolean);
  const withSep = lines.filter((l) => SEP.test(l) || / - /.test(l));
  if (withSep.length) lines = withSep; // drops chatty intro / outro lines
  const seen = new Set();
  const out = [];
  for (const l of lines) {
    const { tag, line } = takeTag(l);
    const term = parseWord(line).term;
    const k = term.toLowerCase();
    if (!k || seen.has(k) || !keepEntry(tag, term)) continue;
    seen.add(k);
    out.push(line);
  }
  return fixText(out.join("\n"));
}

/* SOLVE brief → text handed to the lesson writer. Without an ANSWER line it is not trustworthy, so it is dropped
   (the writer then solves the question itself instead of treating garbage as ground truth). */
export function cleanBrief(raw) {
  const t = stripFences(raw || "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  if (!/^\s*ANSWER\s*:/im.test(t)) return "";
  return t.slice(0, 3500);
}

/* Reasoning text:  ===EXPLANATION=== … ===TRICKS=== …
   Works on any prefix of the stream (partial markers are hidden). */
const EXP_RE = /^[ \t]*={2,}[ \t]*EXPLANATION[ \t]*={2,}[ \t]*$/im;
const TRI_RE = /^[ \t]*={2,}[ \t]*TRICKS[ \t]*={2,}[ \t]*$/im;

function hidePartialMarker(text) {
  const nl = text.lastIndexOf("\n");
  const last = text.slice(nl + 1).trim();
  if (last && /^=+[ \t]*[A-Z]*[ \t]*=*$/.test(last) && ("===TRICKS===".startsWith(last) || "===EXPLANATION===".startsWith(last) || /^=+$/.test(last))) {
    return text.slice(0, nl + 1);
  }
  return text;
}

export function splitReason(raw, final) {
  let t = stripFences(raw || "").replace(/\r/g, "");
  const tri = TRI_RE.exec(t);
  let explanation, tricks;
  if (tri) {
    explanation = t.slice(0, tri.index);
    tricks = t.slice(tri.index + tri[0].length);
  } else {
    explanation = final ? t : hidePartialMarker(t);
    tricks = null;
  }
  const exp = EXP_RE.exec(explanation);
  if (exp) explanation = explanation.slice(exp.index + exp[0].length);
  explanation = explanation.trim();
  if (tricks !== null) tricks = (final ? tricks : hidePartialMarker(tricks)).trim();
  else if (final) tricks = "";
  return { explanation: fixText(explanation), tricks: fixText(tricks) };
}

/* day helpers for streak / daily goal */
export const dayKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

export function studyStats(questions, goal) {
  const days = new Set();
  let today = 0;
  const tk = dayKey(Date.now());
  questions.forEach((q) => {
    days.add(dayKey(q.createdAt || q.updatedAt || 0));
    if (q.updatedAt) days.add(dayKey(q.updatedAt));
    if (dayKey(q.createdAt || q.updatedAt || 0) === tk) today += 1;
  });
  let streak = 0;
  const d = new Date();
  if (!days.has(dayKey(d.getTime()))) d.setDate(d.getDate() - 1); // streak stays alive until midnight
  while (days.has(dayKey(d.getTime()))) { streak += 1; d.setDate(d.getDate() - 1); }
  return { today, streak, goal };
}
