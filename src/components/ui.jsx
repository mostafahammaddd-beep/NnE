import React, { useState, useEffect, useLayoutEffect, useRef, useMemo } from "react";
import Icon from "./Icon.jsx";
import { testConnection } from "../lib/gemini.js";

/* The same yellow ECG line as the app icon, on the same teal → sky gradient. */
export function Brand({ onClick }) {
  return (
    <button onClick={onClick} className="brand" aria-label="NCLEX-RN">
      <span className="mark">
        <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true">
          <path d="M3 14.5h5.2l2.3-6.4 3.7 11.2 2.7-6.2h5.1" stroke="#FFCA3A" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span className="wordmark">NCLEX-RN</span>
    </button>
  );
}

export function Toast({ msg }) {
  if (!msg) return null;
  return (
    <div className="toast-wrap" role="status">
      <div className="toast"><Icon name="check" size={18} /> {msg}</div>
    </div>
  );
}

export function ConfirmButton({ onConfirm, label = "حذف", confirmLabel = "تأكيد الحذف؟", iconOnly }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button type="button" className="btn btn-danger btn-sm" data-armed={armed} aria-label={label}
      onClick={(e) => { e.stopPropagation(); armed ? onConfirm() : setArmed(true); }}>
      <Icon name="trash" size={16} />
      {(!iconOnly || armed) && <span>{armed ? confirmLabel : label}</span>}
    </button>
  );
}

export function AutoTextArea({ value, onChange, rows = 4, ltr, placeholder }) {
  const ref = useRef(null);
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + 2 + "px";
  };
  useLayoutEffect(fit, [value]);
  useEffect(() => {
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  return (
    <textarea ref={ref} dir={ltr ? "ltr" : "auto"} rows={rows} value={value} placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)} className="input area" />
  );
}

export function KeyModal({ current, hasEnv, onSave, onClose }) {
  const [val, setVal] = useState(current || "");
  const [test, setTest] = useState(null);
  const [testing, setTesting] = useState(false);
  const runTest = async () => {
    const k = (val || "").trim() || current;
    if (!k) { setTest({ ok: false, msg: "اكتب المفتاح الأول." }); return; }
    setTesting(true); setTest(null);
    try { const m = await testConnection(k); setTest({ ok: true, msg: `الاتصال شغال ✅ الموديل: ${m}` }); }
    catch (e) { setTest({ ok: false, msg: e.message, detail: e.detail }); }
    finally { setTesting(false); }
  };
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="card modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-ico"><Icon name="key" size={22} /></span>
          <h2>مفتاح Gemini API</h2>
        </div>
        <p style={{ marginBottom: 12, fontSize: 14, color: "var(--ink-2)" }}>
          الصق المفتاح هنا مرة واحدة وهيتحفظ على موبايلك بس.
          {hasEnv ? " (فيه مفتاح مدمج وقت البناء، وده هيتفوق عليه لو كتبته)" : ""}
        </p>
        <input value={val} onChange={(e) => setVal(e.target.value)} dir="ltr" className="input"
          placeholder="AIza…" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        <button onClick={runTest} disabled={testing} className="btn btn-ghost" style={{ width: "100%", marginTop: 12 }}>
          {testing ? "بنجرّب الاتصال…" : "جرّب الاتصال"}
        </button>
        {test && (
          <div role="status" className="test-box" data-ok={test.ok}>
            {test.msg}
            {test.detail && <small>{test.detail}</small>}
          </div>
        )}
        <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
          <button onClick={() => onSave(val)} className="btn btn-teal" style={{ flex: 1, fontWeight: 900 }}>حفظ</button>
          <button onClick={onClose} className="btn btn-ghost">إلغاء</button>
        </div>
      </div>
    </div>
  );
}


/* a short, light confetti burst (pure CSS; reduced-motion users get nothing moving) */
const CONFETTI = ["#FFC933", "#1BA8C9", "#0B8A82", "#7461EE", "#FF7F6D", "#3BD38F"];
export function Confetti() {
  const pieces = useMemo(() => Array.from({ length: 34 }, (_, i) => ({
    c: CONFETTI[i % CONFETTI.length],
    x: Math.round((Math.random() - 0.5) * 340),
    y: Math.round(160 + Math.random() * 300),
    r: Math.round((Math.random() - 0.5) * 900),
    d: (Math.random() * 0.25).toFixed(2),
    w: 7 + Math.round(Math.random() * 5),
  })), []);
  return (
    <div className="confetti" aria-hidden="true">
      {pieces.map((p, i) => (
        <i key={i} style={{ "--c": p.c, "--x": `${p.x}px`, "--y": `${p.y}px`, "--r": `${p.r}deg`, "--d": `${p.d}s`, width: p.w, height: p.w + 5 }} />
      ))}
    </div>
  );
}
