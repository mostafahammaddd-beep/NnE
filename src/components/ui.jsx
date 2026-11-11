import React, { useState, useEffect, useLayoutEffect, useRef, useMemo } from "react";
import { useVoiceEngine, setVoiceEngine } from "../lib/speech.js";
import Icon from "./Icon.jsx";
import logoMark from "../assets/logo-mark.webp";
import PhotoKeysPanel from "./PhotoKeys.jsx";
import { getPhotoKeys, setPhotoKeys } from "../lib/photos.js";
import { testConnection, testExtProviders, warmExternal, ENV_KEY, addApiKey, onKeysChanged, providerLabel } from "../lib/gemini.js";
import * as Ring from "../lib/keyring.js";
import { GATEWAY_URL } from "../lib/config.js";
import { getEnginePrefs, setEnginePrefs } from "../lib/providers.js";

/* The ClinixStudy logo (emblem + two-tone wordmark). The emblem sits on a white chip so it reads in both themes. */
export function Brand({ onClick }) {
  return (
    <button onClick={onClick} className="brand" aria-label="ClinixStudy">
      <span className="mark">
        <img src={logoMark} alt="" width="40" height="40" draggable="false" />
      </span>
      <span className="wordmark"><span className="w-clinix">Clinix</span><span className="w-study">Study</span></span>
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

/* how the app picks between the engines (no keys here any more: they live in the one list above) */
function EnginePanel({ prefs, setPrefs }) {
  return (
    <div className="xeng">
      <b className="xeng-h">⚙️ طريقة الاختيار</b>
      <div className="voicepick" role="radiogroup" aria-label="طريقة اختيار المحرك" style={{ marginTop: 8 }}>
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
        <input type="checkbox" checked={prefs.reuse !== false} onChange={(e) => setPrefs({ ...prefs, reuse: e.target.checked })} />
        <span>لو سألت نفس السؤال السهل تاني، اعرض الإجابة المحفوظة <small>(من غير أي توكنز ولا انتظار)</small></span>
      </label>
      <label className="xeng-check">
        <input type="checkbox" checked={prefs.slice} onChange={(e) => setPrefs({ ...prefs, slice: e.target.checked })} />
        <span>قسّم الردود الكبيرة على كذا كاتب في نفس الوقت <small>(أسرع كتير، بس بيستهلك طلبات أكتر)</small></span>
      </label>
    </div>
  );
}

/* v3.34 · ONE box for every key (Google, Claude, ChatGPT, Groq, OpenRouter, Mistral): the app recognises whose it is.
   Any number of keys; they are used in this order and, when one cannot work (its daily limit is finished, it is refused, it is busy), the next one takes over by itself. */
const KEY_STATE = {
  day: (until) => `خلصت حصته اليومية · بيرجع لوحده ${new Date(until).toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" })}`,
  busy: () => "عليه ضغط دلوقتي · بيرجع لوحده",
  bad: () => "مش مقبول من الشركة · امسحه أو بدّله",
};

const TIER_NAME = { weak: "الضعيف (Lite)", mid: "المتوسط (Flash)", strong: "القوي (Pro)" };
function KeyList({ tick, onChanged }) {
  const list = Ring.listKeys();
  if (!list.length) return <p className="keys-empty">لسه مفيش مفاتيح. الصق أول مفتاح فوق.</p>;
  const firstLive = {};
  for (const e of list) if (!firstLive[e.provider] && Ring.isLive(e.key)) firstLive[e.provider] = e.id;
  return (
    <ul className="keys-list" data-tick={tick}>
      {list.map((e, i) => {
        const st = Ring.statusOf(e);
        const note = st.state === "live" ? (firstLive[e.provider] === e.id ? "شغّال دلوقتي" : "احتياطي · بيشتغل لو اللي قبله وقف") : KEY_STATE[st.state](st.until);
        /* a size of model that finished on this key while the key itself is fine: the other sizes keep working (and the jobs of the finished size go to the next key) */
        const tiers = Object.entries(st.tiers || {}).map(([t, p]) => `${TIER_NAME[t]}: ${p.why === "day" ? "خلصت حصته اليومية" : "عليه ضغط"}`).join(" · ");
        return (
          <li key={e.id} className="keys-item" data-state={st.state === "live" ? (firstLive[e.provider] === e.id ? "on" : "standby") : st.state}>
            <div className="keys-main">
              <b>{providerLabel(e.provider)}</b>
              <code dir="ltr">{Ring.mask(e.key)}</code>
              <small>{note}</small>
              {tiers && <small className="keys-tier">{tiers}</small>}
            </div>
            <div className="keys-act">
              <button type="button" className="iconbtn" aria-label="فوق" disabled={i === 0} onClick={() => { Ring.moveKey(e.id, -1); onChanged(); }}>▲</button>
              <button type="button" className="iconbtn" aria-label="تحت" disabled={i === list.length - 1} onClick={() => { Ring.moveKey(e.id, 1); onChanged(); }}>▼</button>
              <button type="button" className="iconbtn" aria-label="امسح المفتاح" onClick={() => { Ring.removeKey(e.id); onKeysChanged(e.provider); onChanged(e.provider); }}><Icon name="trash" size={16} /></button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function KeyModal({ hasEnv, onKeysChanged: notifyApp, onClose }) {
  const [val, setVal] = useState("");
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState(null);
  const [tick, setTick] = useState(0);
  const [test, setTest] = useState(null);
  const [testing, setTesting] = useState(false);
  const [prefs, setPrefs] = useState(getEnginePrefs);
  const [xtest, setXtest] = useState([]);
  const [pkeys, setPkeys] = useState(getPhotoKeys);
  const managed = !!GATEWAY_URL;       // v3.32: the AI is served by the app's own gateway: no key to paste, no extra engines to configure
  const changed = () => { setTick((n) => n + 1); notifyApp && notifyApp(); };
  const persist = () => { setEnginePrefs(prefs); setPhotoKeys(pkeys); };
  const add = async () => {
    if (adding || !val.trim()) return;
    setAdding(true); setMsg(null);
    try {
      const r = await addApiKey(val);
      setMsg({ ok: r.ok, text: r.msg });
      if (r.ok) { setVal(""); changed(); }
    } catch (e) { setMsg({ ok: false, text: "حصلت مشكلة وإحنا بنضيف المفتاح. جرّب تاني." }); }
    finally { setAdding(false); }
  };
  const runTest = async () => {
    persist();
    setTesting(true); setTest(null); setXtest([]);
    try {
      const g = managed ? ENV_KEY : (Ring.keysOf("gemini")[0] || ENV_KEY);
      if (g) { const m = await testConnection(g); setTest({ ok: true, msg: `الاتصال شغال ✅ الموديل: ${m}` }); }
      else if (!Ring.hasAnyKey()) setTest({ ok: false, msg: "ضيف مفتاح الأول." });
    } catch (e) { setTest({ ok: false, msg: e.message, detail: e.detail }); }
    try { if (!managed) setXtest(await testExtProviders()); } catch (e) { /* shown per engine */ }
    finally { setTesting(false); }
  };
  const save = () => { persist(); warmExternal(); onClose(); };
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="card modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-ico"><Icon name="key" size={22} /></span>
          <h2>{managed ? "الذكاء الاصطناعي" : "مفاتيح الـ API"}</h2>
        </div>
        {managed ? (
          <p style={{ marginBottom: 12, fontSize: 14, color: "var(--ink-2)" }}>
            الـ AI شغّال تلقائياً من خدمة التطبيق نفسه: مفيش مفتاح تكتبه ولا محركات تظبطها. لو حاسس إنه واقف أو بطيء، دوس «جرّب الاتصال».
          </p>
        ) : (
          <>
            <p style={{ marginBottom: 10, fontSize: 14, color: "var(--ink-2)" }}>
              الصق أي مفتاح (Google أو Claude أو ChatGPT أو غيرهم) والتطبيق بيعرف نوعه لوحده. ضيف أي عدد: لو واحد خلصت حصته أو وقف، التالي بيشتغل تلقائياً من غير ما تحس.
              {hasEnv ? " (فيه مفتاح مدمج وقت البناء، وبيشتغل آخر واحد)" : ""}
            </p>
            <div className="keys-add">
              <input value={val} onChange={(e) => setVal(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }} dir="ltr" className="input"
                placeholder="الصق المفتاح هنا" autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-label="مفتاح API" />
              <button type="button" onClick={add} disabled={adding || !val.trim()} className="btn btn-teal" style={{ fontWeight: 900 }}>
                <Icon name="plus" size={16} /> {adding ? "بنتأكد…" : "إضافة API"}
              </button>
            </div>
            {msg && <div role="status" className="test-box" data-ok={msg.ok}>{msg.text}</div>}
            <KeyList tick={tick} onChanged={changed} />
            <EnginePanel prefs={prefs} setPrefs={setPrefs} />
          </>
        )}
        <details className="keys-photos">
          <summary>🖼️ مصادر الصور (اختياري)</summary>
          <PhotoKeysPanel keys={pkeys} setKeys={setPkeys} />
        </details>
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
          <button onClick={save} className="btn btn-teal" style={{ flex: 1, fontWeight: 900 }}>تم</button>
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
