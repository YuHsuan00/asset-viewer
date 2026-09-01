// 共用模組：在 serverless 端抓「即時價」，供 weekly-snapshot.js / run-recurring.js 使用。
//
// 為什麼需要這支：
// `assets` 表裡的 price 欄位只有在使用者「手動編輯資產」時才會被更新，
// 前端每次開 App 抓到的即時價只存在瀏覽器記憶體裡、不會寫回資料庫。
// 所以任何在伺服器端（Cron）跑的程式，如果直接拿 assets.price 當市價用，
// 拿到的會是一個可能過期好幾個月的數字——
//   - 週快照會寫進一條完全不動的假歷史線
//   - 定期定額會用錯的價格換算「這筆錢該買到幾顆」，甚至因為 price 是 0/null 直接整條規則跳過不執行
// 這支模組讓伺服器端也能拿到跟前端一樣的即時價，邏輯與 index.html 裡的抓價流程保持一致。
//
// 用法：
//   import { fetchLivePrices, valueOfAsset } from "./live-prices.js";
//   const prices = await fetchLivePrices(assetList, { baseUrl });  // { assetId: twdPrice }
//   const v = valueOfAsset(asset, prices);

// 幣種代號 → CoinGecko id（跟 index.html 裡的 COINGECKO_IDS 保持一致）
const COINGECKO_IDS = {
  BTC:"bitcoin", ETH:"ethereum", USDT:"tether", USDC:"usd-coin",
  SOL:"solana", BNB:"binancecoin", XRP:"ripple", ADA:"cardano",
  DOGE:"dogecoin", TRX:"tron", DOT:"polkadot", MATIC:"matic-network",
  LINK:"chainlink", AVAX:"avalanche-2", SHIB:"shiba-inu", LTC:"litecoin",
  UNI:"uniswap", ATOM:"cosmos", XLM:"stellar", NEAR:"near",
  APT:"aptos", ARB:"arbitrum", OP:"optimism", PEPE:"pepe",
  SUI:"sui", TON:"the-open-network", BCH:"bitcoin-cash",
  XAUT:"tether-gold", PAXG:"pax-gold"
};

const FALLBACK_USD_TWD = 32; // 匯率抓不到時的保底值

// 每個對外請求都設時間上限，避免對方不回應時把整支 Cron 卡到平台逾時被強制中斷
async function fetchWithTimeout(url, options = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// 借用 CoinGecko 的 USDT 報價當美元匯率代理（USDT 對美元 1:1 掛鉤），跟前端做法一致
export async function getUsdTwdRate() {
  try {
    const r = await fetchWithTimeout("https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=twd");
    if (r.ok) {
      const d = await r.json();
      if (d?.tether?.twd) return d.tether.twd;
    }
  } catch (e) { /* 用保底匯率 */ }
  return FALLBACK_USD_TWD;
}

// 加密貨幣：CoinGecko，先試直接回台幣，失敗再試「美元 × 匯率」
async function fetchCryptoPrices(cryptoAssets) {
  const out = {};
  if (!cryptoAssets.length) return out;

  const idMap = {}; // coingeckoId -> [asset, ...]
  cryptoAssets.forEach(a => {
    const id = COINGECKO_IDS[(a.symbol||"").toUpperCase()] || (a.symbol||"").toLowerCase();
    if (!id) return;
    if (!idMap[id]) idMap[id] = [];
    idMap[id].push(a);
  });
  const ids = Object.keys(idMap).join(",");
  if (!ids) return out;

  // 來源 1：直接要台幣報價
  try {
    const r = await fetchWithTimeout(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=twd`);
    if (r.ok) {
      const d = await r.json();
      Object.entries(idMap).forEach(([id, list]) => {
        if (d[id]?.twd) list.forEach(a => { out[a.id] = d[id].twd; });
      });
      if (Object.keys(out).length === Object.values(idMap).flat().length) return out;
    }
  } catch (e) { /* 換下一個來源 */ }

  // 來源 2：要美元報價再乘匯率（有時台幣報價被限流，美元可通）
  try {
    const [r, usdtwd] = await Promise.all([
      fetchWithTimeout(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=usd`),
      getUsdTwdRate(),
    ]);
    if (r.ok) {
      const d = await r.json();
      Object.entries(idMap).forEach(([id, list]) => {
        if (d[id]?.usd) list.forEach(a => { if (out[a.id] === undefined) out[a.id] = d[id].usd * usdtwd; });
      });
    }
  } catch (e) { /* 抓不到的就留空，呼叫端會 fallback 回 assets.price */ }

  return out;
}

