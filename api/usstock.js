// Vercel Serverless Function — 美股即時價代理（來源：Stooq，免金鑰）
// 前端無法直接抓 Stooq（穩妥起見統一走後端代理，也方便未來換來源），
// 呼叫方式：/api/usstock?codes=AAPL,FLKR,TSLA
// 回傳格式：{ "AAPL": 150.5, "FLKR": 55.86, ... }

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  const codes = (req.query.codes || "").trim();
  if (!codes) {
    return res.status(400).json({ error: "缺少 codes 參數" });
  }

  const list = codes.split(",").map(c => c.trim()).filter(Boolean);
  // Stooq 美股代號要加 .us 後綴，例如 AAPL → aapl.us
  const symbolParam = list.map(c => `${c.toLowerCase()}.us`).join(",");
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(symbolParam)}&f=sd2t2ohlcvn&h&e=csv`;

  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) throw new Error("Stooq HTTP " + r.status);
    const text = await r.text();

    // CSV 格式：Symbol,Date,Time,Open,High,Low,Close,Volume,Name
    const lines = text.trim().split("\n");
    const out = {};
    lines.slice(1).forEach(line => {
      const cols = line.split(",");
      const symbol = (cols[0] || "").replace(/\.us$/i, "").toUpperCase();
      const close = parseFloat(cols[6]);
      // 查無資料時 Stooq 會回 "N/D"，parseFloat 會是 NaN，直接跳過不放進結果
      if (symbol && !isNaN(close)) out[symbol] = close;
    });

    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    return res.status(200).json(out);
  } catch (e) {
    return res.status(502).json({ error: "抓取失敗", detail: e.message });
  }
}
