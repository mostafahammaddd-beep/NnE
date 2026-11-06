/* ───────────── Gemini networking ─────────────
   Goals: first text on screen in ~1–2 s, never block on housekeeping calls, never wait for a slow
   model when another one can answer.

   • STREAMING (SSE) through the WebView fetch → text is shown while it is still being written.
   • NO blocking "list models" round trip before analysing (cached list + safe defaults; refreshed in background).
   • HEDGED fallback: if a model has not produced its first token after `hedgeMs`, the next model is started
     in parallel and the first one to answer wins (an overloaded model can no longer stall the whole task).
   • Thinking level is remembered per model (no repeated 400 round trips).
   • "Sign of life" = any streamed part, INCLUDING Gemini's thought summaries (includeThoughts). A model that is
     busy thinking is therefore never mistaken for a stalled one (no wasted duplicate requests), and a model that
     dies while thinking is replaced by the next one before the user has seen anything.
   • systemInstruction carries the static prompt → Gemini's implicit cache can reuse it between runs.
   • Models that are unavailable for the key (404 / quota 0) are remembered for 6 h, even across app restarts.
   • v3.13 — RETIRED models: Google keeps listing gemini-2.5-* in ListModels but answers 404 "no longer available to
     new users" for keys that never used them. Such a model is now (1) dropped from the candidate lists, (2) remembered
     as retired for 7 days, (3) replaced at once by the model Google names in the error message, and (4) triggers a
     background refresh of the model list. When EVERY model fails, the error shown is the most informative one
     (rate limit / server / timeout beat "model unavailable"), plus a one-line list of what each model answered.
   • If WebView fetch cannot reach Google (CORS / network), it falls back to the native Capacitor HTTP client
     (non-streaming) automatically.                                                                       */

import { Capacitor, CapacitorHttp } from "@capacitor/core";

const ENV = (typeof import.meta !== "undefined" && import.meta.env) || {};
import { trackRequest, noteQuota } from "./usage.js";
export const ENV_KEY = ENV.VITE_GEMINI_API_KEY || "";
export const API_BASE = ENV.VITE_API_BASE || "https://generativelanguage.googleapis.com/v1beta/models";

/* ── errors ── */

const RETIRED_RE = /no longer available|not available to new users|has been (?:shut ?down|retired|deprecated)|is deprecated/;

export function friendlyError(status, message) {
  const m = (message || "").toLowerCase();
  if (/api key|api_key/.test(m) || status === 401 || status === 403)
    return "مفتاح الـ API مش مقبول أو مالوش صلاحية. اتأكد من المفتاح من أيقونة 🔑 فوق.";
  if (status === 429 && /per\s?day|daily|perday/.test(m)) return "خلصت حصة الطلبات اليومية بتاعة مفتاحك. بتتجدد منتصف الليل بتوقيت المحيط الهادي، أو استخدم مفتاح تاني.";
  if (status === 429) return "وصلت للحد المسموح من الطلبات. استنى دقيقة وجرّب تاني.";
  if (status === 404 && RETIRED_RE.test(m)) return "الموديل ده اتقفل على المفاتيح الجديدة. التطبيق بيحوّل لموديل أحدث لوحده، جرّب تاني.";
  if (status === 400 && /pdf|document/.test(m)) return "ملف الـ PDF مش مقروء أو مش مدعوم. جرّب ملف تاني أو صوّر الصفحة.";
  if (status === 400 && m.includes("image")) return "الصورة مش واضحة أو مش مدعومة. جرّب صورة تانية.";
  if (status >= 500) return "سيرفرات Google مشغولة دلوقتي. جرّب تاني بعد شوية.";
  return "حصلت مشكلة أثناء التحليل.";
}

function apiError(status, bodyText) {
  let message = "", retryMs = 0;
  try {
    const j = JSON.parse(bodyText);
    message = j?.error?.message || "";
    const ri = (j?.error?.details || []).find((d) => d && d.retryDelay);
    if (ri) retryMs = Math.round(parseFloat(String(ri.retryDelay)) * 1000) || 0;
  } catch (e) { message = String(bodyText || "").slice(0, 200); }
  const err = classify(status, message);
  if (!err.retryAfterMs && retryMs) err.retryAfterMs = Math.min(retryMs, 60000);
  return err;
}

