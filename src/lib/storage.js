/* ───────────── Storage ─────────────
   IndexedDB (big quota, good for images) with a localStorage fallback.
   `loadBoot()` reads everything the first screen needs in ONE transaction so the
   app can render its final UI on the very first paint (no spinner, no layout jump). */

import { shapeTopics } from "./topics.js";

let _dbp = null;
const openDb = () => {
  if (!_dbp) {
    _dbp = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") return reject(new Error("no idb"));
      const r = indexedDB.open("nclex-rn", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return _dbp;
};

const idbRun = async (mode, fn) => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("kv", mode);
    const req = fn(tx.objectStore("kv"));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
};

export const store = {
  async get(key) {
    try {
      const v = await idbRun("readonly", (s) => s.get(key));
      return v === undefined ? null : v;
    } catch (e) {
      try { const v = window.localStorage.getItem(key); return v ? JSON.parse(v) : null; }
      catch (e2) { return null; }
    }
  },
  async set(key, value) {
    try { await idbRun("readwrite", (s) => s.put(value, key)); return true; }
    catch (e) {
      try { window.localStorage.setItem(key, JSON.stringify(value)); return true; }
      catch (e2) { return false; }
    }
  },
  async del(key) {
    try { await idbRun("readwrite", (s) => s.delete(key)); }
    catch (e) { try { window.localStorage.removeItem(key); } catch (e2) { /* ignore */ } }
  },
};

const BOOT_KEYS = ["nclex:questions", "nclex:words", "nclex:apikey", "nclex:mode", "nclex:goal", "nclex:perf", "nclex:topics", "nclex:vocab"];

export async function loadBoot() {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("kv", "readonly");
      const st = tx.objectStore("kv");
      const out = {};
      BOOT_KEYS.forEach((k) => {
        const r = st.get(k);
        r.onsuccess = () => { out[k] = r.result === undefined ? null : r.result; };
      });
      tx.oncomplete = () => resolve(shape(out));
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch (e) {
    const out = {};
    for (const k of BOOT_KEYS) out[k] = await store.get(k);
    return shape(out);
  }
}

function shape(o) {
  return {
    questions: Array.isArray(o["nclex:questions"]) ? o["nclex:questions"] : [],
    words: Array.isArray(o["nclex:words"]) ? o["nclex:words"] : [],
    apiKey: typeof o["nclex:apikey"] === "string" ? o["nclex:apikey"].trim() : "",
    mode: typeof o["nclex:mode"] === "string" ? o["nclex:mode"] : null,
    goal: Number.isFinite(o["nclex:goal"]) ? o["nclex:goal"] : 5,
    topics: shapeTopics(o["nclex:topics"]),
    vocab: o["nclex:vocab"] && typeof o["nclex:vocab"] === "object" ? o["nclex:vocab"] : {},
    perf: o["nclex:perf"] && typeof o["nclex:perf"] === "object" ? o["nclex:perf"] : {},
  };
}

/* Tiny synchronous prefs (theme) — localStorage so it can be read before first paint. */
export const prefs = {
  get(k, d = null) { try { const v = window.localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
};
