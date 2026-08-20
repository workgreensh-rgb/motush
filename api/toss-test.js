// 토스증권 Open API 연결 진단용 — 확인 후 삭제 예정
// motush.vercel.app/api/toss-test 로 접속하면 결과가 JSON으로 표시됩니다.
// Client Secret이나 토큰 값 자체는 절대 출력하지 않습니다.

const BASE = "https://openapi.tossinvest.com";

function cut(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n) + " …(생략)" : s;
}

export default async function handler(req, res) {
  const out = { env: {}, steps: [] };
  try {
    const id = process.env.TOSS_CLIENT_ID;
    const secret = process.env.TOSS_CLIENT_SECRET;
    out.env.TOSS_CLIENT_ID = id ? "등록됨 (" + id.slice(0, 10) + "…)" : "누락!";
    out.env.TOSS_CLIENT_SECRET = secret ? "등록됨" : "누락!";
    if (!id || !secret) {
      out.conclusion = "Vercel 환경변수에 TOSS_CLIENT_ID / TOSS_CLIENT_SECRET을 등록한 뒤 재배포가 필요합니다.";
      return res.status(200).json(out);
    }

    // 1) 토큰 발급
    let token = null;
    try {
      const r = await fetch(BASE + "/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: id,
          client_secret: secret
        })
      });
      const body = await r.text();
      let parsed = null;
      try { parsed = JSON.parse(body); } catch (e) {}
      token = parsed && (parsed.access_token || parsed.accessToken);
      out.steps.push({
        step: "토큰 발급 POST /oauth2/token",
        status: r.status,
        token_received: !!token,
        body_preview: token ? "(토큰 수신 성공 — 값은 표시하지 않음)" : cut(body, 600)
      });
    } catch (e) {
      out.steps.push({ step: "토큰 발급", error: String(e.message || e) });
    }

    if (!token) {
      out.conclusion = "토큰 발급 실패. status가 403이면 허용 IP 문제(0.0.0.0이 전체 허용으로 해석되지 않음), 401이면 키 값 오류 가능성이 큽니다.";
      return res.status(200).json(out);
    }

    // 2) 시세 계열 후보 엔드포인트 순회 (파라미터 규격 확인용)
    const candidates = [
      "/api/v1/stocks?symbols=005930",
      "/api/v1/stocks?symbol=005930",
      "/api/v1/stocks?codes=005930",
      "/api/v1/prices?symbols=005930",
      "/api/v1/prices?codes=005930",
      "/api/v1/prices?symbols=AAPL",
      "/api/v1/exchange-rate",
      "/api/v1/market-calendar/KR"
    ];
    for (const path of candidates) {
      try {
        const r = await fetch(BASE + path, {
          headers: { Authorization: "Bearer " + token }
        });
        const body = await r.text();
        out.steps.push({ step: "GET " + path, status: r.status, body_preview: cut(body, 700) });
      } catch (e) {
        out.steps.push({ step: "GET " + path, error: String(e.message || e) });
      }
    }

    out.conclusion = "위 결과 전체를 복사해서 채팅에 붙여넣어 주세요. status 200인 항목의 응답 구조를 보고 시세 연동 본편 코드를 확정합니다.";
    return res.status(200).json(out);
  } catch (e) {
    out.fatal = String(e.message || e);
    return res.status(200).json(out);
  }
}