function classify(status, message) {
  const m = (message || "").toLowerCase();
  const err = new Error(friendlyError(status, message));
  err.status = status;
  err.detail = `HTTP ${status} · ${message || ""}`.slice(0, 400);
  err.thinking = status === 400 && /thinking|thought/.test(m);
  err.fatal = !err.thinking && (
    status === 401 ||
    /api key not valid|api_key_invalid|api key expired|invalid api key|api key not found|api key is missing/.test(m) ||
    (status === 403 && /api key|api_key|referer|ip address|has not been used|is disabled/.test(m))
  );
  if (status === 429) noteQuota(message);
  err.daily = status === 429 && /per\s?day|daily|perday/.test(m);
  const ra = m.match(/retry in ([\d.]+)\s*s/);
  if (ra) err.retryAfterMs = Math.min(Math.round(parseFloat(ra[1]) * 1000), 60000);
  /* a model whose DAILY quota is gone (or whose free quota is 0) cannot answer for hours; the other models have their own quota */
  err.dead = status === 404 || (status === 429 && (/limit:\s*0/.test(m) || err.daily)) || (status === 403 && !err.fatal);
  /* "This model models/gemini-2.5-pro is no longer available to new users. Please update your code to use models/gemini-3.1-pro-preview …" */
  err.retired = status === 404 && RETIRED_RE.test(m);
  const rep = err.retired && String(message || "").match(/(?:use|using|switch to|migrate to)\s+(?:the\s+)?(?:models\/)?(gemini-[a-z0-9.\-]+)/i);
  if (rep) err.replacement = rep[1].toLowerCase().replace(/[.,;:\-]+$/, "");
  return err;
}

const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });
const timeoutError = (what) =>
  Object.assign(new Error("الطلب أخد وقت أطول من اللازم واتقطع. جرّب تاني أو اختار وضع أسرع."), { detail: `timeout (${what})`, timeout: true });

/* ── plain (non-stream) requests: model list, connection test ── */

function normalizeResponse(status, data) {
  let json = data;
  if (typeof data === "string") { try { json = JSON.parse(data); } catch (e) { json = {}; } }
  return { status, json: json && typeof json === "object" ? json : {} };
}

export async function rawRequest(method, url, body, timeoutMs) {
  const errors = [];
  if (Capacitor.isNativePlatform()) {
    try {
      const opts = { url, method, headers: { "Content-Type": "application/json" }, connectTimeout: 30000, readTimeout: timeoutMs };
      if (body !== undefined) opts.data = body;
      const r = await CapacitorHttp.request(opts);
      return normalizeResponse(r.status, r.data);
    } catch (e) { errors.push("native: " + String((e && e.message) || e)); }
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const init = { method, headers: { "Content-Type": "application/json" }, signal: ctrl.signal };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(url, init);
    const text = await res.text();
    clearTimeout(timer);
    return normalizeResponse(res.status, text);
  } catch (e) {
    errors.push("webview: " + (e && e.name === "AbortError" ? "timeout" : String((e && e.message) || e)));
  }
  throw Object.assign(new Error("مفيش اتصال بسيرفرات Google. اتأكد من النت وجرّب تاني."), { detail: errors.join(" | ") });
}

/* ── model lists (cached, never blocking) ── */

/* Only "-latest" aliases + the current generation: Google moves the aliases forward by itself, so these keep working
   when a specific model is retired. gemini-2.5-* is NOT here on purpose (404 for every key that never used it). */
const DEFAULT_LISTS = {
  fast: ["gemini-flash-latest", "gemini-flash-lite-latest"],
  pro: ["gemini-pro-latest", "gemini-3.1-pro-preview"],
};
const LS_MODELS = "nclex:models:v5";
const keyTag = (k) => (k || "").slice(-8);
let _lists = null;

/* models that are unavailable for this key (404 / quota 0): remembered across restarts for a few hours,
   so the first analysis of a new session does not waste a round trip on a model that cannot answer.
   RETIRED models ("no longer available to new users") are remembered for a week and survive list refreshes. */
const LS_DEAD = "nclex:dead:v2";
const DEAD_TTL = 6 * 3600e3;
const RETIRED_TTL = 7 * 864e5;
let _deadMem = null;
function deadState(apiKey) {
  const k = keyTag(apiKey);
  if (_deadMem && _deadMem.k === k) return _deadMem;
  let st = { k, map: {}, ret: {} };
  try { const raw = JSON.parse(window.localStorage.getItem(LS_DEAD)); if (raw && raw.k === k) st = { k, map: raw.map || {}, ret: raw.ret || {} }; } catch (e) { /* ignore */ }
  _deadMem = st;
  return st;
}
const saveDead = (st) => { try { window.localStorage.setItem(LS_DEAD, JSON.stringify(st)); } catch (e) { /* ignore */ } };
const deadSet = (apiKey) => {
  const st = deadState(apiKey), now = Date.now();
  return new Set([...Object.keys(st.map).filter((m) => st.map[m] > now), ...Object.keys(st.ret).filter((m) => st.ret[m] > now)]);
};
const addDead = (apiKey, model, retired) => {
  const st = deadState(apiKey);
  if (retired) st.ret[model] = Date.now() + RETIRED_TTL; else st.map[model] = Date.now() + DEAD_TTL;
  saveDead(st);
};
const clearDead = (apiKey) => {            // a fresh model list gives temporary failures a new chance; retired models stay retired
  const st = deadState(apiKey);
  st.map = {};
  saveDead(st);
};

