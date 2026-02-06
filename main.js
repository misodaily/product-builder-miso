// main.js (ESM) - miso-daily MVP
console.log("main.js loaded ✅");

const firebaseConfig = {
  apiKey: "AIzaSyAv-PJSqX_SqgYZkh3P9i4ZTpCHEYLBppU",
  authDomain: "miso-daily.firebaseapp.com",
  projectId: "miso-daily",
  appId: "1:235143162650:web:f0dacb14f0c9bcc8b71aa3",
};

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged,
  GoogleAuthProvider, signInWithPopup,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, setDoc, getDoc, updateDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ✅ 리전 지정(권장): 너 프로젝트 Firestore가 asia-northeast3
const functions = getFunctions(app, "asia-northeast3");
const aiScenarioCheck = httpsCallable(functions, "aiScenarioCheck");

let currentUid = null;
let currentScenarioId = null;

const $ = (id) => document.getElementById(id);
function setStatus(msg, ok=true) {
  $("validation").innerHTML = ok ? `<span class="ok">✅ ${msg}</span>` : `<span class="danger">⚠️ ${msg}</span>`;
}

// ---------- 티커 자동 변환 ----------
const TICKER_ALIASES = {
  "테슬": "TSLA", "테슬라": "TSLA", "tsla": "TSLA", "tesla": "TSLA",
  "애플": "AAPL", "aapl": "AAPL", "apple": "AAPL",
  "엔비디아": "NVDA", "nvidia": "NVDA", "nvda": "NVDA",
  "마이크로소프트": "MSFT", "microsoft": "MSFT", "msft": "MSFT",
  "아마존": "AMZN", "amazon": "AMZN", "amzn": "AMZN",
  "구글": "GOOGL", "알파벳": "GOOGL", "googl": "GOOGL", "google": "GOOGL",
  "삼성전자": "005930", "005930": "005930",
  "sk하이닉스": "000660", "하이닉스": "000660", "000660": "000660",
};

function normalizeTickerInput(raw) {
  const t = (raw || "").trim();
  if (!t) return { raw: "", ticker: "" };
  const key = t.toLowerCase().replace(/\s+/g, "");
  const mapped = TICKER_ALIASES[key] || TICKER_ALIASES[t] || null;

  if (mapped) return { raw: t, ticker: mapped };
  if (/^\d{6}$/.test(t)) return { raw: t, ticker: t };
  if (/^[a-zA-Z.]{1,10}$/.test(t)) return { raw: t, ticker: t.toUpperCase() };
  return { raw: t, ticker: t };
}

const tickerEl = $("ticker");
if (tickerEl) {
  tickerEl.addEventListener("input", () => {
    const { ticker } = normalizeTickerInput(tickerEl.value);
    const hint = $("tickerHint");
    if (hint) hint.textContent = ticker ? `인식된 티커: ${ticker}` : "";
  });
  tickerEl.addEventListener("blur", () => {
    const { ticker } = normalizeTickerInput(tickerEl.value);
    if (ticker) tickerEl.value = ticker;
  });
}

// ---------- 매도 기준(손절 기준) 템플릿 ----------
function sellRuleFromTemplate() {
  const tpl = $("exitTpl")?.value || "";
  const m1 = $("m1").value;
  const m2 = $("m2").value;

  if (tpl === "m1_down_2q") return `${m1}이(가) 2분기 연속 하락하면 매도`;
  if (tpl === "m2_down_2q") return `${m2}이(가) 2분기 연속 하락하면 매도`;
  if (tpl === "guide_down") return "가이던스 하향 발표 시 매도";
  if (tpl === "thesis_break") return "가설을 깨는 공시/뉴스 발생 시 매도";
  return "";
}

function refreshSellPreview() {
  const p = $("exitPreview");
  if (p) p.textContent = sellRuleFromTemplate();
}
["exitTpl", "m1", "m2"].forEach((id) => {
  const el = $(id);
  if (el) el.addEventListener("change", refreshSellPreview);
});
refreshSellPreview();

// ---------- 로그인 UI 토글 ----------
$("toggleAlt").onclick = () => {
  const box = $("altLogin");
  box.style.display = (box.style.display === "none" ? "block" : "none");
};

