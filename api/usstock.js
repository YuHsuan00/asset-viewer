// Vercel Serverless Function — 美股即時價代理
// 主要來源：Yahoo Finance（免金鑰，逐檔查）
// 備援來源：Stooq（Yahoo 查不到的才補查，減少對 Stooq 的請求量）
// 呼叫方式：/api/usstock?codes=AAPL,FLKR,TSLA
// 回傳格式：{ "AAPL": 150.5, "FLKR": 55.86, ... }
//
// 重點：每個對外請求都設有時間上限（AbortController），避免對方（Yahoo/Stooq）
// 不回應或拖著不回時，這支程式被卡住等到 Vercel 平台自己的執行逾時、被強制中斷回傳 502。
// 有這層保險後，最壞情況也只是「這個來源沒查到」，不會讓整支程式掛掉。
//
// ⚠️ 2026/09 補充：以前是 Promise.all 讓所有股票的 Yahoo 請求「同一瞬間」一起發出去，
// 持股檔數變多之後（例如新增第 4、5 檔），這種瞬間爆量的請求模式比總量本身更容易被 Yahoo
// 判定成異常流量、擋掉其中幾檔——不是「檔數太多」的問題，是「太多檔同時間一起打」的問題。
// 一開始改成「每檔錯開 120ms 依序發」，能解決爆量問題，但檔數一多、使用者會感覺明顯變慢
// （例如 4 檔，最後一檔要等 360ms 才發得出去，加上它自己的來回時間）。
// 改成「兩檔一組，組跟組之間錯開」：尖峰同時間最多 2 檔在跑（還是比原本 4-5 檔同時衝出去安全很多），
// 但總延遲大約只有全部依序發的一半，兼顧「不要被擋」跟「不要太慢」。

const BATCH_SIZE = 2;       // 同一時間最多幾檔一起發
const BATCH_STAGGER_MS = 90; // 這一組跟下一組之間錯開多久才發

async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  const codes = (req.query.codes || "").trim();
  if (!codes) {
    return res.status(400).json({ error: "缺少 codes 參數" });
  }

  const list = codes.split(",").map(c => c.trim().toUpperCase()).filter(Boolean);
  const out = {};

  // ── 來源 1：Yahoo Finance（兩檔一組發送，組跟組之間錯開一點時間，同組內一檔失敗不影響其他檔） ──
  const fetchOne = async (sym) => {
    try {
      const r = await fetchWithTimeout(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}`,
        { headers: { "User-Agent": "Mozilla/5.0" } }, // Yahoo 會擋掉沒有瀏覽器 User-Agent 的請求
        5000
      );
      if (!r.ok) return;
      const d = await r.json();
      const price = d?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (typeof price === "number" && !isNaN(price)) out[sym] = price;
    } catch (e) { /* 逾時或失敗：這檔交給下面 Stooq 補 */ }
  };
  for (let i = 0; i < list.length; i += BATCH_SIZE) {
    if (i > 0) await sleep(BATCH_STAGGER_MS);
    await Promise.all(list.slice(i, i+BATCH_SIZE).map(fetchOne));
  }

  // ── 來源 2：Stooq 補漏（只查 Yahoo 沒查到的，減少請求量） ──
  const missing = list.filter(s => out[s] === undefined);
  if (missing.length) {
    try {
      const symbolParam = missing.map(c => `${c.toLowerCase()}.us`).join(",");
      const url = `https://stooq.com/q/l/?s=${encodeURIComponent(symbolParam)}&f=sd2t2ohlcvn&h&e=csv`;
      const r = await fetchWithTimeout(url, { headers: { "User-Agent": "Mozilla/5.0" } }, 5000);
      if (r.ok) {
        const text = await r.text();
        // CSV 格式：Symbol,Date,Time,Open,High,Low,Close,Volume,Name
        const lines = text.trim().split("\n");
        lines.slice(1).forEach(line => {
          const cols = line.split(",");
          const symbol = (cols[0] || "").replace(/\.us$/i, "").toUpperCase();
          const close = parseFloat(cols[6]);
          if (symbol && !isNaN(close)) out[symbol] = close;
        });
      }
    } catch (e) { /* Stooq 也逾時或失敗，這幾檔就留空 */ }
  }

  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
  return res.status(200).json(out);
}