/* the replacement Google names inside a "no longer available" error is trusted for the next analysis too */
const LS_SUGGEST = "nclex:suggest:v1";
const readSuggest = (apiKey) => {
  try { const r = JSON.parse(window.localStorage.getItem(LS_SUGGEST)); if (r && r.k === keyTag(apiKey) && Date.now() - r.t < 30 * 864e5) return r.models || []; } catch (e) { /* ignore */ }
  return [];
};
const addSuggest = (apiKey, model) => {
  if (!/^gemini-[a-z0-9.\-]+$/.test(model || "")) return;
  const cur = readSuggest(apiKey);
  if (cur.includes(model)) return;
  try { window.localStorage.setItem(LS_SUGGEST, JSON.stringify({ k: keyTag(apiKey), t: Date.now(), models: [model, ...cur].slice(0, 4) })); } catch (e) { /* ignore */ }
  _lists = null;                              // lists are rebuilt with the suggestion on the next read
};

/* a retired model → refresh the model list from Google in the background (at most once every 10 minutes) */
let _selfHealAt = 0;
function selfHeal(apiKey) {
  if (!apiKey || Date.now() - _selfHealAt < 10 * 60e3) return;
  _selfHealAt = Date.now();
  refreshModels(apiKey, { force: true }).catch(() => {});
}

const modelRank = (n) => {
  const tier = /pro/.test(n) ? 2 : /lite/.test(n) ? 0 : 1;
  const v = (n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1];
  const base = /latest$/.test(n) ? 500 : (v ? parseFloat(v) * 10 : 0);
  return tier * 1000 + base - (/preview|exp/.test(n) ? 1 : 0);
};

const withSuggestions = (apiKey, lists) => {
  const dead = deadSet(apiKey);
  const extra = readSuggest(apiKey).filter((m) => !dead.has(m));
  const ok = (arr) => arr.filter((m) => !deadState(apiKey).ret[m] || deadState(apiKey).ret[m] <= Date.now());
  const pro = [...extra.filter((m) => /pro/.test(m)), ...lists.pro];
  const fast = [...extra.filter((m) => !/pro/.test(m)), ...lists.fast];
  return { fast: [...new Set(ok(fast))], pro: [...new Set(ok(pro))] };
};

export function getModelLists(apiKey) {
  if (_lists && _lists.k === keyTag(apiKey) && _lists.out) return _lists.out;
  let base = DEFAULT_LISTS;
  try {
    const raw = JSON.parse(window.localStorage.getItem(LS_MODELS));
    if (raw && raw.k === keyTag(apiKey) && Date.now() - raw.t < 3 * 864e5) base = raw.lists;
  } catch (e) { /* ignore */ }
  const out = withSuggestions(apiKey, base);
  _lists = { k: keyTag(apiKey), lists: base, out };
  return out;
}

/* generation number of a model id: gemini-3.1-pro-preview → 3.1 ; "-latest" aliases have none → treated as newest */
const genOf = (n) => { const v = (n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1]; return v ? parseFloat(v) : 99; };

export async function refreshModels(apiKey, { force = false } = {}) {
  if (!apiKey) return DEFAULT_LISTS;
  if (!force) {
    try {
      const raw = JSON.parse(window.localStorage.getItem(LS_MODELS));
      if (raw && raw.k === keyTag(apiKey) && Date.now() - raw.t < 864e5) { _lists = null; return getModelLists(apiKey); }
    } catch (e) { /* ignore */ }
  }
  const { status, json } = await rawRequest("GET", `${API_BASE}?pageSize=200&key=${encodeURIComponent(apiKey)}`, undefined, 30000);
  if (status !== 200) throw classify(status, json?.error?.message || "");
  const all = (json.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent") && /^models\/gemini-/.test(m.name)
      && !/image|tts|audio|live|embed|robotics|computer|learnlm|gemma|aqa|vision|deep-research|customtools|transcri|speech/i.test(m.name))
    .map((m) => m.name.replace("models/", ""));
  /* ListModels still lists gemini-2.5-* although new keys get 404 on them → keep the 3.x generation (and the -latest aliases)
     whenever it exists; the old generation is used only if nothing newer is listed at all */
  const modern = all.filter((n) => genOf(n) >= 3);
  const found = (modern.length ? modern : all).sort((x, y) => modelRank(y) - modelRank(x));
  const pro = found.filter((n) => /pro/.test(n)).slice(0, 3);
  const flash = found.filter((n) => !/pro/.test(n) && !/lite/.test(n)).slice(0, 4);   // capacity is per model: more distinct models = more chances
  const lite = found.filter((n) => /lite/.test(n)).slice(0, 2);
  const fast = [...flash, ...lite];
  const lists = {
    fast: fast.length ? fast : (pro.length ? pro : DEFAULT_LISTS.fast),
    pro: pro.length ? pro : (flash.length ? flash : DEFAULT_LISTS.pro),
  };
  try { window.localStorage.setItem(LS_MODELS, JSON.stringify({ k: keyTag(apiKey), t: Date.now(), lists })); } catch (e) { /* ignore */ }
  clearDead(apiKey);
  _lists = null;
  return getModelLists(apiKey);
}

