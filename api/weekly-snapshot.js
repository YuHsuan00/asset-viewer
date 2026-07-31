// Vercel Cron Job — 每週五台灣時間晚上 9 點自動執行一次：
// 1. 把「當下每一個資產」的狀態各記一筆快照，存進 asset_snapshots 表（供單一資產走勢用）
// 2. 順便也補記一筆帶「分類明細」的淨值快照到 net_worth_history（供大分類走勢用）——
//    分類明細平常是使用者手動調整資產時才會記錄（事件觸發），如果使用者這幾天很少動手調整，
//    分類線就會一直卡在很少的資料點。這裡讓它額外搭一班「排程觸發」的順風車，
//    至少每週都會穩定多一個點，不會完全被使用頻率綁死。
// 排程設定在根目錄的 vercel.json。
//
// 需要在 Vercel 專案設定 → Environment Variables 加兩個變數（跟其他 API 共用同一組）：
//   SUPABASE_URL      例：https://xxxxx.supabase.co
//   SUPABASE_ANON_KEY 例：eyJhbGci....

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

    const valueOf = a => a.cat === "cash" ? Number(a.balance || 0) : Number(a.qty || 0) * Number(a.price || 0);

    const rows = assetList.map(a => ({
      asset_id: a.id, name: a.name, cat: a.cat,
      value: valueOf(a), qty: a.qty ?? null, price: a.price ?? null,
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
      breakdown[cat] = assetList.filter(a => a.cat === cat).reduce((s,a) => s + valueOf(a), 0);
    });
    const totalValue = Object.values(breakdown).reduce((s,v) => s+v, 0);
    const nwRes = await fetch(`${SUPABASE_URL}/rest/v1/net_worth_history`, {
      method: "POST", headers, body: JSON.stringify({ value: totalValue, breakdown }),
    });
    if (!nwRes.ok) console.warn("補記分類明細快照失敗（不影響資產快照本身）:", nwRes.status);

    return res.status(200).json({ ok: true, recorded: rows.length, date: todayStr });
  } catch (e) {
    return res.status(502).json({ error: "執行失敗", detail: e.message });
  }
}
