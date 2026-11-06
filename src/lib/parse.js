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

/* New words: while streaming only COMPLETE lines are shown (no flickering half-words). */
import { BASIC } from "./basicwords.js";

const forms = (w) => [w, w.replace(/'s$/, ""), w.replace(/(e)?s$/, ""), w.replace(/ies$/, "y"), w.replace(/ed$/, ""), w.replace(/d$/, ""), w.replace(/ied$/, "y"),
  w.replace(/ing$/, ""), w.replace(/ing$/, "e"), w.replace(/(.)\1(ed|ing)$/, "$1"), w.replace(/ly$/, ""), w.replace(/er$/, "")];
const isBasicWord = (w) => forms(w).some((f) => f && BASIC.has(f));

/* beginner (A1/A2) entry? abbreviations (NPO, IV, I&O), numbers and anything medical are never dropped */
export function isEasy(term) {
  const t = String(term || "").trim();
  if (!t || !/[a-z]/.test(t)) return false;
  const toks = t.toLowerCase().replace(/[^a-z' -]/g, " ").split(/[\s-]+/).filter(Boolean);
  if (!toks.length) return false;
  if (toks.length === 1 && toks[0].length <= 2) return true;
  return toks.every(isBasicWord);
}

export function cleanWords(raw, final) {
  let lines = stripFences(raw || "").replace(/\r/g, "").split("\n");
  if (!final) lines = lines.slice(0, -1);
  lines = lines.map((l) => l.replace(BULLET, "").replace(/\*\*/g, "").trim()).filter(Boolean);
  const withSep = lines.filter((l) => SEP.test(l) || / - /.test(l));
  if (withSep.length) lines = withSep; // drops chatty intro / outro lines
  const seen = new Set();
  lines = lines.filter((l) => {
    const k = parseWord(l).term.toLowerCase();
    if (!k || seen.has(k) || isEasy(parseWord(l).term)) return false;
    seen.add(k);
    return true;
  });
  return fixText(lines.join("\n"));
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
