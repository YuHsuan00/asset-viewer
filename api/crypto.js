// Vercel Serverless Function — 加密貨幣台幣報價代理
// 主要來源 CoinGecko；缺漏時用 Yahoo Finance 的 SYMBOL-USD 報價，再乘 USD/TWD。
// 前端直連 CoinGecko 被限流或行動網路擋住時，可透過同網域 /api/crypto 備援。

const COINGECKO_IDS = {
  BTC:"bitcoin", ETH:"ethereum", USDT:"tether", USDC:"usd-coin",
  SOL:"solana", BNB:"binancecoin", XRP:"ripple", ADA:"cardano",
  DOGE:"dogecoin", TRX:"tron", DOT:"polkadot", MATIC:"matic-network",
  LINK:"chainlink", AVAX:"avalanche-2", SHIB:"shiba-inu", LTC:"litecoin",
  UNI:"uniswap", ATOM:"cosmos", XLM:"stellar", NEAR:"near",
  APT:"aptos", ARB:"arbitrum", OP:"optimism", PEPE:"pepe",
  SUI:"sui", TON:"the-open-network", BCH:"bitcoin-cash", XAUT:"tether-gold"
};

async function fetchWithTimeout(url, options={}, timeoutMs=6000) {
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try { return await fetch(url,{...options,signal:controller.signal}); }
  finally { clearTimeout(timer); }
}

async function usdTwd() {
  try {
    const r=await fetchWithTimeout("https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=twd");
    if (r.ok) {
      const d=await r.json();
      if (d?.tether?.twd) return Number(d.tether.twd);
    }
  } catch(e) {}
  return 32;
}

export default async function handler(req,res) {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET");
  const symbols=String(req.query.symbols||"").split(",").map(s=>s.trim().toUpperCase()).filter(Boolean);
  if (!symbols.length) return res.status(400).json({error:"缺少 symbols 參數"});

  const out={};
  const ids=[...new Set(symbols.map(s=>COINGECKO_IDS[s]||s.toLowerCase()))];
  try {
    const r=await fetchWithTimeout(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids.join(","))}&vs_currencies=twd`);
    if (r.ok) {
      const d=await r.json();
      symbols.forEach(sym=>{
        const price=d?.[COINGECKO_IDS[sym]||sym.toLowerCase()]?.twd;
        if (Number(price)>0) out[sym]=Number(price);
      });
    }
  } catch(e) {}

  const missing=symbols.filter(sym=>out[sym]===undefined);
  if (missing.length) {
    const rate=await usdTwd();
    // 兩檔一組，避免同一瞬間大量打 Yahoo 被判定異常流量。
    for (let i=0;i<missing.length;i+=2) {
      await Promise.all(missing.slice(i,i+2).map(async sym=>{
        try {
          const r=await fetchWithTimeout(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym+"-USD")}`,
            {headers:{"User-Agent":"Mozilla/5.0"}});
          if (!r.ok) return;
          const d=await r.json();
          const price=d?.chart?.result?.[0]?.meta?.regularMarketPrice;
          if (Number(price)>0) out[sym]=Number(price)*rate;
        } catch(e) {}
      }));
      if (i+2<missing.length) await new Promise(resolve=>setTimeout(resolve,90));
    }
  }

  if (!Object.keys(out).length) return res.status(502).json({error:"加密貨幣報價來源皆失敗"});
  res.setHeader("Cache-Control","s-maxage=30, stale-while-revalidate=60");
  return res.status(200).json(out);
}
