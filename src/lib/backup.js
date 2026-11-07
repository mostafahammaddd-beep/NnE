/* ───────────── Backup / restore ─────────────
   Everything lives on this device only (IndexedDB). One tap saves it all to a JSON file; one tap brings it back.
   The API key is NEVER included. */
import { store } from "./storage.js";
import { convKeys } from "./chathist.js";

const BASE = ["nclex:questions", "nclex:words", "nclex:mode", "nclex:goal", "nclex:topics", "nclex:vocab", "nclex:chat:global"];

export async function buildBackup() {
  const data = {};
  for (const k of [...BASE, ...(await convKeys("nclex:chat:global"))]) { const v = await store.get(k); if (v !== null) data[k] = v; }
  const qs = Array.isArray(data["nclex:questions"]) ? data["nclex:questions"] : [];
  for (const q of qs) {
    for (const k of [`nclex:img:${q.id}`, `nclex:chat:${q.id}`, ...(await convKeys(`nclex:chat:${q.id}`))]) { const v = await store.get(k); if (v !== null) data[k] = v; }
  }
  return { app: "nclex-rn", version: 1, savedAt: Date.now(), count: qs.length, data };
}

export async function downloadBackup() {
  const b = await buildBackup();
  const blob = new Blob([JSON.stringify(b)], { type: "application/json" });
  const a = document.createElement("a");
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  a.href = URL.createObjectURL(blob);
  a.download = `nclex-backup-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return b.count;
}

/* merge: questions are matched by id (the newer one wins); words/topics/vocab are merged too */
export async function restoreBackup(file) {
  let b;
  try { b = JSON.parse(await file.text()); } catch (e) { throw new Error("الملف مش نسخة احتياطية صالحة."); }
  if (!b || b.app !== "nclex-rn" || !b.data || typeof b.data !== "object") throw new Error("الملف مش نسخة احتياطية صالحة.");
  const d = b.data;
  const cur = (await store.get("nclex:questions")) || [];
  const map = new Map(cur.map((q) => [q.id, q]));
  let added = 0;
  for (const q of d["nclex:questions"] || []) {
    const old = map.get(q.id);
    if (!old) added += 1;
    if (!old || (q.updatedAt || 0) >= (old.updatedAt || 0)) map.set(q.id, q);
  }
  await store.set("nclex:questions", [...map.values()].sort((a, c) => (c.updatedAt || 0) - (a.updatedAt || 0)));
  for (const [k, v] of Object.entries(d)) {
    if (k === "nclex:questions" || k === "nclex:apikey") continue;
    if (k === "nclex:vocab") { await store.set(k, { ...(v || {}), ...((await store.get(k)) || {}) }); continue; }
    if (k === "nclex:words") { const w = (await store.get(k)) || []; const ids = new Set(w.map((x) => x.id || x.qid)); await store.set(k, [...w, ...(v || []).filter((x) => !ids.has(x.id || x.qid))]); continue; }
    if (k === "nclex:topics") { if (!(await store.get(k))) await store.set(k, v); continue; }
    if (k.startsWith("nclex:chat:") && k.endsWith(":idx")) {   // the list of conversations of a chat: merged by id, never replaced
      const have = (await store.get(k)) || [];
      const ids = new Set(have.map((e) => e.id));
      await store.set(k, [...have, ...(Array.isArray(v) ? v : []).filter((e) => e && !ids.has(e.id))]);
      continue;
    }
    if (k.startsWith("nclex:img:") || k.startsWith("nclex:chat:")) { if ((await store.get(k)) === null) await store.set(k, v); continue; }
    if ((await store.get(k)) === null) await store.set(k, v);
  }
  return { added, total: map.size };
}