onAuthStateChanged(auth, (user) => {
  currentUid = user ? user.uid : null;
  $("authState").textContent = user ? `로그인 상태: ${user.email}` : "로그인 상태: -";

  const isLoggedIn = !!user;

  $("btnGoogle").style.display = isLoggedIn ? "none" : "block";
  $("toggleAlt").style.display = isLoggedIn ? "none" : "inline";
  $("altLogin").style.display = "none";
  $("btnLogout").style.display = isLoggedIn ? "block" : "none";

  $("loginHint").innerHTML = isLoggedIn
    ? "✅ 로그인 완료. 아래에서 종목과 시나리오를 작성해보세요."
    : "Google로 빠르게 시작하거나, 아래에서 다른 방법을 선택할 수 있어요.";
});

// ---------- Auth: Google / Email ----------
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

$("btnGoogle").onclick = async () => {
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    console.error(e);
    alert("Google 로그인 실패. 팝업 차단/도메인 설정을 확인하세요.\n(콘솔에서 에러 로그 확인)");
  }
};

$("btnSignup").onclick = async () => {
  try {
    await createUserWithEmailAndPassword(auth, $("email").value.trim(), $("pw").value.trim());
  } catch (e) {
    console.error(e);
    alert("이메일 회원가입 실패(콘솔 로그 확인)");
  }
};

$("btnLogin").onclick = async () => {
  try {
    await signInWithEmailAndPassword(auth, $("email").value.trim(), $("pw").value.trim());
  } catch (e) {
    console.error(e);
    alert("이메일 로그인 실패(콘솔 로그 확인)");
  }
};

$("btnLogout").onclick = async () => {
  await signOut(auth);
};

