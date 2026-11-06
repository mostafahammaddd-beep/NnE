/* ───────────── Static config ───────────── */

export const CHIPS = [
  { id: "egy", label: "شرح بالبلدي 🇪🇬", icon: "chat", excludes: "en",
    rule: "Write the teaching text in casual Egyptian Arabic (عامية مصرية), like a friendly senior nurse coaching a junior. Keep every medical term and every English exam phrase in English." },
  { id: "en", label: "إنجليزي بحت 🇬🇧", icon: "languages", excludes: "egy",
    rule: "Write EVERYTHING in clear, simple English (A2–B1 words, short sentences). Do not use any Arabic at all, not even in the headings or the new-words meanings." },
  { id: "emoji", label: "إضافة إيموجي ✨", icon: "sparkles",
    rule: "Use relevant emojis generously (✅ for correct, ❌ for wrong, 🚨 for traps, 💡 for tips) to make the text lively and memorable." },
  { id: "simple", label: "شرح مبسط ⚡", icon: "zap",
    rule: "Explain with extra-simple language, very short sentences and everyday analogies, as if to someone who is overwhelmed and has never seen the topic." },
  { id: "sum", label: "لخّص", icon: "list",
    rule: "Be CONCISE: keep only what the student must know, merge related bullets, drop side examples and repetition, and aim for about 45% of the normal length. Never drop a number, a drug name, a trap or the final decision rule." },
  { id: "tr", label: "ترجم كل الإنجليزي", icon: "languages", excludes: "en",
    rule: "TRANSLATE EVERY ENGLISH LINE: whenever you write an English sentence, phrase or term (in ANY section, including the new-words notes and the quotes), put its Arabic meaning right next to it on the same line after \" — \". No English sentence may appear without its Arabic meaning beside it." },
];

/* cls = css class that sets the section accent (--acc / --acc-rgb / --acc-ink) in light + dark.
   wait = what the placeholder says while this section is still being written. */
export const SECTIONS = [
  { key: "original_question_text", title: "نص السؤال", sub: "اللي اتقرا من الصورة أو الملف", icon: "fileText", rows: 6, cls: "sec-sky", ltr: true, step: "read",
    wait: "بنقرا السؤال من الصورة أو الملف…" },
  { key: "new_words", title: "كلمات جديدة", sub: "الكلمات من مستوى B2 فما فوق + المصطلحات الطبية", icon: "library", rows: 8, cls: "sec-violet", step: "words",
    wait: "بنلمّ كل كلمة ممكن تكون غريبة عليك…" },
  { key: "explanation", title: "تفصيص السؤال", sub: "شرح من الصفر + الإنجليزي", icon: "brain", rows: 12, cls: "sec-teal", step: "explain",
    wait: "بيفكّر في السؤال علشان يشرحه من الصفر…" },
  { key: "tricks", title: "التريكات", sub: "الفخ المخفي في السؤال", icon: "lightbulb", rows: 5, cls: "sec-coral", step: "tricks",
    wait: "بيدوّر على الفخاخ اللي ممكن تقع فيها…" },
];

/* the "شرح" side: the same four cards, filled from study material instead of one exam question */
export const LESSON_SECTIONS = [
  { key: "original_question_text", title: "ملخص المادة", sub: "عن إيه الملفات اللي رفعتها", icon: "fileText", rows: 6, cls: "sec-sky", rich: true, step: "read",
    wait: "بنقرا المادة ونعمل لها خريطة…" },
  { key: "new_words", title: "كلمات جديدة", sub: "أهم المصطلحات والكلمات الصعبة في المادة", icon: "library", rows: 8, cls: "sec-violet", step: "words",
    wait: "بنلمّ المصطلحات الصعبة في المادة…" },
  { key: "explanation", title: "الشرح من الصفر", sub: "كل موضوع من الأساس + الإنجليزي", icon: "brain", rows: 14, cls: "sec-teal", step: "explain",
    wait: "بيذاكر المادة علشان يشرحها لك من الصفر…" },
  { key: "tricks", title: "نقاط الحفظ والفخاخ", sub: "اللي بيجي في الامتحان", icon: "lightbulb", rows: 6, cls: "sec-coral", step: "tricks",
    wait: "بيجهّز لك نقاط الحفظ والفخاخ…" },
];
export const sectionsFor = (kind) => (kind === "lesson" ? LESSON_SECTIONS : SECTIONS);

export const EMPTY_RESULT = { original_question_text: "", new_words: "", explanation: "", tricks: "" };

/* Analysis presets.
   OCR + new-words always use the FAST tier with (almost) no thinking.
   The lesson is built by a PIPELINE, so its wall-clock time is the longest stage, not the sum of everything:

     solve  (strong model, thinks, writes only a tiny verified brief)  ──► lessonB (fast model writes it up)
     lessonA (fast model, needs no answer: decode English + basics)    ──► runs at the same instant as `solve`

   solve : tier = which model family thinks · levels (Gemini 3) / budget (Gemini 2.5) = how hard it thinks
   write : the fast model that writes the lesson · words = length cap per part (parts run in parallel)
   maxOut counts the hidden "thinking" tokens too, so it must stay far above the visible text.
   hedgeMs = how long a model may show NO sign of life (not even a thought summary) before a second one starts. */
export const MODES = {
  balanced: {
    id: "balanced", label: "متوازن", sub: "", icon: "scale",
    solve: { tier: "fast", levels: ["medium", "low"], budget: 4096, maxOut: 16000, hedgeMs: 12000, idleMs: 60000, firstMs: 120000 },
    write: { tier: "fast", levels: ["minimal", "low"], budget: 0, maxOut: 16000, hedgeMs: 7000, idleMs: 60000, firstMs: 90000, words: { a: 680, b: 980 } },
    /* part A needs no answer, so it starts at second 0 and runs while the answer is still being solved → it can afford to THINK */
    writeA: { tier: "fast", levels: ["low", "minimal"], budget: 1024, maxOut: 20000, hedgeMs: 9000, idleMs: 60000, firstMs: 100000 },
  },
  deep: {
    id: "deep", label: "دقة قصوى", sub: "أعمق تفكير", icon: "target",
    solve: { tier: "pro", levels: ["high"], budget: 16384, maxOut: 40000, hedgeMs: 40000, idleMs: 150000, firstMs: 240000 },
    write: { tier: "fast", levels: ["low", "minimal"], budget: 1024, maxOut: 24000, hedgeMs: 9000, idleMs: 90000, firstMs: 120000, words: { a: 850, b: 1300 } },
    writeA: { tier: "fast", levels: ["medium", "low"], budget: 2048, maxOut: 24000, hedgeMs: 11000, idleMs: 90000, firstMs: 140000 },
  },
};

export const CHEERS = [
  "كل سؤال بتحله بيقرّبك من الـ RN 💙",
  "فهم سؤال واحد صح أحسن من حفظ عشرة 🌟",
  "خطوة صغيرة النهاردة، رخصة بكرة 🩺",
  "أنت أقرب مما تتخيل. كمّل! 🚀",
  "الإنجليزي بيتبني كلمة كلمة، وإنت ماشي صح ✨",
];

export const GOALS = [3, 5, 8, 10, 15, 20];