export async function testConnection(apiKey) {
  const { fast, pro } = await refreshModels(apiKey, { force: true });
  return `${pro[0]} + ${fast[0]}`;
}

/* Fire-and-forget: refreshes the model list in the background. */
export function warmUp(apiKey) {
  if (!apiKey) return;
  refreshModels(apiKey).catch(() => {});
}

/* Opens the DNS + TLS + HTTP/2 connection to Google BEFORE the user presses "analyse", so the three
   parallel requests reuse one hot connection instead of each paying the handshake (≈ 0.3–0.8 s on mobile). */
let _warmAt = 0;
export function warmConnection(apiKey) {
  if (!apiKey || Date.now() - _warmAt < 45000) return;
  _warmAt = Date.now();
  try {
    fetch(`${API_BASE}?pageSize=1&key=${encodeURIComponent(apiKey)}`, { method: "GET", cache: "no-store" })
      .then((r) => r.arrayBuffer()).catch(() => {});
  } catch (e) { /* ignore */ }
}

/* ── thinking control ──
   Gemini 3.x uses thinkingLevel, 2.x uses thinkingBudget. The first rung that works is remembered. */

const is2x = (model) => /gemini-2\./.test(model);

function ladderFor(model, spec) {
  // Gemini 2.5 Pro cannot switch thinking off (minimum 128): asking for 0 would waste a 400 round trip
  const bud = { thinkingBudget: is2x(model) && /pro/.test(model) ? Math.max(128, spec.budget) : spec.budget };
  if (is2x(model)) return [bud, null];
  return [...spec.levels.map((l) => ({ thinkingLevel: l })), bud, null];
}

const memoKey = (model, task) => `nclex:tl:${model}|${task}`;
const readMemo = (model, task) => { try { return parseInt(window.localStorage.getItem(memoKey(model, task)) || "0", 10) || 0; } catch (e) { return 0; } };
const writeMemo = (model, task, i) => { try { window.localStorage.setItem(memoKey(model, task), String(i)); } catch (e) { /* ignore */ } };

const tempFor = (task) => (/^solve/.test(task) ? 0.2 : /^lesson/.test(task) ? 0.4 : 0.1);

function genConfig(model, think, maxOut, task) {
  const g = { maxOutputTokens: maxOut };
  if (is2x(model)) g.temperature = tempFor(task); // Gemini 3: keep Google's default temperature
  if (think) {
    const t = { ...think };
    // thought summaries stream while the model thinks → proof of life (never shown to the student)
    if (t.thinkingBudget !== 0 && t.thinkingLevel !== "minimal") t.includeThoughts = true;
    g.thinkingConfig = t;
  }
  return g;
}

/* ── one streaming request (SSE over fetch) ── */

function readParts(json) {
  const cand = json?.candidates?.[0];
  const parts = cand?.content?.parts || [];
  const text = parts.filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text).join("");
  const alive = parts.some((p) => typeof p.text === "string"); // visible text OR a thought summary
  return { text, alive, finish: cand?.finishReason || null, block: json?.promptFeedback?.blockReason || null };
}

