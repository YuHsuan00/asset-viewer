export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  const codes = (req.query.codes || "").trim();
  if (!codes) return res.status(400).json({ error: "缺少 codes 參數" });
  const list = codes.split(",").map(c => c.trim()).filter(Boolean);
  const buildCh = (code) => (code.startsWith("6") ? "otc" : "tse") + "_" + code + ".tw";
  const exCh = list.map(buildCh).join("|");
  const url = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=" + encodeURIComponent(exCh) + "&json=1&delay=0";
  try {
    const r = await fetch(url, { headers: { "Referer": "https://mis.twse.com.tw/stock/index.jsp", "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) throw new Error("TWSE HTTP " + r.status);
    const data = await r.json();
    const out = {};
    (data.msgArray || []).forEach(item => {
      let price = parseFloat(item.z);
      if (isNaN(price) || item.z === "-") price = parseFloat(item.y);
      if (!isNaN(price)) out[item.c] = price;
    });
    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    return res.status(200).json(out);
  } catch (e) {
    return res.status(502).json({ error: "抓取失敗", detail: e.message });
  }
}
