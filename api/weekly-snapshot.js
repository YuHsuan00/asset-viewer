// Vercel Cron Job — 每週五台灣時間晚上 9 點自動執行一次：
// 1. 把「當下每一個資產」的狀態各記一筆快照，存進 asset_snapshots 表（供單一資產走勢用）
// 2. 順便也補記一筆帶「分類明細」的淨值快照到 net_worth_history（供大分類走勢用）——
//    分類明細平常是使用者手動調整資產時才會記錄（事件觸發），如果使用者這幾天很少動手調整，
//    分類線就會一直卡在很少的資料點。這裡讓它額外搭一班「排程觸發」的順風車，
//    至少每週都會穩定多一個點，不會完全被使用頻率綁死。
// 排程設定在根目錄的 vercel.json。
//
// ⚠️ 重要（2026/08 修正）：以前這支直接拿 assets.price 當市價算 value，
// 但 assets.price 只有使用者「手動編輯資產」時才會更新——前端每次開 App 抓到的即時價
// 只存在瀏覽器記憶體、不會寫回資料庫。結果就是快照寫進去的是一個過期好幾個月的價格，
// 圖表上個別資產（比特幣、0050、GOOG…）的走勢線會完全不動，看起來像壞掉。
// 現在改成：先抓即時價 → 用即時價算 value → 順手把即時價寫回 assets.price。
//
// 需要在 Vercel 專案設定 → Environment Variables 加兩個變數（跟其他 API 共用同一組）：
//   SUPABASE_URL      例：https://xxxxx.supabase.co
//   SUPABASE_ANON_KEY 例：eyJhbGci....

import { fetchLivePrices, valueOfAsset, getBaseUrl, writeBackPrices } from "./live-prices.js";

export default async function handler(req, res) {
  // trim() 防呆：環境變數複製貼上很容易不小心夾帶結尾換行或空白字元，
  // 直接接在網址後面會讓路徑變得不對、回傳 404——這裡先自動去除，多一層保險
  const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, ""); // 順便去掉結尾多餘的斜線
  const SUPABASE_ANON_KEY = (process.env.SUPABASE_ANON_KEY || "").trim();
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return res.status(500).json({ error: "缺少環境變數 SUPABASE_URL / SUPABASE_ANON_KEY" });
  }

  const headers = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    "Content-Type": "application/json",
  };

  try {
    // 用台灣時區(UTC+8)判斷「這週的週五日期」，當作這批快照的識別用日期，避免重複執行時重複記錄
    const now = new Date();
    const tw = new Date(now.getTime() + 8 * 3600 * 1000);
    const todayStr = tw.toISOString().slice(0, 10); // YYYY-MM-DD

    // 先檢查這個日期是否已經記錄過（避免 Cron 意外觸發兩次造成重複快照）
    const checkRes = await fetch(
      `${SUPABASE_URL}/rest/v1/asset_snapshots?snapshot_date=eq.${todayStr}&select=id&limit=1`,
      { headers }
    );
    if (checkRes.ok) {
      const existing = await checkRes.json();
      if (Array.isArray(existing) && existing.length > 0) {
        return res.status(200).json({ ok: true, skipped: true, reason: "今天已經記錄過" });
      }
    }

    const assetsUrl = `${SUPABASE_URL}/rest/v1/assets?select=*`;
    const assetsRes = await fetch(assetsUrl, { headers });
    if (!assetsRes.ok) {
      // 診斷用：把實際打的網址（開頭部分，網址本身不是密鑰不用遮）跟 Supabase 回傳的錯誤內容都帶出來，
      // 不用再用猜的——404 幾乎都是 SUPABASE_URL 這個環境變數本身有問題（打錯、多斜線、多空白等）
      const bodyText = await assetsRes.text().catch(()=>"(無法讀取回應內容)");
      throw new Error(`讀取資產失敗 ${assetsRes.status}｜實際呼叫網址: ${assetsUrl}｜Supabase 回應: ${bodyText.slice(0,300)}`);
    }
    const assetList = await assetsRes.json();

    // ── 抓即時價（這是這支程式正確性的關鍵，不能省） ──
    // 抓不到的資產，valueOfAsset() 會自動退回用 assets.price，不會整批失敗。
    const baseUrl = getBaseUrl(req);
    let livePrices = {};
    try {
      livePrices = await fetchLivePrices(assetList, { baseUrl });
    } catch (e) {
      console.warn("即時價抓取失敗，這次快照改用資料庫既有價格:", e.message);
    }
    // 有幾筆是真的用到即時價的，回傳結果裡帶出來，方便之後排查
    const pricedCount = Object.keys(livePrices).length;

    const rows = assetList.map(a => ({
      asset_id: a.id, name: a.name, cat: a.cat,
      value: valueOfAsset(a, livePrices),
      qty: a.qty ?? null,
      // price 也存即時價（抓不到才退回原本的），這樣歷史快照自己就能還原當時的單價
      price: a.cat === "cash" ? null : (livePrices[a.id] ?? a.price ?? null),
      snapshot_date: todayStr,
    }));

    if (rows.length) {
      const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/asset_snapshots`, {
        method: "POST", headers, body: JSON.stringify(rows),
      });
      if (!insertRes.ok) throw new Error("寫入快照失敗 " + insertRes.status);
    }

    // 額外補一筆帶分類明細的淨值快照（跟 App 裡 saveNetWorthSnapshot() 存的格式一致）
    const CATS = ["cash", "crypto", "stock_tw", "stock_us"];
    const breakdown = {};
    CATS.forEach(cat => {
      breakdown[cat] = assetList.filter(a => a.cat === cat).reduce((s,a) => s + valueOfAsset(a, livePrices), 0);
    });
    const totalValue = Object.values(breakdown).reduce((s,v) => s+v, 0);
    const nwRes = await fetch(`${SUPABASE_URL}/rest/v1/net_worth_history`, {
      method: "POST", headers, body: JSON.stringify({ value: totalValue, breakdown }),
    });
    if (!nwRes.ok) console.warn("補記分類明細快照失敗（不影響資產快照本身）:", nwRes.status);

    // 順手把即時價寫回 assets.price，讓資料庫的價格不再長期過期（失敗不影響上面已完成的快照）
    const pricesWritten = await writeBackPrices(livePrices, { supabaseUrl: SUPABASE_URL, headers });

    return res.status(200).json({
      ok: true, recorded: rows.length, date: todayStr,
      livePriced: pricedCount, pricesWrittenBack: pricesWritten,
    });
  } catch (e) {
    return res.status(502).json({ error: "執行失敗", detail: e.message });
  }
}
