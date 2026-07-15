// Vercel Cron Job — 每天自動執行一次，檢查有沒有「定期定額」規則今天該扣款
// 排程設定在根目錄的 vercel.json，由 Vercel 每天自動呼叫這支 API，不需要使用者開 App。
//
// 需要在 Vercel 專案設定 → Environment Variables 加兩個變數（跟 index.html 裡用的是同一組）：
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
    const [rulesRes, assetsRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/recurring_transfers?active=eq.true&select=*`, { headers }),
      fetch(`${SUPABASE_URL}/rest/v1/assets?select=*`, { headers }),
    ]);
    if (!rulesRes.ok) throw new Error("讀取規則失敗 " + rulesRes.status);
    if (!assetsRes.ok) throw new Error("讀取資產失敗 " + assetsRes.status);

    const rules = await rulesRes.json();
    const assetList = await assetsRes.json();
    const assetMap = {};
    assetList.forEach(a => { assetMap[a.id] = a; });

    // 用台灣時區(UTC+8)判斷「今天幾號」，避免 Vercel 伺服器 UTC 時間跟使用者認知的日期差一天
    const now = new Date();
    const tw = new Date(now.getTime() + 8 * 3600 * 1000);
    const todayStr = tw.toISOString().slice(0, 10); // YYYY-MM-DD
    const todayDay = tw.getUTCDate();

    let executed = 0;
    for (const rule of rules) {
      const days = rule.days_of_month || [];
      if (!days.includes(todayDay)) continue;
      if (rule.last_run_date === todayStr) continue; // 今天已經執行過，避免重複扣款

      const from = assetMap[rule.from_id];
      const to = assetMap[rule.to_id];
      if (!from || !to) continue; // 來源或目標資產已被刪除，規則失效跳過

      const fromIsCash = from.cat === "cash";
      const toIsCash = to.cat === "cash";
      const newFromVal = fromIsCash
        ? Math.max(0, Number(from.balance || 0) - Number(rule.from_amount))
        : Math.max(0, +((Number(from.qty || 0) - Number(rule.from_amount)).toFixed(8)));
      const newToVal = toIsCash
        ? Number(to.balance || 0) + Number(rule.to_amount)
        : +((Number(to.qty || 0) + Number(rule.to_amount)).toFixed(8));

      const fromPatch = fromIsCash ? { balance: newFromVal } : { qty: newFromVal };
      const toPatch = toIsCash ? { balance: newToVal } : { qty: newToVal };

      await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/assets?id=eq.${encodeURIComponent(from.id)}`, { method: "PATCH", headers, body: JSON.stringify(fromPatch) }),
        fetch(`${SUPABASE_URL}/rest/v1/assets?id=eq.${encodeURIComponent(to.id)}`, { method: "PATCH", headers, body: JSON.stringify(toPatch) }),
      ]);
      await fetch(`${SUPABASE_URL}/rest/v1/recurring_transfers?id=eq.${encodeURIComponent(rule.id)}`, {
        method: "PATCH", headers, body: JSON.stringify({ last_run_date: todayStr }),
      });

      // 同步更新記憶體中的資產值，供下面算淨值快照用
      Object.assign(from, fromPatch);
      Object.assign(to, toPatch);
      executed++;
    }

    if (executed > 0) {
      const netWorth = Object.values(assetMap).reduce((s, a) => {
        const v = a.cat === "cash" ? Number(a.balance || 0) : Number(a.qty || 0) * Number(a.price || 0);
        return s + v;
      }, 0);
      await fetch(`${SUPABASE_URL}/rest/v1/net_worth_history`, {
        method: "POST", headers, body: JSON.stringify({ value: netWorth }),
      });
    }

    return res.status(200).json({ ok: true, checkedRules: rules.length, executed });
  } catch (e) {
    return res.status(502).json({ error: "執行失敗", detail: e.message });
  }
}
