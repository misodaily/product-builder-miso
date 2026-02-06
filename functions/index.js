/* functions/index.js (CommonJS) */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");

setGlobalOptions({ region: "asia-northeast3" });

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

exports.aiScenarioCheck = onCall({ secrets: ["OPENAI_API_KEY_SECRET"] }, async (req) => {
  try {
    if (!req.auth) throw new HttpsError("unauthenticated", "로그인이 필요합니다.");

    const { scenarioId } = req.data || {};
    if (!scenarioId) throw new HttpsError("invalid-argument", "scenarioId가 필요합니다.");

    const ref = db.doc(`scenarios/${scenarioId}`);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("not-found", "시나리오가 없습니다.");

    const s = snap.data();
    if (s.uid !== req.auth.uid) throw new HttpsError("permission-denied", "권한이 없습니다.");

    // ✅ 캐시(비용 절감)
    const hash = s.contentHash || "";
    const cached = !!(s.ai && s.ai.contentHash === hash && s.ai.score != null);
    if (cached) return { ...s.ai, cached: true };

    const ticker = s.ticker || "";
    const timeframe = s.timeframe || "";
    const thesis = s.thesis || "";
    const e1 = s.evidence1Text || "";
    const e2 = s.evidence2Text || "";
    const sellRule = s.exitRule || "";
    const metrics = Array.isArray(s.metrics) ? s.metrics : [];
    const counterPick = s.counterPick || "";

    // ✅ “검증”이 아니라 “보조(코치)” 톤으로
    const prompt = `
너는 투자 조언을 하지 않는 "투자 보조 코치"다.
사용자의 가설을 평가하되, 검증을 강요하지 말고 "다음에 확인할 것" 중심으로 안내해라.
반드시 JSON만 출력하고, 문장은 짧고 친절하게.

[시나리오]
ticker: ${ticker}
timeframe: ${timeframe}
thesis: ${thesis}
evidence1: ${e1}
evidence2: ${e2}
metrics: ${metrics.join(", ")}
sellRule: ${sellRule}
selectedCounter: ${counterPick}

출력 JSON 스키마(정확히 이 키들만):
{
  "score": number,                 // 0~100, 완성도(낙제 뉘앙스 금지)
  "coachComment": string,          // 1~2문장. 요약+다음 행동 안내
  "checkMetrics": string[3],       // 추가로 확인할 지표 3개(짧게)
  "watchIssues": string[2],        // 주의 이슈 2개(짧게)
  "counterOptions": string[5],     // 선택형 반례 5개(짧게)
  "gaps": string[3],               // (심화) 논리 구멍 3개
  "rewrite": string[3]             // (심화) 개선 3개
}
`.trim();

    const apiKey = process.env.OPENAI_API_KEY_SECRET;
    if (!apiKey) throw new HttpsError("failed-precondition", "OPENAI_API_KEY_SECRET이 설정되지 않았습니다.");

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        messages: [
          { role: "system", content: "Output ONLY valid JSON. No markdown, no extra text." },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
      }),
    });

    if (!r.ok) {
      const text = await r.text();
      throw new HttpsError("internal", `OpenAI error: ${r.status} ${text.slice(0, 300)}`);
    }

    const data = await r.json();
    const content = data.choices?.[0]?.message?.content || "{}";

    let parsed;
    try { parsed = JSON.parse(content); }
    catch { throw new HttpsError("internal", "AI 응답 JSON 파싱 실패"); }

    const result = {
      contentHash: hash,
      score: Number(parsed.score ?? 50),
      coachComment: String(parsed.coachComment ?? "").slice(0, 220),
      checkMetrics: Array.isArray(parsed.checkMetrics) ? parsed.checkMetrics.slice(0, 3) : [],
      watchIssues: Array.isArray(parsed.watchIssues) ? parsed.watchIssues.slice(0, 2) : [],
      counterOptions: Array.isArray(parsed.counterOptions) ? parsed.counterOptions.slice(0, 5) : [],
      gaps: Array.isArray(parsed.gaps) ? parsed.gaps.slice(0, 3) : [],
      rewrite: Array.isArray(parsed.rewrite) ? parsed.rewrite.slice(0, 3) : [],
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await ref.set({ ai: result }, { merge: true });
    return { ...result, cached: false };
  } catch (e) {
    console.error(e);
    if (e instanceof HttpsError) throw e;
    throw new HttpsError("internal", "AI 점검 중 오류가 발생했습니다.");
  }
});
