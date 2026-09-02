// 台股即時報價代理
// ⚠️ 2026/09 修正：mis.twse.com.tw 這個 API 有個社群普遍知道但沒寫在文件裡的特性——
// 直接打 getStockInfo.jsp 沒有先建立 session，資料常常抓不到（不是 HTTP 錯誤，是回傳空的
// msgArray，安靜地失敗）。正確做法是先打一次 index.jsp 拿 session cookie，再帶著這個 cookie
// 去查價格，才會穩定回資料。這是已知的、有社群案例佐證的修法，不是憑空猜的。
// 代價：多一次來回（通常 100-300ms），換來大幅降低「查不到」的機率，這個取捨值得。
async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getTwseSessionCookie() {
  try {
    const r = await fetchWithTimeout("https://mis.twse.com.tw/stock/index.jsp",
      { headers: { "User-Agent": "Mozilla/5.0" } }, 4000);
    // Node fetch（undici）在較新版本有 getSetCookie()，舊版本只能從 headers.get 拿到合併後的字串，兩種都試
    if (typeof r.headers.getSetCookie === "function") {
      const cookies = r.headers.getSetCookie();
      if (cookies.length) return cookies.map(c => c.split(";")[0]).join("; ");
    }
    const raw = r.headers.get("set-cookie");
    return raw ? raw.split(",").map(c => c.split(";")[0]).join("; ") : "";
  } catch (e) { return ""; } // 拿不到 session 就算了，退回原本「裸查」的行為，不會比以前更差
}

async function queryTwse(exCh, cookie) {
  const url = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=" + encodeURIComponent(exCh) + "&json=1&delay=0";
  const headers = { "Referer": "https://mis.twse.com.tw/stock/index.jsp", "User-Agent": "Mozilla/5.0" };
  if (cookie) headers["Cookie"] = cookie;
  const r = await fetchWithTimeout(url, { headers }, 5000);
  if (!r.ok) throw new Error("TWSE HTTP " + r.status);
  const data = await r.json();
  const out = {};
  (data.msgArray || []).forEach(item => {
    let price = parseFloat(item.z);
    if (isNaN(price) || item.z === "-") price = parseFloat(item.y);
    if (!isNaN(price)) out[item.c] = price;
  });
  return out;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  const codes = (req.query.codes || "").trim();
  if (!codes) return res.status(400).json({ error: "缺少 codes 參數" });
  const list = codes.split(",").map(c => c.trim()).filter(Boolean);
  const buildCh = (code) => (code.startsWith("6") ? "otc" : "tse") + "_" + code + ".tw";
  const exCh = list.map(buildCh).join("|");

  try {
    const cookie = await getTwseSessionCookie();
    let out = await queryTwse(exCh, cookie);
    // 拿到的檔數比要求的少：可能是那次 session 沒生效，重試一次（帶新的 session），
    // 只有真的不齊全才會多這一次來回，平常一次就齊全的情況完全不受影響、不會變慢
    if (Object.keys(out).length < list.length) {
      const cookie2 = await getTwseSessionCookie();
      const out2 = await queryTwse(exCh, cookie2);
      out = { ...out, ...out2 }; // 兩次的結果合併，能查到的就算數
    }
    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    return res.status(200).json(out);
  } catch (e) {
    return res.status(502).json({ error: "抓取失敗", detail: e.message });
  }
}
