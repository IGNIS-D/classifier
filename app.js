/* 고객 한마디 분류기 — 화면.
 *
 * 흐름: 문장 → 가림(mask.js, 브라우저 안) → AI(api/classify) → 실패하면 규칙(rules.js)
 * 채점: 정답 100건을 규칙으로, 또는 AI로(BATCH 건씩 나눠) 돌려 맞힌 비율을 잰다.
 * 모델: 화면 위 드롭다운에서 고른다. «서버 기본값»이면 서버가 GEMINI_MODEL 또는 코드 기본값을 쓴다.
 */
(function () {
  "use strict";
  const $ = s => document.querySelector(s);
  const S = { criteria: null, test: [], practice: [], aiResults: null, aiModel: "" };

  // 채점 때 한 번에 보내는 문장 수. 서버 MAX_TEXTS(20) 이하여야 한다.
  //   20개씩 보내면 느린 모델에서 서버의 60초 한도를 넘기는 일이 있어 10개로 줄였다.
  const BATCH = 10;

  async function load() {
    const [c, t, p] = await Promise.all([
      fetch("criteria.json").then(r => r.json()),
      fetch("data/answer100.json").then(r => r.json()),
      fetch("data/practice200.json").then(r => r.json()),
    ]);
    S.criteria = c; S.test = t; S.practice = p;
    renderCriteria();
  }

  // ── 탭 ──────────────────────────────────────────────
  document.querySelectorAll(".tabs button").forEach(b => b.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach(x => x.setAttribute("aria-selected", x === b));
    ["try", "score", "rules"].forEach(k => { $("#tab-" + k).hidden = k !== b.dataset.tab; });
  }));

  // ── AI 모델 고르기 ──────────────────────────────────
  // 모델 목록 — 2026-11-06 에 공식 가격표 https://aistudio.google.com/docs/pricing 에서
  //   Free tier 가 «Free of charge» 인 글쓰기(텍스트) 모델 중 다섯 개를 골랐다.
  //   뺀 것: 음성(transcribe · live · native-audio) · 번역(live-translate) · 임베딩 · TTS · 이미지 · 로보틱스 모델,
  //          «Deprecated» 표시가 붙은 gemini-2.5-pro · gemini-2.5-flash (2026-12-01 부터 다른 모델로 넘겨진다고 적혀 있음).
  //   무료지만 목록에 넣지 않은 텍스트 모델: gemini-2.5-flash-lite, Gemma 4 — 필요하면 «직접 입력…».
  // 순서는 «추정»이다. 무료 한도(하루 요청 수)는 AI Studio 에 로그인해야 보이고,
  //   가격표에도 rate-limits 문서(https://aistudio.google.com/docs/rate-limits)에도 모델별 숫자 표가 없다.
  //   근거는 rate-limits 문서의 "Rate limits are more restricted for experimental and preview models." 한 줄뿐이라
  //   프리뷰를 맨 뒤에 두었다. lite 를 앞에 둔 것은 확인하지 못한 짐작이다.
  // 모델 이름은 자주 바뀐다. 고칠 때는 가격표를 다시 본다.
  const MODELS = [
    { id: "gemini-3.5-flash-lite" },
    { id: "gemini-3.1-flash-lite" },
    { id: "gemini-3.8-flash" },
    { id: "gemini-3.6-flash" },
    { id: "gemini-3-flash-preview", tag: "프리뷰" },
  ];
  const CUSTOM = "__custom__";
  const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._\-]{0,63}$/; // 서버(api/classify.py)와 같은 검사. 최종 판단은 서버가 한다
  const KEY_CHOICE = "w2.model.choice", KEY_CUSTOM = "w2.model.custom";
  // localStorage 는 시크릿 창 등에서 막힐 수 있다 — 막혀도 기억만 못 할 뿐 앱은 돈다
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 기억하지 못함 */ } },
  };
  let serverDefault = null; // GET api/classify 로 받는다. 못 받으면 null

  const sel = $("#model-select"), custom = $("#model-custom");
  function opt(value, text) {
    const o = document.createElement("option");
    o.value = value; o.textContent = text; return o;
  }
  sel.append(opt("", "서버 기본값"),
    ...MODELS.map(m => opt(m.id, m.tag ? `${m.id} · ${m.tag}` : m.id)),
    opt(CUSTOM, "직접 입력…"));
  const saved = store.get(KEY_CHOICE);
  if (saved !== null && [...sel.options].some(o => o.value === saved)) sel.value = saved;
  custom.value = store.get(KEY_CUSTOM) || "";

  // 요청에 넣을 모델 이름. «서버 기본값»이면 "" (직접 입력칸이 비어 있어도 "")
  function chosenModel() { return sel.value === CUSTOM ? custom.value.trim() : sel.value; }
  // 사람에게 보여 줄 이름
  function modelName(m) { return m || serverDefault || "서버 기본값"; }

  function renderModel() {
    custom.hidden = sel.value !== CUSTOM;
    const m = chosenModel(), now = $("#model-now");
    const bad = !!m && !MODEL_RE.test(m);
    custom.classList.toggle("bad", bad);
    now.classList.toggle("bad", bad);
    const def = serverDefault || "확인하지 못함 (서버 함수가 없거나 닿지 않음)";
    if (bad) now.textContent = "모델 이름 형식이 맞지 않습니다 — 영문·숫자·. _ - 만, 64자까지. 이대로면 서버가 거절합니다";
    else if (m) now.textContent = `지금 호출하는 모델: ${m}`;
    else if (sel.value === CUSTOM) now.textContent = `이름을 적지 않아 서버 기본값으로 부릅니다: ${def}`;
    else now.textContent = `지금 호출하는 모델: 서버 기본값 — ${def}`;
  }

  sel.addEventListener("change", () => {
    store.set(KEY_CHOICE, sel.value);
    renderModel();
    if (sel.value === CUSTOM) custom.focus();
  });
  custom.addEventListener("input", () => { store.set(KEY_CUSTOM, custom.value); renderModel(); });

  async function loadDefault() {
    try {
      const r = await fetch("api/classify", { headers: { Accept: "application/json" } });
      if (r.ok) {
        const j = await r.json();
        if (typeof j.default === "string") serverDefault = j.default;
      }
    } catch (e) { /* 로컬에는 서버 함수가 없다 — 정상 */ }
    renderModel();
  }

  // ── AI 호출 ─────────────────────────────────────────
  async function askAI(maskedTexts, model) {
    const who = modelName(model);
    try {
      const r = await fetch("api/classify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts: maskedTexts, criteria: S.criteria, model: model || "" }),
      });
      if ([404, 405, 501].includes(r.status)) {
        return { results: null, reason: `서버 함수가 없습니다 (${r.status} · 모델 ${who}) — 배포하면 생깁니다` };
      }
      if (!r.ok) return { results: null, reason: `서버 함수 오류 (${r.status}) — 모델(${who})` };
      return await r.json();
    } catch (e) {
      return { results: null, reason: `서버 함수에 닿지 못했습니다 — 모델(${who})` };
    }
  }

  function chips(el, res) {
    el.innerHTML = ["category", "sentiment", "urgency"]
      .map(k => `<span class="chip ${res[k]}">${res[k]}</span>`).join("");
  }

  // ── 분류해 보기 ─────────────────────────────────────
  $("#btn-sample").addEventListener("click", () => {
    const r = S.practice[Math.floor(Math.random() * S.practice.length)];
    $("#input").value = r.text;
  });

  $("#btn-classify").addEventListener("click", async () => {
    const text = $("#input").value.trim();
    if (!text) return;
    const btn = $("#btn-classify");
    btn.disabled = true; btn.textContent = "분류 중…";

    const m = Mask.mask(text);
    $("#sent").hidden = false;
    $("#sent-text").textContent = m.masked;
    $("#sent-found").innerHTML = m.found.length
      ? m.found.map(f => `<span class="tag">${f.type} 가림</span>`).join("")
      : `<span class="muted">가린 것 없음</span>`;

    const rule = Rules.classify(m.masked, S.criteria);
    const ai = await askAI([m.masked], chosenModel());
    const got = ai.results && ai.results[0];

    $("#result").hidden = false;
    if (got) {
      $("#main-by").textContent = "AI · " + (ai.model || "");
      chips($("#main-chips"), got);
      $("#main-reason").textContent = got.reason || "";
      $("#note").hidden = true;
    } else {
      $("#main-by").textContent = "규칙";
      chips($("#main-chips"), rule);
      $("#main-reason").textContent = `분류: ${rule.why.category} · 감정: ${rule.why.sentiment} · 긴급도: ${rule.why.urgency}`;
      $("#note").hidden = false;
      $("#note").textContent = `AI 없이 규칙으로만 분류했습니다 — ${ai.reason || "AI 응답 없음"}`;
    }
    chips($("#rule-chips"), rule);
    $("#rule-reason").textContent = `분류: ${rule.why.category}`;
    $("#card-rule").hidden = !got;

    btn.disabled = false; btn.textContent = "분류하기";
  });

  // ── 채점 ───────────────────────────────────────────
  function pct(x) { return x.toFixed(x % 1 ? 1 : 0) + "%"; }

  function showScore(who, s) {
    $("#score-table").hidden = false;
    for (const k of ["category", "sentiment", "urgency"]) {
      document.querySelector(`[data-k="${who}-${k}"]`).textContent = pct(s.accuracy[k]);
    }
    document.querySelector(`[data-k="${who}-all"]`).textContent = `${s.n - s.wrong.length} / ${s.n}`;
    $("#wrong").hidden = false;
    $("#wrong-who").textContent = (who === "ai" ? `— AI · ${S.aiModel}` : "— 규칙") + " · 정답 → 판정";
    $("#wrong-list").innerHTML = s.wrong.slice(0, 15).map(w => {
      const diff = ["category", "sentiment", "urgency"].filter(k => w.got[k] !== w.want[k])
        .map(k => `${w.want[k]}→${w.got[k]}`).join(" · ");
      return `<li><span class="t">${w.text}</span><br><span class="d">${diff}${w.note ? " · " + w.note : ""}</span></li>`;
    }).join("") + (s.wrong.length > 15 ? `<li class="d">… 외 ${s.wrong.length - 15}건</li>` : "");
  }

  $("#btn-score-rule").addEventListener("click", () => {
    const s = Rules.score(S.test, r => Rules.classify(Mask.mask(r.text).masked, S.criteria));
    showScore("rule", s);
    $("#score-msg").hidden = true;
  });

  $("#btn-score-ai").addEventListener("click", async () => {
    const btn = $("#btn-score-ai");
    btn.disabled = true;
    const masked = S.test.map(r => Mask.mask(r.text).masked);
    const model = chosenModel(); // 채점 도중 드롭다운을 바꿔도 끝까지 이 모델로 간다
    const results = [];
    let used = "";
    for (let i = 0; i < masked.length; i += BATCH) {
      const chunk = masked.slice(i, i + BATCH);
      btn.textContent = `AI 채점 중… ${i}/${masked.length}`;
      let r = await askAI(chunk, model);
      let retried = false;
      if (!r.results && r.timeout) { // 시간 초과만 그 묶음을 한 번 더
        retried = true;
        btn.textContent = `AI 채점 중… ${i}/${masked.length} · 다시 시도`;
        r = await askAI(chunk, model);
      }
      if (!r.results) {
        $("#score-msg").hidden = false;
        $("#score-msg").textContent = `AI로 채점하지 못했습니다 (${i + 1}~${i + chunk.length}번)`
          + (retried ? " · 한 번 더 시도했지만 실패" : "") + ` — ${r.reason}`;
        btn.disabled = false; btn.textContent = "AI로 채점";
        return;
      }
      used = r.model || used;
      results.push(...r.results);
    }
    // 답을 못 받은 문장은 «오답»으로 센다 — 빠진 것을 빼고 세면 점수가 부풀려진다
    const miss = { category: "-", sentiment: "-", urgency: "-" };
    S.aiResults = results;
    S.aiModel = used || modelName(model);
    $("#ai-col").textContent = `AI · ${S.aiModel}`;
    const s = Rules.score(S.test, (r, i) => results[i] || miss);
    showScore("ai", s);
    const blank = results.filter(x => !x).length;
    $("#score-msg").hidden = !blank;
    if (blank) $("#score-msg").textContent = `AI가 답하지 않은 문장 ${blank}건은 오답으로 셌습니다.`;
    $("#btn-download").hidden = false;
    btn.disabled = false; btn.textContent = "AI로 채점";
  });

  $("#btn-download").addEventListener("click", () => {
    const rows = S.test.map((r, i) => ({ id: r.id, text: r.text, 정답: r, AI: S.aiResults[i] }));
    const blob = new Blob([JSON.stringify(rows, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "ai_채점결과.json"; a.click();
  });

  // ── 기준 ───────────────────────────────────────────
  function renderCriteria() {
    const c = S.criteria;
    $("#owner").textContent = c.owner;
    $("#crit-cats").innerHTML = c.categories
      .map(x => `<tr><td>${x.name}</td><td>${x.definition}</td></tr>`).join("");
    $("#crit-priority").textContent = c.priority.join(" → ") + " 순서로 먼저 봅니다.";
    $("#crit-priority-reason").textContent = c.priority_reason;
    $("#crit-sent").textContent = c.sentiment.guide;
    $("#crit-urg").textContent = c.urgency.guide;
  }

  renderModel();
  loadDefault();
  load();
})();
