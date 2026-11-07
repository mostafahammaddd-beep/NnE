import React, { useState, useEffect, useLayoutEffect, useRef, useMemo } from "react";
import { useVoiceEngine, setVoiceEngine } from "../lib/speech.js";
import Icon from "./Icon.jsx";
import { testConnection, testExtProviders, warmExternal } from "../lib/gemini.js";
import { PROVIDERS, PROVIDER_IDS, getSavedExtKeys, setExtKeys, getEnginePrefs, setEnginePrefs } from "../lib/providers.js";

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

/* which American voice reads the words */
function VoicePick() {
  const v = useVoiceEngine();
  const opts = [
    ["google", "أمريكي سريع", "بدون حد يومي · صوت أنثوي"],
    ["gemini", "أمريكي رجالي", "Gemini · أبطأ وله حد يومي"],
  ];
  return (
    <div className="voicepick" role="radiogroup" aria-label="صوت النطق" style={{ marginTop: 14 }}>
      <b style={{ fontSize: 13.5, color: "var(--ink-2)" }}>صوت النطق</b>
      <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
        {opts.map(([id, name, sub]) => (
          <button key={id} type="button" role="radio" aria-checked={v === id} onClick={() => setVoiceEngine(id)}
            className={`btn ${v === id ? "btn-teal" : "btn-ghost"}`} style={{ flex: 1, flexDirection: "column", gap: 2, padding: "10px 8px", lineHeight: 1.3 }}>
            <span style={{ fontWeight: 900, fontSize: 14 }}>{name}</span>
            <small style={{ fontSize: 11.5, fontWeight: 600, opacity: .85 }}>{sub}</small>
          </button>
        ))}
      </div>
    </div>
  );
}

/* extra free engines + how the app picks between them (v3.26) */
const ENGINE_OPTS = [
  ["auto", "تلقائي", "جودة Gemini، ولو بطّأ يتحوّل لمحرك تاني"],
  ["quality", "جودة أولاً", "Gemini بس، والإضافي في الطوارئ"],
  ["speed", "سرعة قصوى", "الدردشة على أسرع محرك متاح"],
];

function EnginePanel({ keys, setKeys, prefs, setPrefs }) {
  return (
    <div className="xeng">
      <b className="xeng-h">⚡ محركات مجانية إضافية <small>(اختياري)</small></b>
      <p className="xeng-p">
        كل محرك له حصة مجانية مستقلة تماماً عن Google. لو Google زحمة، الرد بيتحوّل لمحرك تاني في نفس اللحظة بدل ما تستنى.
        مفتاح واحد كفاية، ومن غيرهم التطبيق شغال عادي.
      </p>
      {PROVIDER_IDS.map((id) => (
        <label key={id} className="xeng-row">
          <span>{PROVIDERS[id].label} <small dir="ltr">{PROVIDERS[id].keyUrl}</small></span>
          <input value={keys[id] || ""} onChange={(e) => setKeys({ ...keys, [id]: e.target.value })} dir="ltr" className="input"
            placeholder={PROVIDERS[id].keyHint} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        </label>
      ))}
      <div className="voicepick" role="radiogroup" aria-label="طريقة اختيار المحرك" style={{ marginTop: 12 }}>
        <b style={{ fontSize: 13.5, color: "var(--ink-2)" }}>طريقة الاختيار</b>
        <div className="xeng-modes">
          {ENGINE_OPTS.map(([id, name, sub]) => (
            <button key={id} type="button" role="radio" aria-checked={prefs.mode === id} onClick={() => setPrefs({ ...prefs, mode: id })}
              className={`btn ${prefs.mode === id ? "btn-teal" : "btn-ghost"}`}>
              <span style={{ fontWeight: 900, fontSize: 14 }}>{name}</span>
              <small>{sub}</small>
            </button>
          ))}
        </div>
      </div>
      <label className="xeng-check">
        <input type="checkbox" checked={prefs.slice} onChange={(e) => setPrefs({ ...prefs, slice: e.target.checked })} />
        <span>قسّم الردود الكبيرة على كذا كاتب في نفس الوقت <small>(أسرع كتير، بس بيستهلك طلبات أكتر)</small></span>
      </label>
    </div>
  );
}

export function KeyModal({ current, hasEnv, onSave, onClose }) {
  const [val, setVal] = useState(current || "");
  const [test, setTest] = useState(null);
  const [testing, setTesting] = useState(false);
  const [xkeys, setXkeys] = useState(getSavedExtKeys);
  const [prefs, setPrefs] = useState(getEnginePrefs);
  const [xtest, setXtest] = useState([]);
  const persist = () => { setExtKeys(xkeys); setEnginePrefs(prefs); };       // the extra engines are saved here; the Gemini key goes through onSave
  const runTest = async () => {
    const k = (val || "").trim() || current;
    persist();
    setTesting(true); setTest(null); setXtest([]);
    try {
      if (k) { const m = await testConnection(k); setTest({ ok: true, msg: `الاتصال شغال ✅ الموديل: ${m}` }); }
      else if (!Object.values(xkeys).some((x) => (x || "").trim())) { setTest({ ok: false, msg: "اكتب المفتاح الأول." }); }
    } catch (e) { setTest({ ok: false, msg: e.message, detail: e.detail }); }
    try { setXtest(await testExtProviders()); } catch (e) { /* shown per engine */ }
    finally { setTesting(false); }
  };
  const save = () => { persist(); warmExternal(); onSave(val); };
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
        <EnginePanel keys={xkeys} setKeys={setXkeys} prefs={prefs} setPrefs={setPrefs} />
        <VoicePick />
        <button onClick={runTest} disabled={testing} className="btn btn-ghost" style={{ width: "100%", marginTop: 12 }}>
          {testing ? "بنجرّب الاتصال…" : "جرّب الاتصال"}
        </button>
        {test && (
          <div role="status" className="test-box" data-ok={test.ok}>
            {test.msg}
            {test.detail && <small>{test.detail}</small>}
          </div>
        )}
        {xtest.map((x) => (
          <div key={x.id} role="status" className="test-box" data-ok={x.ok}>
            {x.msg}
            {x.detail && <small>{x.detail}</small>}
          </div>
        ))}
        <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
          <button onClick={save} className="btn btn-teal" style={{ flex: 1, fontWeight: 900 }}>حفظ</button>
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
