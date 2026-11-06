/* ───────────── Pronunciation (American English, male voice) ─────────────
   Why not the phone's built-in TTS alone?  On Android WebView it is often missing, and when it exists the voice
   and accent are whatever the phone ships with (frequently a female or non-US voice).

   Order of attempts:
     1. Gemini TTS, locked to en-US and a male prebuilt voice → the same clear American voice on every phone.
        Each word is downloaded ONCE, then kept in memory + IndexedDB (works offline and costs no extra requests).
     2. Phone TTS (speechSynthesis) with a US-English male voice picked on purpose, if Gemini is unavailable
        (no key, no internet, quota).

   Speed (v2.3): in-flight requests are shared (a tap on a word that is already being prefetched just waits for it),
   the next words in a list are fetched in the background while you listen, and playback speed is adjustable
   (pitch is preserved, so slow speech does not turn into a deep voice).                                        */

import { useSyncExternalStore } from "react";
import { API_BASE, rawRequest } from "./gemini.js";
import { store, prefs } from "./storage.js";

/* newest first; an unknown / retired model just falls through to the next one */
const MODELS = ["gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts"];
const VOICE = "Charon"; // Gemini prebuilt MALE voice. Other male options: "Orus", "Iapetus", "Puck", "Fenrir".
const CACHE = `tts:v1:${VOICE}:`;
const SAMPLE_RATE = 24000; // Gemini TTS returns raw PCM, 16-bit, mono, 24 kHz

let _key = "";
export const setSpeechKey = (k) => { _key = k || ""; };

