// Vercel Cron Job — 每週五台灣時間晚上 9 點自動執行一次，
// 把「當下每一個資產」的狀態各記一筆快照，存進 asset_snapshots 表。
// 這是打底工程：先開始累積資料，方便以後要做「單一資產的長期走勢」之類的功能時已經有歷史可用。
// 排程設定在根目錄的 vercel.json。
//
// 需要在 Vercel 專案設定 → Environment Variables 加兩個變數（跟其他 API 共用同一組）：
//   SUPABASE_URL      例：https://xxxxx.supabase.co
//   SUPABASE_ANON_KEY 例：eyJhbGci....

export default async function handler(req, res) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
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

    const assetsRes = await fetch(`${SUPABASE_URL}/rest/v1/assets?select=*`, { headers });
    if (!assetsRes.ok) throw new Error("讀取資產失敗 " + assetsRes.status);
    const assetList = await assetsRes.json();

    const rows = assetList.map(a => {
      const value = a.cat === "cash" ? Number(a.balance || 0) : Number(a.qty || 0) * Number(a.price || 0);
      return {
        asset_id: a.id, name: a.name, cat: a.cat,
        value, qty: a.qty ?? null, price: a.price ?? null,
        snapshot_date: todayStr,
      };
    });

    if (rows.length) {
      const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/asset_snapshots`, {
        method: "POST", headers, body: JSON.stringify(rows),
      });
      if (!insertRes.ok) throw new Error("寫入快照失敗 " + insertRes.status);
    }

    return res.status(200).json({ ok: true, recorded: rows.length, date: todayStr });
  } catch (e) {
    return res.status(502).json({ error: "執行失敗", detail: e.message });
  }
}
