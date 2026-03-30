// Prix réels depuis CoinGecko API (gratuit, pas de clé requise)
// Refresh toutes les 30 secondes pour éviter le rate limit

const COINGECKO_IDS = {
  "BTC/USDT":  "bitcoin",
  "ETH/USDT":  "ethereum",
  "SOL/USDT":  "solana",
  "BNB/USDT":  "binancecoin",
  "XRP/USDT":  "ripple",
  "AVAX/USDT": "avalanche-2",
};

const PAIRS = Object.keys(COINGECKO_IDS);

// Cache des prix courants
const priceCache = {
  "BTC/USDT":  67420,
  "ETH/USDT":  3510,
  "SOL/USDT":  178,
  "BNB/USDT":  598,
  "XRP/USDT":  0.618,
  "AVAX/USDT": 36.4,
};

let lastFetch = 0;
let fetchInProgress = false;
const FETCH_INTERVAL_MS = 30000; // 30s

async function fetchPrices() {
  if (fetchInProgress) return;
  const now = Date.now();
  if (now - lastFetch < FETCH_INTERVAL_MS) return;

  fetchInProgress = true;
  try {
    const ids = Object.values(COINGECKO_IDS).join(",");
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`;

    const res = await fetch(url, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    const data = await res.json();

    for (const [pair, id] of Object.entries(COINGECKO_IDS)) {
      if (data[id]?.usd) {
        priceCache[pair] = data[id].usd;
      }
    }

    lastFetch = Date.now();
    console.log(`📡 Prix mis à jour — BTC: $${priceCache["BTC/USDT"].toLocaleString()}`);

  } catch (err) {
    console.warn(`⚠️ CoinGecko fetch échoué: ${err.message} — prix cache conservés`);
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

// Retourne le prix actuel (avec légère variation simulée pour les bots)
export function nextPrice(pair) {
  // Fetch en arrière-plan si besoin
  fetchPrices().catch(() => {});

  const base = priceCache[pair] ?? 100;

  // Petite variation aléatoire ±0.15% pour simuler le tick
  // (les vrais prix se rafraîchissent toutes les 30s)
  const noise = 1 + (Math.random() - 0.5) * 0.003;
  const price = base * noise;

  return roundPrice(pair, price);
}

// Fetch immédiat au démarrage
fetchPrices().catch(() => {});