async function fetchStream({ apiKey, model, body, signal, onText, onAlive, firstMs, idleMs = 45000 }) {
  if (signal.aborted) throw abortError();
  const url = `${API_BASE}/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
  const ctrl = new AbortController();
  const link = () => ctrl.abort();
  signal.addEventListener("abort", link);
  let timer = null, why = null;
  const arm = (ms, w) => { clearTimeout(timer); timer = setTimeout(() => { why = w; ctrl.abort(); }, ms); };
  arm(firstMs, "first-byte");

  let full = "", finish = null, block = null;
  const handle = (line) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let json;
    try { json = JSON.parse(payload); } catch (e) { return; }
    if (json.error) throw classify(json.error.code || 500, json.error.message || "");
    const r = readParts(json);
    if (r.alive && onAlive) onAlive();
    if (r.finish) finish = r.finish;
    if (r.block) block = r.block;
    if (r.text) { full += r.text; onText(full); }
  };

  try {
    let res;
    try {
      res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
    } catch (e) {
      if (signal.aborted) throw abortError();
      if (why) throw timeoutError(why);
      throw Object.assign(new Error("مفيش اتصال بسيرفرات Google. اتأكد من النت وجرّب تاني."), { detail: "fetch: " + String((e && e.message) || e), netBeforeStart: true });
    }
    if (!res.ok) throw apiError(res.status, await res.text());
    arm(idleMs, "idle");

    const reader = res.body && typeof res.body.getReader === "function" ? res.body.getReader() : null;
    if (!reader) {
      (await res.text()).split("\n").forEach((l) => handle(l.replace(/\r$/, "")));
    } else {
      const dec = new TextDecoder("utf-8");
      let buf = "";
      for (;;) {
        let chunk;
        try { chunk = await reader.read(); }
        catch (e) {
          if (signal.aborted) throw abortError();
          if (why) throw timeoutError(why);
          throw Object.assign(new Error("النت قطع في نص التحميل. دوس إعادة المحاولة."), { detail: "stream: " + String((e && e.message) || e), interrupted: true });
        }
        if (chunk.done) break;
        arm(idleMs, "idle");
        buf += dec.decode(chunk.value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);
          handle(line);
        }
      }
      buf += dec.decode();
      if (buf.trim()) handle(buf.replace(/\r$/, ""));
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", link);
  }
  return { text: full, finish, block };
}

/* Native (non-streaming) fallback — used only if WebView fetch cannot reach Google. */
async function nativeOnce({ apiKey, model, body, signal, onText, onAlive }) {
  const url = `${API_BASE}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  let r;
  try {
    r = await CapacitorHttp.request({ url, method: "POST", headers: { "Content-Type": "application/json" }, data: body, connectTimeout: 30000, readTimeout: 300000 });
  } catch (e) {
    if (signal.aborted) throw abortError();
    const msg = String((e && e.message) || e);
    if (/timeout|timed out/i.test(msg)) throw timeoutError("native");
    throw Object.assign(new Error("مفيش اتصال بسيرفرات Google. اتأكد من النت وجرّب تاني."), { detail: "native: " + msg });
  }
  if (signal.aborted) throw abortError();
  const { status, json } = normalizeResponse(r.status, r.data);
  if (status !== 200) throw classify(status, json?.error?.message || "");
  const out = readParts(json);
  if (out.alive && onAlive) onAlive();
  if (out.text) onText(out.text);
  return out;
}

let _noStreamUntil = 0;
async function streamOrNative(args) {
  if (Date.now() >= _noStreamUntil) {
    try { return await fetchStream(args); }
    catch (e) {
      if (!(e && e.netBeforeStart && Capacitor.isNativePlatform())) throw e;
      const out = await nativeOnce(args);          // WebView could not reach Google but native can
      _noStreamUntil = Date.now() + 10 * 60 * 1000; // stop retrying fetch for a while
      return out;
    }
  }
  return nativeOnce(args);
}

async function attemptModel({ apiKey, model, task, system, parts, spec, maxOut, signal, onText, onAlive, firstMs, idleMs }) {
  const rungs = ladderFor(model, spec);
  let idx = Math.min(readMemo(model, task), rungs.length - 1);
  for (;;) {
    const body = { contents: [{ role: "user", parts }], generationConfig: genConfig(model, rungs[idx], maxOut, task) };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    try {
      trackRequest(model);                                       // every request counts against the daily quota
      const out = await streamOrNative({ apiKey, model, body, signal, onText, onAlive, firstMs, idleMs });
      if (!out.text.trim()) {
        throw Object.assign(new Error(out.block ? "السؤال اتحجب من فلتر الأمان بتاع Google. جرّب صورة تانية." : "الذكاء الاصطناعي رجّع رد فاضي. جرّب تاني."),
          { detail: `${model} · ${out.finish || out.block || "empty"}`, emptyReply: true, blocked: !!out.block });
      }
      writeMemo(model, task, idx);
      return out;
    } catch (e) {
      if (e.thinking && idx < rungs.length - 1) { idx += 1; continue; }
      if (e && !e.detail) e.detail = model;
      else if (e && e.detail && !e.detail.includes(model)) e.detail = `${model} · ${e.detail}`;
      throw e;
    }
  }
}

