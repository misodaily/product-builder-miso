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

    // ✅ 캐시 (비용 절감): contentHash 같고 ai 결과 있으면 재호출 X
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

    const prompt = `
너는 투자 조언을 하지 않는 "논리 점검" 심사관이다.
아래 시나리오를 읽고 논리 품질을 평가하라.
반드시 JSON만 출력하고, 길이는 짧게 유지하라.

[시나리오]
ticker: ${ticker}
timeframe: ${timeframe}
thesis: ${thesis}
evidence1: ${e1}
evidence2: ${e2}
metrics: ${metrics.join(", ")}
sellRule: ${sellRule}
selectedCounter: ${counterPick}

출력 JSON 스키마:
{
  "score": number,                 // 0~100
  "gaps": string[3],               // 논리 구멍 3개
  "rewrite": string[3],            // 개선 3개
  "counterOptions": string[5]      // 선택형 반례 5개
}
`.trim();

    // ✅ 여기 이름도 SECRET로 변경
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
      gaps: Array.isArray(parsed.gaps) ? parsed.gaps.slice(0, 3) : [],
      rewrite: Array.isArray(parsed.rewrite) ? parsed.rewrite.slice(0, 3) : [],
      counterOptions: Array.isArray(parsed.counterOptions) ? parsed.counterOptions.slice(0, 5) : [],
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