// 台股：走自家 /api/twstock 代理（證交所擋跨域，且代理已處理上市/上櫃前綴判斷）
async function fetchTWStockPrices(stockAssets, baseUrl) {
  const out = {};
  if (!stockAssets.length || !baseUrl) return out;
  const codes = stockAssets.map(a => a.symbol).filter(Boolean).join(",");
  if (!codes) return out;
  try {
    const r = await fetchWithTimeout(`${baseUrl}/api/twstock?codes=${encodeURIComponent(codes)}`);
    if (!r.ok) return out;
    const data = await r.json(); // { "0050": 108.25, ... }（台幣）
    stockAssets.forEach(a => { if (data[a.symbol]) out[a.id] = data[a.symbol]; });
  } catch (e) { /* 抓不到就留空 */ }
  return out;
}

// 美股：走自家 /api/usstock 代理，拿到的是美元，統一換算成台幣（App 內部一律以台幣計價）
async function fetchUSStockPrices(stockAssets, baseUrl) {
  const out = {};
  if (!stockAssets.length || !baseUrl) return out;
  const codes = stockAssets.map(a => a.symbol).filter(Boolean).join(",");
  if (!codes) return out;
  try {
    const [r, usdtwd] = await Promise.all([
      fetchWithTimeout(`${baseUrl}/api/usstock?codes=${encodeURIComponent(codes)}`),
      getUsdTwdRate(),
    ]);
    if (!r.ok) return out;
    const data = await r.json(); // { "GOOG": 150.5, ... }（美元）
    stockAssets.forEach(a => { if (data[a.symbol]) out[a.id] = data[a.symbol] * usdtwd; });
  } catch (e) { /* 抓不到就留空 */ }
  return out;
}

// 主要進入點：回傳 { assetId: 台幣單價 }。抓不到的資產不會出現在回傳結果裡，
// 呼叫端要自行決定要 fallback 回 assets.price 還是跳過。
export async function fetchLivePrices(assetList, { baseUrl } = {}) {
  const crypto = assetList.filter(a => a.cat === "crypto");
  const twStock = assetList.filter(a => a.cat === "stock_tw");
  const usStock = assetList.filter(a => a.cat === "stock_us");

  // 三類同時抓，其中一類失敗不影響其他類
  const [c, tw, us] = await Promise.all([
    fetchCryptoPrices(crypto),
    fetchTWStockPrices(twStock, baseUrl),
    fetchUSStockPrices(usStock, baseUrl),
  ]);
  return { ...c, ...tw, ...us };
}

// 算單一資產的台幣市值：現金直接看 balance；其他用「即時價優先、抓不到才退回資料庫存的 price」
export function valueOfAsset(a, livePrices = {}) {
  if (a.cat === "cash") return Number(a.balance || 0);
  const unit = livePrices[a.id] ?? Number(a.price || 0);
  return Number(a.qty || 0) * Number(unit || 0);
}

// 算單一資產的台幣單價（同上，供定期定額換算數量用）
export function unitPriceOf(a, livePrices = {}) {
  if (a.cat === "cash") return 1;
  return Number(livePrices[a.id] ?? a.price ?? 0);
}

// 從 Vercel 的 request 推出自家網域的 base URL，供呼叫 /api/twstock、/api/usstock 用。
// 優先用平台自動注入的 VERCEL_URL，沒有的話再從請求標頭推斷（本機開發時用得到）。
export function getBaseUrl(req) {
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  const host = req?.headers?.host;
  if (!host) return null;
  const proto = req.headers["x-forwarded-proto"] || (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

// 把抓到的即時價寫回 assets.price，讓資料庫的價格不再長期過期。
// 這是「順手更新」性質，失敗不該影響主要流程，所以錯誤只記 log 不往外拋。
export async function writeBackPrices(livePrices, { supabaseUrl, headers }) {
  const entries = Object.entries(livePrices);
  if (!entries.length) return 0;
  let written = 0;
  await Promise.all(entries.map(async ([assetId, price]) => {
    try {
      const r = await fetch(`${supabaseUrl}/rest/v1/assets?id=eq.${encodeURIComponent(assetId)}`, {
        method: "PATCH", headers, body: JSON.stringify({ price }),
      });
      if (r.ok) written++;
    } catch (e) { /* 單筆失敗不影響其他筆 */ }
  }));
  return written;
}