/* ── hedged race between models ──
   A model "claims" the race with its FIRST sign of life (a thought summary or visible text). From then on the
   other candidates are cancelled. If the claimer dies before anything was shown, the race re-opens and the next
   model starts at once; if text was already shown, the error is reported (we never silently switch mid-answer). */

/* When every model failed, show the error that tells the student what to DO, not just the last one that happened to fail:
   a rate limit / server / network / timeout error beats "this model is unavailable". */
function bestError(errs, tried) {
  const real = errs.filter((e) => !e.dead);
  const daily = errs.filter((e) => e.daily);
  const pick = real.length ? real[real.length - 1] : (daily.length ? daily[daily.length - 1] : null);
  const trail = tried.join(" | ").slice(0, 600);
  if (pick) { pick.detail = [pick.detail, trail && trail !== pick.detail ? "المحاولات: " + trail : ""].filter(Boolean).join(" — "); return pick; }
  const e = new Error("مفيش موديل شغّال على مفتاحك دلوقتي: كل الموديلات اللي جرّبها التطبيق اتقفلت أو مش متاحة للمفاتيح الجديدة. جرّب تدوس 🔑 ← \"اختبار الاتصال\" عشان يحدّث الموديلات، ولو فضل كده اعمل مفتاح جديد من Google AI Studio.");
  e.detail = "المحاولات: " + trail;
  e.dead = true;
  return e;
}

/* ── model health board (shared by every task of the app) ──
   A 503 / 429-per-minute / timeout is a statement about ONE model at THIS moment. The first task that hits it puts the
   model on a short, growing cool-down; every other task (they all run in parallel) skips it at once instead of each paying
   its own failed round trip, and the model is tried again automatically when the cool-down ends. */
const BOARD = new Map();
const bKey = (apiKey, model) => `${keyTag(apiKey)}|${model}`;
const bGet = (apiKey, model) => BOARD.get(bKey(apiKey, model)) || { until: 0, fails: 0, at: 0 };
function coolDown(apiKey, model, err) {
  const b = bGet(apiKey, model), now = Date.now();
  if (now - b.at > 3000) b.fails = Math.min(b.fails + 1, 6);      // 5 parallel tasks failing together count once
  b.at = now;
  const base = err && err.retryAfterMs ? err.retryAfterMs : Math.min(20000, 1500 * 2 ** (b.fails - 1));   // 1.5 → 3 → 6 → 12 → 20 s
  b.until = Math.max(b.until, now + base * (0.8 + Math.random() * 0.4));                                   // jitter: no thundering herd
  BOARD.set(bKey(apiKey, model), b);
}
const markGood = (apiKey, model) => BOARD.delete(bKey(apiKey, model));
const isLite = (m) => /lite/.test(m);

/* Which failures are worth another try? Everything that says "Google is busy / the line dropped" is; a bad key, a blocked
   question or a bad file is not (retrying cannot change the answer). */
const isTransient = (e) => !!e && !e.fatal && !e.dead && !e.blocked && !e.thinking &&
  (e.timeout || e.interrupted || e.netBeforeStart || e.emptyReply || [408, 429, 500, 502, 503, 504].includes(e.status));

const MAX_WAIT_MS = 10 * 60e3;       // a transient outage is waited out for up to 10 minutes before the student ever sees an error
const LITE_AFTER_MS = 45e3;          // quality tasks fall back to a "lite" model only after the stronger ones failed this long

