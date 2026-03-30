// Prix réels depuis CoinGecko API (Demo key)
// Refresh toutes les 60 secondes (limite Demo: 30 appels/min, 10k/mois)

const COINGECKO_IDS = {
  "BTC/USDT":  "bitcoin",
  "ETH/USDT":  "ethereum",
  "SOL/USDT":  "solana",
  "BNB/USDT":  "binancecoin",
  "XRP/USDT":  "ripple",
  "AVAX/USDT": "avalanche-2",
};

// Cache des prix courants (valeurs initiales réalistes)
const priceCache = {
  "BTC/USDT":  67000,
  "ETH/USDT":  2000,
  "SOL/USDT":  130,
  "BNB/USDT":  580,
  "XRP/USDT":  0.55,
  "AVAX/USDT": 20,
};

const API_KEY           = process.env.COINGECKO_API_KEY;
const FETCH_INTERVAL_MS = 60000; // 60s — respecte la limite Demo
let lastFetch       = 0;
let fetchInProgress = false;

async function fetchPrices() {
  if (fetchInProgress) return;
  const now = Date.now();
  if (now - lastFetch < FETCH_INTERVAL_MS) return;

  fetchInProgress = true;
  try {
    const ids = Object.values(COINGECKO_IDS).join(",");
    const key = API_KEY ? `&x_cg_demo_api_key=${API_KEY}` : "";
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd${key}`;

    const res = await fetch(url, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    const data = await res.json();

    for (const [pair, id] of Object.entries(COINGECKO_IDS)) {
      if (data[id]?.usd) {
        priceCache[pair] = data[id].usd;
      }
    }

    lastFetch = Date.now();
    console.log(`📡 Prix mis à jour — BTC: $${priceCache["BTC/USDT"].toLocaleString()} | ETH: $${priceCache["ETH/USDT"].toLocaleString()}`);

  } catch (err) {
    console.warn(`⚠️  CoinGecko fetch échoué: ${err.message} — prix cache conservés`);
  } finally {
    fetchInProgress = false;
  }
}

function roundPrice(pair, value) {
  if (pair === "XRP/USDT") return Number(value.toFixed(5));
  if (value > 1000) return Number(value.toFixed(1));
  if (value > 1)    return Number(value.toFixed(3));
  return Number(value.toFixed(5));
}

// Retourne le prix actuel + micro-variation pour animer les bots
export function nextPrice(pair) {
  fetchPrices().catch(() => {});
  const base  = priceCache[pair] ?? 100;
  const noise = 1 + (Math.random() - 0.5) * 0.002; // ±0.1%
  return roundPrice(pair, base * noise);
}

// Fetch immédiat au démarrage
fetchPrices().catch(() => {});
