import { supabase } from "./supabase.js";
import { nextPrice } from "./price-feed.js";
import { runTick } from "./strategies.js";
import crypto from "crypto";

const TICK_MS = 5000;
const PAIRS = ["BTC/USDT", "ETH/USDT", "SOL/USDT", "BNB/USDT", "XRP/USDT", "AVAX/USDT"];

// ── Binance Testnet config ─────────────────────
const TESTNET_BASE    = "https://testnet.binance.vision";
const TESTNET_API_KEY = process.env.BINANCE_TESTNET_API_KEY;
const TESTNET_SECRET  = process.env.BINANCE_TESTNET_SECRET;
const TESTNET_ENABLED = !!(TESTNET_API_KEY && TESTNET_SECRET);

if (TESTNET_ENABLED) {
  console.log("🔗 Binance Testnet connecté !");
} else {
  console.log("⚠️  Binance Testnet désactivé — mode simulation");
}

function toSymbol(pair) { return pair.replace("/", ""); }

function sign(queryString) {
  return crypto.createHmac("sha256", TESTNET_SECRET).update(queryString).digest("hex");
}

// ── Binance Testnet API ────────────────────────

async function getTestnetBalance() {
  if (!TESTNET_ENABLED) return null;
  try {
    const ts = Date.now();
    const qs = `timestamp=${ts}`;
    const res = await fetch(`${TESTNET_BASE}/api/v3/account?${qs}&signature=${sign(qs)}`, {
      headers: { "X-MBX-APIKEY": TESTNET_API_KEY },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const balances = {};
    (data.balances || []).forEach(b => {
      if (parseFloat(b.free) > 0 || parseFloat(b.locked) > 0) {
        balances[b.asset] = { free: parseFloat(b.free), locked: parseFloat(b.locked) };
      }
    });
    return balances;
  } catch (e) {
    console.warn(`⚠️  Balance error: ${e.message}`);
    return null;
  }
}

async function placeTestnetOrder(symbol, side, quantity) {
  if (!TESTNET_ENABLED) return null;
  try {
    const ts = Date.now();
    const qs = `symbol=${symbol}&side=${side}&type=MARKET&quantity=${quantity}&timestamp=${ts}`;
    const res = await fetch(`${TESTNET_BASE}/api/v3/order`, {
      method: "POST",
      headers: { "X-MBX-APIKEY": TESTNET_API_KEY, "Content-Type": "application/x-www-form-urlencoded" },
      body: `${qs}&signature=${sign(qs)}`,
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.msg || `HTTP ${res.status}`);
    const fillPrice = data.fills?.[0]?.price || "MARKET";
    console.log(`📋 Testnet: ${side} ${quantity} ${symbol} @ ${fillPrice} — #${data.orderId}`);
    return data;
  } catch (e) {
    console.warn(`⚠️  Order error: ${e.message}`);
    return null;
  }
}

async function getTestnetPrice(symbol) {
  if (!TESTNET_ENABLED) return null;
  try {
    const res = await fetch(`${TESTNET_BASE}/api/v3/ticker/price?symbol=${symbol}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return parseFloat(data.price);
  } catch { return null; }
}

// Quantités minimales par paire
const MIN_QTY = { "BTC/USDT":0.0001,"ETH/USDT":0.001,"SOL/USDT":0.01,"BNB/USDT":0.01,"XRP/USDT":1,"AVAX/USDT":0.1 };
const QTY_DEC = { "BTC/USDT":4,"ETH/USDT":3,"SOL/USDT":2,"BNB/USDT":2,"XRP/USDT":0,"AVAX/USDT":1 };

function calcQty(pair, budget, price) {
  const min = MIN_QTY[pair] || 0.01;
  const dec = QTY_DEC[pair] || 2;
  const raw = Math.max(min, (budget / price) * 0.95);
  return parseFloat(raw.toFixed(dec));
}

// ── Supabase helpers ───────────────────────────

async function loadBots() {
  const { data, error } = await supabase.from("bots").select("*").eq("running", true);
  if (error) throw error;
  return data || [];
}

async function loadState(botId) {
  const { data, error } = await supabase.from("bot_states").select("*").eq("bot_id", botId).maybeSingle();
  if (error && error.code !== "PGRST116") throw error;
  return data || { bot_id: botId, pnl: 0, trades: 0, log: [], runtime: {} };
}

async function saveState(botId, state) {
  const { error } = await supabase.from("bot_states").upsert({
    bot_id: botId, pnl: Number(state.pnl||0), trades: Number(state.trades||0),
    log: state.log||[], runtime: state.runtime||{},
  }, { onConflict: "bot_id" });
  if (error) throw error;
}

async function updateWallet(userId, delta) {
  if (!Number.isFinite(delta) || delta === 0) return;
  const { data: wallet, error: readError } = await supabase.from("wallets").select("*").eq("user_id", userId).maybeSingle();
  if (readError) throw readError;
  const current = wallet || { user_id: userId, eur: 10000, usdt: 10000 };
  const newUsdt = Number((Number(current.usdt||0) + delta).toFixed(2));
  const { error } = await supabase.from("wallets").upsert(
    { user_id: userId, eur: Number(current.eur||0), usdt: Math.max(0, newUsdt) },
    { onConflict: "user_id" }
  );
  if (error) throw error;
}

async function savePrices(priceMap) {
  const rows = Object.entries(priceMap).map(([pair, price]) => ({
    pair, price, updated_at: new Date().toISOString(),
  }));
  const { error } = await supabase.from("prices").upsert(rows, { onConflict: "pair" });
  if (error) console.error("❌ savePrices:", error.message);
}

// ── Tick principal ─────────────────────────────

let busy = false;

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const bots = await loadBots();

    // Prix : Testnet en priorité, sinon CoinGecko/simulation
    const priceMap = {};
    for (const pair of PAIRS) {
      const testnetPrice = await getTestnetPrice(toSymbol(pair));
      priceMap[pair] = testnetPrice || nextPrice(pair);
    }

    savePrices(priceMap);

    for (const bot of bots) {
      try {
        const oldState = await loadState(bot.id);
        const price    = priceMap[bot.pair] ?? nextPrice(bot.pair);
        const newState = runTick(bot, oldState, price);
        await saveState(bot.id, newState);

        const oldTop = oldState.log?.[0];
        const newTop = newState.log?.[0];
        const hasNewTrade = JSON.stringify(oldTop||null) !== JSON.stringify(newTop||null);

        if (hasNewTrade && newTop) {
          // Vrai ordre Testnet Binance
          if (TESTNET_ENABLED && bot.pair && newTop.a) {
            const qty = calcQty(bot.pair, bot.budget||100, price);
            await placeTestnetOrder(toSymbol(bot.pair), newTop.a, qty);
          }
          // Mise à jour wallet sur SELL
          if (newTop.a === "SELL" && typeof newTop.p === "number") {
            await updateWallet(bot.user_id, Number(newTop.p));
          }
        }

        console.log(`🤖 ${bot.name} | ${bot.strategy} | ${bot.pair} | price=${price} | pnl=${newState.pnl}${TESTNET_ENABLED?" | 🔗 Testnet":""}`);

      } catch (botError) {
        console.error(`❌ Bot ${bot.name}:`, botError.message);
      }
    }
  } catch (error) {
    console.error("❌ Erreur globale:", error.message);
  } finally {
    busy = false;
  }
}

console.log("🚀 TradeAuto bot engine lancé...");

if (TESTNET_ENABLED) {
  getTestnetBalance().then(balances => {
    if (balances) {
      const usdt = balances["USDT"]?.free || 0;
      const btc  = balances["BTC"]?.free  || 0;
      console.log(`💰 Solde Testnet: ${usdt.toFixed(2)} USDT | ${btc.toFixed(4)} BTC`);
    }
  });
}

setInterval(tick, TICK_MS);
tick();