function raceModels({ apiKey, models, run, task, hedgeMs, signal, onText, onNotice }) {
  return new Promise((resolve, reject) => {
    const order = [...new Set(models)];
    if (!order.length) return reject(new Error("مفيش موديل متاح دلوقتي."));

    const t0 = Date.now();
    const liteTask = /^ocr/.test(task || "");                  // copying text from an image: a lite model is as good as any. (Judging word LEVELS is not: lite models list easy words.)
    const ctrls = new Map();                                   // model → AbortController of its running attempt
    const errs = [], tried = [];
    let winner = null, shown = false, shownLen = 0, settled = false, hedgeTimer = null, wakeTimer = null;
    let attempts = 0, netFails = 0, emptyFails = 0, hedges = 0;
    const raceDead = new Set();                                // models that cannot answer THIS request (404 / bad config): never retried inside this race

    const clearTimers = () => { clearTimeout(hedgeTimer); clearTimeout(wakeTimer); };
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimers();
      ctrls.forEach((c) => c.abort());
      signal && signal.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => finish(() => reject(abortError()));
    if (signal) {
      if (signal.aborted) return reject(abortError());
      signal.addEventListener("abort", onAbort);
    }

    const liveModels = () => {
      const d = deadSet(apiKey);
      const l = order.filter((m) => !d.has(m) && !raceDead.has(m));
      /* everything is remembered as unavailable (e.g. a routing hiccup marked them all) → give them one honest chance anyway */
      return l.length || attempts > 0 ? l : order.filter((m) => !raceDead.has(m));
    };
    const liteAllowed = () => liteTask || Date.now() - t0 > LITE_AFTER_MS || liveModels().every(isLite);   // no stronger model left alive → nothing to wait for
    /* a model that may be started right now: alive, not cooling down, not already running, "lite" only when allowed */
    const readyModels = () => liveModels().filter((m) => !ctrls.has(m) && bGet(apiKey, m).until <= Date.now() && (!isLite(m) || liteAllowed()));

    const claim = (model) => {
      if (settled) return false;
      if (winner === null) {
        winner = model;
        clearTimeout(hedgeTimer);
        markGood(apiKey, model);
        ctrls.forEach((c, m) => { if (m !== model) c.abort(); });
      }
      return winner === model;
    };

    const armHedge = () => {
      clearTimeout(hedgeTimer);
      if (settled || winner !== null || !hedgeMs || hedges >= 2) return;
      hedgeTimer = setTimeout(() => {
        if (settled || winner !== null) return;
        const nxt = readyModels().filter((m) => liteTask || !isLite(m));
        if (nxt.length) { hedges++; launch(nxt[0]); }
        armHedge();
      }, hedgeMs);
    };

    /* nothing running → start the best model that is ready; otherwise sleep until the first cool-down ends */
    const pump = () => {
      if (settled || winner !== null || ctrls.size) return;
      clearTimeout(wakeTimer);
      const live = liveModels();
      if (!live.length) return finish(() => reject(bestError(errs, tried)));
      if (Date.now() - t0 > MAX_WAIT_MS) return finish(() => reject(bestError(errs, tried)));
      const ready = readyModels();
      if (ready.length) return launch(ready[0]);
      /* everything is cooling down (or only "lite" is left and not yet allowed): wait, politely, and tell the UI */
      const soonest = Math.min(...live.filter((m) => !isLite(m) || liteAllowed()).map((m) => bGet(apiKey, m).until), t0 + LITE_AFTER_MS + 500);
      const wait = Math.max(400, Math.min(soonest - Date.now(), 20000));
      if (onNotice) onNotice({ waitMs: wait, attempt: attempts, status: errs.length ? errs[errs.length - 1].status : null });
      wakeTimer = setTimeout(pump, wait);
    };

    function launch(model) {
      if (settled || ctrls.has(model)) return;
      const ctrl = new AbortController();
      ctrls.set(model, ctrl);
      attempts++;
      run(
        model, ctrl.signal,
        (text) => {
          if (!claim(model)) return;
          if (text.length < shownLen) return;            // a resumed answer re-writes from the start: keep the old text on screen until it catches up
          shown = true; shownLen = text.length;
          onText(text, model);
        },
        () => { claim(model); },
      ).then((res) => {
        ctrls.delete(model);
        if (settled || !claim(model)) return;
        finish(() => resolve({ ...res, model }));
      }).catch((e0) => {
        const err = e0 || new Error("unknown");
        ctrls.delete(model);
        if (settled || ctrl.signal.aborted) return;       // lost the race on purpose
        tried.push(`${model} → ${err.status || (err.timeout ? "timeout" : err.emptyReply ? "empty" : "net")}${err.retired ? " (retired)" : ""}`);
        errs.push(err);

        if (err.dead) addDead(apiKey, model, !!err.retired);
        if (err.retired) {
          if (err.replacement) {
            addSuggest(apiKey, err.replacement);
            if (!order.includes(err.replacement) && !deadSet(apiKey).has(err.replacement)) order.unshift(err.replacement);
          }
          selfHeal(apiKey);
        }
        if (err.fatal) return finish(() => reject(err));
        if (err.blocked) return finish(() => reject(err));                           // blocked by Google's safety filter: another try cannot help
        if (err.dead || !isTransient(err)) raceDead.add(model);                       // this model cannot answer this request → others only

        if (err.netBeforeStart && ++netFails >= 4) return finish(() => reject(err));  // really offline: do not keep the student waiting
        if (err.emptyReply && ++emptyFails >= 3) return finish(() => reject(err));
        if (isTransient(err)) coolDown(apiKey, model, err);

        if (winner === model) winner = null;              // it died while answering (or thinking): resume on another / the same model
        if (winner === null) { pump(); armHedge(); }
      });
      armHedge();
    }
    pump();
  });
}

