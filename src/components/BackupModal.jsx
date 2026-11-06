import React, { useState, useRef } from "react";
import Icon from "./Icon.jsx";
import { downloadBackup, restoreBackup } from "../lib/backup.js";

export default function BackupModal({ onClose }) {
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  const run = async (fn, okMsg, reload) => {
    setBusy(true); setMsg("");
    try { const r = await fn(); setMsg(okMsg(r)); if (reload) setTimeout(() => window.location.reload(), 1200); }
    catch (e) { setMsg(e.message || "حصلت مشكلة."); }
    setBusy(false);
  };
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="card modal" role="dialog" aria-modal="true" aria-label="نسخة احتياطية" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2>نسخة احتياطية</h2><button type="button" className="iconbtn" onClick={onClose} aria-label="إغلاق"><Icon name="x" size={18} /></button></div>
        <p className="move-sub">كل أسئلتك وكلماتك ومواضيعك محفوظة على الجهاز ده بس. خُد نسخة دورية عشان ما تضيعش لو مسحت بيانات المتصفح أو غيّرت الجهاز. مفتاح Gemini مش بيتحفظ فيها.</p>
        <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
          <button type="button" className="btn btn-teal" disabled={busy} onClick={() => run(downloadBackup, (n) => `اتحفظت نسخة فيها ${n} سؤال ✅`)}>
            <Icon name="download" size={18} /> حفظ نسخة احتياطية
          </button>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => fileRef.current?.click()}>استرجاع من نسخة</button>
          <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) run(() => restoreBackup(f), (r) => `اترجّع ${r.added} سؤال جديد (الإجمالي ${r.total}). بيتعاد التحميل…`, true); }} />
        </div>
        {msg && <p className="move-sub" role="status" style={{ marginTop: 12 }}>{msg}</p>}
      </div>
    </div>
  );
}
