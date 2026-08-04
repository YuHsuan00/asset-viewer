// Vercel Cron Job — 每天自動執行一次，檢查有沒有「定期定額」規則今天該扣款
// 排程設定在根目錄的 vercel.json，由 Vercel 每天自動呼叫這支 API，不需要使用者開 App。
//
// ⚠️ 重要（2026/08 修正）：以前這支用 assets.price 當即時價換算「這筆錢該買到幾顆」，
// 但 assets.price 只有使用者「手動編輯資產」時才會更新，可能過期好幾個月。後果有兩種，都很嚴重：
//   1. price 是過期的 → 用錯的價格換算，買到的數量整個錯掉（定期定額的核心就是「用執行當下的市價換算」）
//   2. price 是 0 或 null → 下面的 `if (!fromUnitPrice || !toUnitPrice) continue;` 會直接跳過整條規則，
//      定期定額表面上開著、實際上永遠不會執行，而且不會有任何錯誤訊息
// 現在改成：先抓即時價 → 用即時價換算 → 順手把即時價寫回 assets.price。
//
// 需要在 Vercel 專案設定 → Environment Variables 加兩個變數（跟 index.html 裡用的是同一組）：
//   SUPABASE_URL      例：https://xxxxx.supabase.co
//   SUPABASE_ANON_KEY 例：eyJhbGci....

import { fetchLivePrices, valueOfAsset, unitPriceOf, getBaseUrl, writeBackPrices } from "./live-prices.js";