/* public: run one task against a list of candidate models */
export function runTask({ apiKey, models, task, system, parts, spec, maxOut, hedgeMs, firstMs, idleMs, signal, onText, onNotice }) {
  /* callers that only want the final text (word meaning, picture prompt, topics …) pass no onText / signal:
     the engine calls both unconditionally, so give it harmless defaults here, once, for every caller */
  if (typeof onText !== "function") onText = () => {};
  if (!signal) signal = new AbortController().signal;
  return raceModels({
    apiKey, models, task, hedgeMs, signal, onText, onNotice,
    run: (model, sig, emit, alive) => attemptModel({ apiKey, model, task, system, parts, spec, maxOut, signal: sig, onText: emit, onAlive: alive, firstMs, idleMs }),
  });
}


/* ───────────── image generation (Nano Banana family) ─────────────
   The image models are NOT on Google's free tier, so the first answer for a free key is a clear message.
   Model ids change often → the list is read from the API for THIS key (cached 12 h); a static list is the fallback. */

const IMG_PREFERRED = ["gemini-3.1-flash-image", "gemini-nano-banana-2.1", "gemini-3.1-flash-image-preview", "gemini-3-pro-image", "gemini-3-pro-image-preview", "gemini-3.1-flash-lite-image", "gemini-2.5-flash-image"];
const LS_IMG = "nclex:imgmodels:v1";

async function imageModels(apiKey) {
  try {
    const c = JSON.parse(window.localStorage.getItem(LS_IMG));
    if (c && c.key === apiKey.slice(-6) && Date.now() - c.at < 12 * 3600e3 && c.list.length) return c.list;
  } catch (e) { /* ignore */ }
  let names = [];
  try {
    const r = await rawRequest("GET", `${API_BASE}?pageSize=200&key=${encodeURIComponent(apiKey)}`, undefined, 20000);
    names = ((r.json && r.json.models) || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent") && /image|banana/i.test(m.name) && !/imagen/i.test(m.name))
      .map((m) => m.name.replace(/^models\//, ""));
  } catch (e) { /* offline list → fall back */ }
  const rank = (n) => { const i = IMG_PREFERRED.indexOf(n); return i < 0 ? 99 : i; };
  const list = names.length ? [...names].sort((a, b) => rank(a) - rank(b)) : IMG_PREFERRED;
  try { window.localStorage.setItem(LS_IMG, JSON.stringify({ key: apiKey.slice(-6), at: Date.now(), list })); } catch (e) { /* ignore */ }
  return list;
}

export async function generateImage({ apiKey, prompt, parts = [], signal }) {
  const models = await imageModels(apiKey);
  let last = null;
  for (const model of models) {
    if (signal && signal.aborted) throw abortError();
    trackRequest(model);
    const url = `${API_BASE}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const body = { contents: [{ role: "user", parts: [...parts, { text: prompt }] }], generationConfig: { responseModalities: ["TEXT", "IMAGE"] } };
    let r;
    try { r = await rawRequest("POST", url, body, 170000); }
    catch (e) { last = e; continue; }
    if (signal && signal.aborted) throw abortError();
    if (r.status === 200) {
      const ps = (((r.json.candidates || [])[0] || {}).content || {}).parts || [];
      const img = ps.find((p) => p.inlineData && /^image\//.test(p.inlineData.mimeType || "") && !p.thought);
      const text = ps.filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("").trim();
      if (img) {
        try { window.localStorage.setItem(LS_IMG, JSON.stringify({ key: apiKey.slice(-6), at: Date.now(), list: [model, ...models.filter((m) => m !== model)] })); } catch (e) { /* ignore */ }
        return { mime: img.inlineData.mimeType, data: img.inlineData.data, text, model };
      }
      last = Object.assign(new Error("الموديل ما رسمش صورة (ممكن الطلب اتحجب لأسباب أمان). جرّب توصف الصورة بشكل تاني."), { detail: `${model} · no image` });
      continue;
    }
    const msg = (r.json && r.json.error && r.json.error.message) || "";
    const err = classify(r.status, msg);
    if (r.status === 404 || /not found|not supported|unsupported|is not available/i.test(msg)) { last = err; continue; }
    if (r.status === 429 || r.status === 403 || /billing|paid|free.?tier/i.test(msg)) {
      throw Object.assign(new Error("إنشاء الصور في Gemini مش متاح في الباقة المجانية. فعّل الدفع (Billing) من Google AI Studio لو عايزه."), { detail: err.detail, billing: true });
    }
    throw err;
  }
  throw Object.assign(last || new Error("مفيش موديل رسم صور متاح مع المفتاح ده."), { billing: true });
}