// ---------- Hash(캐시용) ----------
async function sha256(str) {
  const enc = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ---------- 시나리오(글자수 제한 없음) ----------
function scenarioFromUI() {
  const { ticker } = normalizeTickerInput($("ticker").value);
  return {
    ticker,
    timeframe: $("timeframe").value,
    thesis: $("thesis").value.trim(),
    evidence1Text: $("e1t").value.trim(),
    evidence2Text: $("e2t").value.trim(),
    evidence1Link: "",
    evidence2Link: "",
    counterPick: $("counterPick")?.value || "",
    exitRule: sellRuleFromTemplate(),
    metrics: [ $("m1").value, $("m2").value ],
    updatedAt: serverTimestamp(),
  };
}

// ✅ 게시 검증 최소화
function validatePublish(s) {
  const errs = [];
  if (!s.ticker) errs.push("ticker 필요");
  if (!s.exitRule) errs.push("매도 기준(템플릿) 선택");
  if (!s.metrics || s.metrics.length !== 2 || s.metrics[0] === s.metrics[1]) errs.push("지표 2개(서로 다르게)");
  return errs;
}

// ---------- Draft 저장 ----------
$("btnSave").onclick = async () => {
  if (!currentUid) return alert("먼저 로그인하세요.");

  const s = scenarioFromUI();
  const base = `${s.ticker}|${s.timeframe}|${s.thesis}|${s.evidence1Text}|${s.evidence2Text}|${s.counterPick}|${s.exitRule}|${s.metrics.join(",")}`;
  const contentHash = await sha256(base);

  if (!currentScenarioId) {
    currentScenarioId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    $("scenarioId").textContent = currentScenarioId;
  }

  await setDoc(doc(db, "scenarios", currentScenarioId), {
    uid: currentUid,
    status: "draft",
    ...s,
    contentHash,
    logicScore: null,
    gaps: [],
    rewrite: [],
    commentCount: 0,
    acceptedCount: 0,
    lastCommentAt: null,
    hasGaps: true,
  }, { merge: true });

  const tips = [];
  if ((s.thesis || "").length < 6) tips.push("가설을 한 문장만 더 구체화해보세요.");
  if ((s.evidence1Text || "").length < 8) tips.push("근거1을 한 줄만 더 추가해보세요.");
  if ((s.evidence2Text || "").length < 8) tips.push("근거2를 한 줄만 더 추가해보세요.");
  if (tips.length) setStatus("Draft 저장됨 · " + tips.join(" "), true);
  else setStatus("Draft 저장됨", true);
};

// ---------- 반례 후보 자동 생성(프론트 간단) ----------
function genCounterOptionsSimple(s) {
  const base = [
    "실적/가이던스가 기대에 못 미칠 가능성",
    "경쟁 심화로 마진이 악화될 가능성",
    "규제/소송/정책 변수로 수요가 꺾일 가능성",
    "금리/환율/거시 변수로 밸류에이션이 압박받을 가능성",
    "내 근거가 단기 이벤트에 과도하게 의존했을 가능성",
  ];
  const m1 = s.metrics?.[0] || "지표1";
  const m2 = s.metrics?.[1] || "지표2";
  base.unshift(`${m1}이(가) 꺾이면서 가설이 약해질 가능성`);
  base.unshift(`${m2} 변화가 가설과 반대로 나타날 가능성`);
  return Array.from(new Set(base)).slice(0, 6);
}

function fillCounterSelect(options) {
  const sel = $("counterPick");
  if (!sel) return;
  sel.innerHTML = `<option value="">(리스크를 선택하세요)</option>`;
  for (const opt of options) {
    const o = document.createElement("option");
    o.value = opt;
    o.textContent = opt;
    sel.appendChild(o);
  }
}

// ---------- AI 점검 ----------
$("btnAI").onclick = async () => {
  if (!currentUid) return alert("먼저 로그인하세요.");
  if (!currentScenarioId) return alert("먼저 Draft 저장하세요.");

  $("aiResult").textContent = "AI 점검 중...";

  try {
    // ✅ 우선 로컬(간단) 반례 후보로 즉시 채워서 UX 빠르게
    const s = scenarioFromUI();
    fillCounterSelect(genCounterOptionsSimple(s));

    const res = await aiScenarioCheck({ scenarioId: currentScenarioId });
    const d = res.data || {};

    // ✅ (추가된 핵심) AI가 준 반례 5개가 있으면 그걸로 드롭다운 덮어쓰기
    if (Array.isArray(d.counterOptions) && d.counterOptions.length) {
      fillCounterSelect(d.counterOptions);
    }

    $("aiResult").innerHTML = `
      <div class="pill">cached: ${d.cached}</div>
      <div class="pill">score: ${d.score}</div>
      <div style="margin-top:8px;"><b>gaps</b>: ${(d.gaps || []).join(" / ")}</div>
      <div style="margin-top:6px;"><b>rewrite</b>: ${(d.rewrite || []).join(" / ")}</div>
      <div class="muted small" style="margin-top:10px;">
        ⓘ 리스크(반례)는 위 드롭다운에서 선택하세요(직접 작성 X)
      </div>
    `;

    setStatus("AI 점검 완료(리스크 선택 후 저장 권장)", true);
  } catch (e) {
    console.error(e);
    $("aiResult").textContent = "AI 점검 실패(콘솔 로그 확인)";
    setStatus("AI 점검 실패", false);
  }
};

// ---------- 게시 ----------
$("btnPublish").onclick = async () => {
  if (!currentUid) return alert("먼저 로그인하세요.");
  if (!currentScenarioId) return alert("먼저 Draft 저장하세요.");

  const snap = await getDoc(doc(db, "scenarios", currentScenarioId));
  if (!snap.exists()) return alert("시나리오 문서 없음");

  const s = snap.data();
  const errs = validatePublish(s);
  if (errs.length) return alert("게시 불가:\n- " + errs.join("\n- "));

  await updateDoc(doc(db, "scenarios", currentScenarioId), {
    status: "published",
    publishedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    hasGaps: Array.isArray(s.gaps) ? s.gaps.length > 0 : true,
  });

  setStatus("게시 완료", true);
};

// ---------- 종료 ----------
$("btnClose").onclick = async () => {
  if (!currentUid) return alert("먼저 로그인하세요.");
  if (!currentScenarioId) return alert("scenarioId 없음");

  await updateDoc(doc(db, "scenarios", currentScenarioId), {
    status: "closed",
    closedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  setStatus("종료 완료(Closed).", true);
};
