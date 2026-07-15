// Vercel Serverless Function — 美股即時價代理
// 主要來源：Yahoo Finance（免金鑰、沒有 Stooq 那種「每日配額很低」的已知限制，逐檔查但穩定）
// 備援來源：Stooq（Yahoo 查不到的才補查，減少對 Stooq 的請求量、降低撞到它每日配額上限的機會）
// 呼叫方式：/api/usstock?codes=AAPL,FLKR,TSLA
// 回傳格式：{ "AAPL": 150.5, "FLKR": 55.86, ... }

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  const codes = (req.query.codes || "").trim();
  if (!codes) {
    return res.status(400).json({ error: "缺少 codes 參數" });
  }

  const list = codes.split(",").map(c => c.trim().toUpperCase()).filter(Boolean);
  const out = {};

  // ── 來源 1：Yahoo Finance（每檔各自查，一檔失敗不影響其他檔） ──
  await Promise.all(list.map(async (sym) => {
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}`, {
        headers: { "User-Agent": "Mozilla/5.0" }, // Yahoo 會擋掉沒有瀏覽器 User-Agent 的請求
      });
      if (!r.ok) return;
      const d = await r.json();
      const price = d?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (typeof price === "number" && !isNaN(price)) out[sym] = price;
    } catch (e) { /* 這檔 Yahoo 查失敗，交給下面 Stooq 補 */ }
  }));

  // ── 來源 2：Stooq 補漏（只查 Yahoo 沒查到的，減少請求量） ──
  const missing = list.filter(s => out[s] === undefined);
  if (missing.length) {
    try {
      const symbolParam = missing.map(c => `${c.toLowerCase()}.us`).join(",");
      const url = `https://stooq.com/q/l/?s=${encodeURIComponent(symbolParam)}&f=sd2t2ohlcvn&h&e=csv`;
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (r.ok) {
        const text = await r.text();
        // CSV 格式：Symbol,Date,Time,Open,High,Low,Close,Volume,Name
        const lines = text.trim().split("\n");
        lines.slice(1).forEach(line => {
          const cols = line.split(",");
          const symbol = (cols[0] || "").replace(/\.us$/i, "").toUpperCase();
          const close = parseFloat(cols[6]);
          // 查無資料或撞到配額上限時 Stooq 會回 "N/D" 之類的值，parseFloat 會是 NaN，直接跳過
          if (symbol && !isNaN(close)) out[symbol] = close;
        });
      }
    } catch (e) { /* Stooq 也失敗，這幾檔就留空，前端會顯示抓取失敗但不影響其他已查到的 */ }
  }

  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
  return res.status(200).json(out);
}
