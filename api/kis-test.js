// 한국투자증권(KIS) Open API 연결 진단용 — 확인 후 삭제 예정
// motush.vercel.app/api/kis-test 로 접속하면 결과가 JSON으로 표시됩니다.
// APP Secret이나 토큰 값 자체는 절대 출력하지 않습니다.
// 주의: 한투 토큰 발급은 1분당 1회 제한 — 새로고침 연타 금지.

const BASE = "https://openapi.koreainvestment.com:9443";

function cut(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n) + " …(생략)" : s;
}

export default async function handler(req, res) {
  const out = { env: {}, steps: [] };
  try {
    const key = process.env.KIS_APP_KEY;
    const secret = process.env.KIS_APP_SECRET;
    out.env.KIS_APP_KEY = key ? "등록됨 (" + key.slice(0, 8) + "…)" : "누락!";
    out.env.KIS_APP_SECRET = secret ? "등록됨" : "누락!";
    if (!key || !secret) {
      out.conclusion = "Vercel 환경변수에 KIS_APP_KEY / KIS_APP_SECRET 등록 후 재배포가 필요합니다.";
      return res.status(200).json(out);
    }

    // 1) 토큰 발급 (1분당 1회 제한 주의)
    let token = null;
    try {
      const r = await fetch(BASE + "/oauth2/tokenP", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "client_credentials",
          appkey: key,
          appsecret: secret
        })
      });
      const body = await r.text();
      let parsed = null;
      try { parsed = JSON.parse(body); } catch (e) {}
      token = parsed && parsed.access_token;
      out.steps.push({
        step: "토큰 발급 POST /oauth2/tokenP",
        status: r.status,
        token_received: !!token,
        body_preview: token ? "(토큰 수신 성공 — 값은 표시하지 않음)" : cut(body, 500)
      });
    } catch (e) {
      out.steps.push({ step: "토큰 발급", error: String(e.message || e) });
    }

    if (!token) {
      out.conclusion = "토큰 발급 실패. body_preview의 메시지를 확인해 주세요. '1분당 1회' 관련 메시지면 60초 후 새로고침, 키 오류면 환경변수 값 확인이 필요합니다.";
      return res.status(200).json(out);
    }

    // 2) 국내주식 현재가 (삼성전자 005930)
    try {
      const url = BASE + "/uapi/domestic-stock/v1/quotations/inquire-price"
        + "?fid_cond_mrkt_div_code=J&fid_input_iscd=005930";
      const r = await fetch(url, {
        headers: {
          "Content-Type": "application/json",
          authorization: "Bearer " + token,
          appkey: key,
          appsecret: secret,
          tr_id: "FHKST01010100",
          custtype: "P"
        }
      });
      const body = await r.text();
      out.steps.push({ step: "국내 현재가 (삼성전자)", status: r.status, body_preview: cut(body, 700) });
    } catch (e) {
      out.steps.push({ step: "국내 현재가", error: String(e.message || e) });
    }

    // 3) 해외주식 현재가 (애플 AAPL, 나스닥)
    try {
      const url = BASE + "/uapi/overseas-price/v1/quotations/price"
        + "?AUTH=&EXCD=NAS&SYMB=AAPL";
      const r = await fetch(url, {
        headers: {
          "Content-Type": "application/json",
          authorization: "Bearer " + token,
          appkey: key,
          appsecret: secret,
          tr_id: "HHDFS00000300",
          custtype: "P"
        }
      });
      const body = await r.text();
      out.steps.push({ step: "해외 현재가 (애플)", status: r.status, body_preview: cut(body, 700) });
    } catch (e) {
      out.steps.push({ step: "해외 현재가", error: String(e.message || e) });
    }

    out.conclusion = "결과 전체를 복사해 채팅에 붙여넣어 주세요. 토큰 발급이 성공했다면 IP 제한 없이 Vercel에서 한투 호출이 가능하다는 뜻입니다.";
    return res.status(200).json(out);
  } catch (e) {
    out.fatal = String(e.message || e);
    return res.status(200).json(out);
  }
}