/* ── what to say: English only (the Arabic gloss must never be read by the American voice) ── */
export function speakable(s) {
  return String(s || "")
    .replace(/\*\*/g, "")
    .replace(/[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]+/g, " ")
    .replace(/\(\s*[,;/\-–—]?\s*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* ── tiny external store so every speaker button knows if ITS word is loading / playing ── */
let current = { id: null, state: "idle" };
const subs = new Set();
const setState = (id, state) => { current = { id, state }; subs.forEach((f) => f()); };
const subscribe = (f) => { subs.add(f); return () => subs.delete(f); };
const snapshot = () => current;

export function useSpeechState(id) {
  const c = useSyncExternalStore(subscribe, snapshot, snapshot);
  return c.id === id ? c.state : "idle";
}

/* ── playback speed (shared by every speaker button, remembered between launches) ── */
export const SPEEDS = [0.5, 0.75, 1, 1.25];
let speed = (() => { const v = parseFloat(prefs.get("nclex:speed", "1")); return SPEEDS.includes(v) ? v : 1; })();
const speedSubs = new Set();
export const useSpeed = () =>
  useSyncExternalStore((f) => { speedSubs.add(f); return () => speedSubs.delete(f); }, () => speed, () => speed);

/* ── audio plumbing ── */
let ctx = null;
let src = null;      // AudioBufferSource (fallback player)
let el = null;       // <audio> element (main player: keeps the pitch when the speed changes)
let elUrl = null;
let token = 0;
let goodModel = null;
const mem = new Map();
const inflight = new Map();

export function cycleSpeed() {
  speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
  prefs.set("nclex:speed", String(speed));
  try { if (el) { el.defaultPlaybackRate = speed; el.playbackRate = speed; } } catch (e) { /* ignore */ }
  try { if (src) src.playbackRate.value = speed; } catch (e) { /* ignore */ }
  speedSubs.forEach((f) => f());
}

function getCtx() {
  const AC = typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext);
  if (!AC) return null;
  if (!ctx) { try { ctx = new AC(); } catch (e) { return null; } }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

/* the element is created inside the tap, so the browser lets it play later without asking again */
function getEl() {
  if (!el && typeof Audio === "function") { try { el = new Audio(); el.preload = "auto"; } catch (e) { el = null; } }
  return el;
}

function pcmToBuffer(c, b64) {
  const bin = atob(b64);
  const n = bin.length >> 1;
  const buf = c.createBuffer(1, n, SAMPLE_RATE);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < n; i++) {
    let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    if (v >= 32768) v -= 65536;
    ch[i] = v / 32768;
  }
  return buf;
}

/* raw PCM → a tiny WAV file the <audio> element can play */
function pcmToWavUrl(b64) {
  const bin = atob(b64);
  const n = bin.length;
  const u8 = new Uint8Array(44 + n);
  const dv = new DataView(u8.buffer);
  const tag = (o, t) => { for (let i = 0; i < t.length; i++) u8[o + i] = t.charCodeAt(i); };
  tag(0, "RIFF"); dv.setUint32(4, 36 + n, true); tag(8, "WAVE"); tag(12, "fmt ");
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, SAMPLE_RATE, true); dv.setUint32(28, SAMPLE_RATE * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); tag(36, "data"); dv.setUint32(40, n, true);
  for (let i = 0; i < n; i++) u8[44 + i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([u8], { type: "audio/wav" }));
}

function freeEl() {
  if (el) { el.onended = null; el.onerror = null; try { el.pause(); } catch (e) { /* ignore */ } }
  if (elUrl) { try { URL.revokeObjectURL(elUrl); } catch (e) { /* ignore */ } elUrl = null; }
}

export function stopSpeaking() {
  token += 1;
  freeEl();
  try { if (src) { src.onended = null; src.stop(); } } catch (e) { /* already stopped */ }
  src = null;
  try { if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
  setState(null, "idle");
}

/* ── 1 · Gemini TTS ── */
async function fetchPcm(text) {
  if (!_key) throw Object.assign(new Error("no key"), { code: "nokey" });
  const order = goodModel ? [goodModel, ...MODELS.filter((m) => m !== goodModel)] : MODELS;
  const body = {
    contents: [{ parts: [{ text: `Say clearly in a General American accent: ${text}` }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { languageCode: "en-US", voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
    },
  };
  let last = new Error("tts failed");
  for (const model of order) {
    try {
      const { status, json } = await rawRequest("POST", `${API_BASE}/${model}:generateContent?key=${encodeURIComponent(_key)}`, body, Math.min(90000, 15000 + text.length * 70));   // a selected sentence needs longer than one word
      if (status >= 200 && status < 300) {
        const part = (json?.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData && p.inlineData.data);
        if (part) { goodModel = model; return part.inlineData.data; }
        last = new Error("empty audio");
        continue;
      }
      last = Object.assign(new Error(`HTTP ${status}`), { status });
      if (status === 401 || status === 403 || status === 429) break; // another model will not help
    } catch (e) { last = e; break; } // network problem
  }
  throw last;
}

/* memory → IndexedDB → network. One shared promise per word, so a tap on a word that is
   already being prefetched just waits for that same request instead of starting a second one. */
function audioFor(text) {
  if (mem.has(text)) return Promise.resolve(mem.get(text));
  if (inflight.has(text)) return inflight.get(text);
  const p = (async () => {
    let b64 = await store.get(CACHE + text);
    if (!b64) {
      b64 = await fetchPcm(text);
      store.set(CACHE + text, b64).catch?.(() => {});
    }
    mem.set(text, b64);
    return b64;
  })().finally(() => inflight.delete(text));
  inflight.set(text, p);
  return p;
}

/* Read-ahead: while you listen to one word the next few are fetched quietly (max 3 at a time, silent on errors,
   and it backs off for a minute when Gemini says "too many requests"). */
let coolUntil = 0;
export function prefetch(list) {
  if (!_key || Date.now() < coolUntil) return;
  (list || []).slice(0, 3).forEach((raw) => {
    const t = speakable(raw);
    if (!t || mem.has(t) || inflight.has(t)) return;
    audioFor(t).catch((e) => { if (e && [401, 403, 429].includes(e.status)) coolUntil = Date.now() + 60000; });
  });
}

/* ── 2 · phone voice (fallback) ── */
const MALE_NAME = /\b(david|mark|guy|alex|fred|aaron|ryan|christopher|eric|roger|brian|andrew|matthew|steffan|tom|daniel|james)\b|x-(iom|iol|tpd)\b|\bmale\b/i;

function pickVoice() {
  try {
    const all = window.speechSynthesis.getVoices() || [];
    const us = all.filter((v) => /^en[-_]US$/i.test(v.lang));
    const label = (v) => `${v.name} ${v.voiceURI}`;
    return us.find((v) => MALE_NAME.test(label(v)) && !/female/i.test(label(v))) || us[0] || null;
  } catch (e) { return null; }
}

function systemSpeak(text, my, id) {
  if (typeof window === "undefined" || !("speechSynthesis" in window) || typeof window.SpeechSynthesisUtterance !== "function") return false;
  try {
    const u = new window.SpeechSynthesisUtterance(text);
    u.lang = "en-US";
    const v = pickVoice();
    if (v) u.voice = v;
    u.rate = 0.9 * speed;
    u.pitch = 0.85;
    u.onend = u.onerror = () => { if (token === my) setState(null, "idle"); };
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
    setState(id, "play");
    return true;
  } catch (e) { return false; }
}

const fail = (msg) => {
  try { window.dispatchEvent(new CustomEvent("nclex:speech-error", { detail: msg })); } catch (e) { /* ignore */ }
};

/* play with the Web-Audio fallback (speed works, pitch follows the speed) */
function playBuffer(c, b64, my, id) {
  if (!c) throw new Error("no audio context");
  const s = c.createBufferSource();
  s.buffer = pcmToBuffer(c, b64);
  s.playbackRate.value = speed;
  s.connect(c.destination);
  s.onended = () => { if (token === my) { src = null; setState(null, "idle"); } };
  src = s;
  s.start();
  setState(id, "play");
}

async function playAudio(a, c, b64, my, id) {
  if (!a) return playBuffer(c, b64, my, id);
  freeEl();
  elUrl = pcmToWavUrl(b64);
  a.src = elUrl;
  a.defaultPlaybackRate = speed;
  a.playbackRate = speed;
  for (const k of ["preservesPitch", "webkitPreservesPitch", "mozPreservesPitch"]) { try { a[k] = true; } catch (e) { /* ignore */ } }
  a.onended = () => { if (token === my) { freeEl(); setState(null, "idle"); } };
  a.onerror = () => { if (token === my) { freeEl(); try { playBuffer(c, b64, my, id); } catch (e) { setState(null, "idle"); } } };
  try {
    await a.play();
    if (token === my) setState(id, "play");
  } catch (e) {
    if (token !== my) return;
    freeEl();
    playBuffer(c, b64, my, id); // autoplay blocked or format problem → fallback player
  }
}

/* ── public: tap once = play, tap again while it plays = stop ── */
export async function speak(raw, id = raw) {
  const text = speakable(raw);
  if (!text) return;
  if (current.id === id && current.state !== "idle") { stopSpeaking(); return; }
  stopSpeaking();
  const my = ++token;
  const c = getCtx(); // must be created/resumed inside the tap, before any await
  const a = getEl();
  setState(id, "load");
  try {
    const b64 = await audioFor(text);
    if (my !== token) return;
    await playAudio(a, c, b64, my, id);
  } catch (e) {
    if (my !== token) return;
    if (systemSpeak(text, my, id)) return;
    setState(null, "idle");
    fail(e && e.code === "nokey"
      ? "ضيف مفتاح Gemini (أيقونة 🔑) عشان النطق الأمريكي يشتغل."
      : "مقدرتش أجيب النطق دلوقتي. اتأكد من النت وجرّب تاني.");
  }
}