export default async function handler(req, res) {
  // trim() 防呆：跟 weekly-snapshot.js 一致，避免環境變數夾帶空白/換行或結尾斜線造成 404
  const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
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

    // ── 抓即時價：定期定額換算數量一定要用執行當下的市價，不能用資料庫的舊 price ──
    const baseUrl = getBaseUrl(req);
    let livePrices = {};
    try {
      livePrices = await fetchLivePrices(assetList, { baseUrl });
    } catch (e) {
      console.warn("即時價抓取失敗:", e.message);
    }

    // 用台灣時區(UTC+8)判斷「今天幾號」，避免 Vercel 伺服器 UTC 時間跟使用者認知的日期差一天
    const now = new Date();
    const tw = new Date(now.getTime() + 8 * 3600 * 1000);
    const todayStr = tw.toISOString().slice(0, 10); // YYYY-MM-DD
    const todayDay = tw.getUTCDate();

    let executed = 0;
    const skipped = []; // 記錄被跳過的規則跟原因，回傳出來方便排查「為什麼我的定期定額沒跑」
    for (const rule of rules) {
      const days = rule.days_of_month || [];
      if (!days.includes(todayDay)) continue;
      if (rule.last_run_date === todayStr) continue; // 快速跳過：明顯今天已經跑過的，省一次 API 呼叫

      const from = assetMap[rule.from_id];
      const to = assetMap[rule.to_id];
      if (!from || !to) { skipped.push({ id: rule.id, reason: "來源或目標資產已被刪除" }); continue; }

      // 固定投入金額（台幣），兩邊各自用「執行當下」的即時價換算成要扣/加多少數量。
      // 價格還是抓不到就不要去搶執行權，避免白白浪費這次機會，之後補執行時（Cron 隔天或使用者開 App）會再重試。
      const fromUnitPrice = unitPriceOf(from, livePrices);
      const toUnitPrice = unitPriceOf(to, livePrices);
      if (!fromUnitPrice || !toUnitPrice) {
        skipped.push({ id: rule.id, reason: `抓不到即時價（from=${fromUnitPrice}, to=${toUnitPrice}），這次不執行，下次會再重試` });
        continue;
      }

      // ── 原子性搶佔：用「條件式更新」讓資料庫自己保證同一天只有一個人搶得到執行權 ──
      // 條件是「last_run_date 還不是今天（或從沒執行過）」才准許更新成今天；
      // 搶輸的人（不管是 Cron 還是使用者開 App 補跑）會被 where 條件擋下，回傳空陣列，代表這次直接放棄不執行。
      // 這一步要在「真的去扣款」之前做，這樣就算扣款那步網路中斷失敗，最壞情況只是「這次沒扣到」，
      // 而不是「扣了但沒標記成功、下次又重複扣一次」。
      const claimUrl = `${SUPABASE_URL}/rest/v1/recurring_transfers?id=eq.${encodeURIComponent(rule.id)}&or=(last_run_date.is.null,last_run_date.neq.${todayStr})`;
      const claimRes = await fetch(claimUrl, {
        method: "PATCH",
        headers: { ...headers, Prefer: "return=representation" },
        body: JSON.stringify({ last_run_date: todayStr }),
      });
      if (!claimRes.ok) continue; // 搶佔請求本身失敗，跳過這條規則，不做任何資產異動
      const claimed = await claimRes.json();
      if (!Array.isArray(claimed) || claimed.length === 0) continue; // 搶輸了（已經被搶走），放棄這次執行

      const isWholeShare = (cat) => cat === "stock_tw" || cat === "stock_us";
      const amountTwd = Number(rule.amount_twd);
      // 先算目標那邊：股票只能整股（無條件捨去），現金/幣可以有小數
      let toDelta = amountTwd / toUnitPrice;
      if (isWholeShare(to.cat)) toDelta = Math.floor(toDelta);
      // 用「目標實際買到的價值」反推來源要扣多少，多的零頭不扣、留在來源帳戶
      const actualValue = toDelta * toUnitPrice;
      let fromDelta = actualValue / fromUnitPrice;
      if (isWholeShare(from.cat)) fromDelta = Math.floor(fromDelta);

      const fromIsCash = from.cat === "cash";
      const toIsCash = to.cat === "cash";
      const newFromVal = fromIsCash
        ? Math.max(0, Number(from.balance || 0) - fromDelta)
        : Math.max(0, +((Number(from.qty || 0) - fromDelta).toFixed(8)));
      const newToVal = toIsCash
        ? Number(to.balance || 0) + toDelta
        : +((Number(to.qty || 0) + toDelta).toFixed(8));

      const fromPatch = fromIsCash ? { balance: newFromVal } : { qty: newFromVal };
      const toPatch = toIsCash ? { balance: newToVal } : { qty: newToVal };

      await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/assets?id=eq.${encodeURIComponent(from.id)}`, { method: "PATCH", headers, body: JSON.stringify(fromPatch) }),
        fetch(`${SUPABASE_URL}/rest/v1/assets?id=eq.${encodeURIComponent(to.id)}`, { method: "PATCH", headers, body: JSON.stringify(toPatch) }),
      ]);

      // 同步更新記憶體中的資產值，供下面算淨值快照用
      Object.assign(from, fromPatch);
      Object.assign(to, toPatch);
      executed++;
    }

    if (executed > 0) {
      // 淨值也用即時價算（跟 weekly-snapshot.js 一致），順便補上分類明細讓分類走勢線也有資料點
      const CATS = ["cash", "crypto", "stock_tw", "stock_us"];
      const breakdown = {};
      CATS.forEach(cat => {
        breakdown[cat] = Object.values(assetMap).filter(a => a.cat === cat)
          .reduce((s, a) => s + valueOfAsset(a, livePrices), 0);
      });
      const netWorth = Object.values(breakdown).reduce((s, v) => s + v, 0);
      // 先試著連 breakdown 一起存，失敗（例如欄位還沒建）就退回只存總值，不讓整筆記錄消失
      const nwRes = await fetch(`${SUPABASE_URL}/rest/v1/net_worth_history`, {
        method: "POST", headers, body: JSON.stringify({ value: netWorth, breakdown }),
      });
      if (!nwRes.ok) {
        await fetch(`${SUPABASE_URL}/rest/v1/net_worth_history`, {
          method: "POST", headers, body: JSON.stringify({ value: netWorth }),
        }).catch(()=>{});
      }
    }

    // 順手把即時價寫回 assets.price，讓資料庫的價格不再長期過期
    const pricesWritten = await writeBackPrices(livePrices, { supabaseUrl: SUPABASE_URL, headers });

    return res.status(200).json({
      ok: true, checkedRules: rules.length, executed,
      livePriced: Object.keys(livePrices).length,
      pricesWrittenBack: pricesWritten,
      skipped: skipped.length ? skipped : undefined,
    });
  } catch (e) {
    return res.status(502).json({ error: "執行失敗", detail: e.message });
  }
}
