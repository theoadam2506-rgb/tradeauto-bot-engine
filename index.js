import { supabase } from "./supabase.js";
import { nextPrice } from "./price-feed.js";
import { runTick } from "./strategies.js";

const TICK_MS = 5000;
let busy = false;

async function loadBots() {
  const { data, error } = await supabase
    .from("bots")
    .select("*")
    .eq("running", true);

  if (error) throw error;
  return data || [];
}

async function loadState(botId) {
  const { data, error } = await supabase
    .from("bot_states")
    .select("*")
    .eq("bot_id", botId)
    .maybeSingle();

  if (error && error.code !== "PGRST116") {
    throw error;
  }

  return data || {
    bot_id: botId,
    pnl: 0,
    trades: 0,
    log: [],
    runtime: {}
  };
}

async function saveState(botId, state) {
  const payload = {
    bot_id: botId,
    pnl: Number(state.pnl || 0),
    trades: Number(state.trades || 0),
    log: state.log || [],
    runtime: state.runtime || {}
  };

  const { error } = await supabase
    .from("bot_states")
    .upsert(payload, { onConflict: "bot_id" });

  if (error) throw error;
}

async function updateWallet(userId, delta) {
  if (!Number.isFinite(delta) || delta === 0) return;

  const { data: wallet, error: readError } = await supabase
    .from("wallets")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (readError) throw readError;

  const current = wallet || { user_id: userId, eur: 10000, usdt: 10000 };
  const newUsdt = Number((Number(current.usdt || 0) + delta).toFixed(2));

  const { error: writeError } = await supabase
    .from("wallets")
    .upsert(
      {
        user_id: userId,
        eur: Number(current.eur || 0),
        usdt: Math.max(0, newUsdt)
      },
      { onConflict: "user_id" }
    );

  if (writeError) throw writeError;
}

async function tick() {
  if (busy) return;
  busy = true;

  try {
    const bots = await loadBots();

    for (const bot of bots) {
      try {
        const oldState = await loadState(bot.id);
        const price = nextPrice(bot.pair);
        const newState = runTick(bot, oldState, price);

        await saveState(bot.id, newState);

        const oldTop = oldState.log?.[0];
        const newTop = newState.log?.[0];

        const hasNewTrade =
          JSON.stringify(oldTop || null) !== JSON.stringify(newTop || null);

        if (
          hasNewTrade &&
          newTop &&
          newTop.a === "SELL" &&
          typeof newTop.p === "number"
        ) {
          await updateWallet(bot.user_id, Number(newTop.p));
        }

        console.log(
  `🤖 ${bot.name} | id=${bot.id} | ${bot.strategy} | ${bot.pair} | price=${price} | pnl=${newState.pnl}`
);
        
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
setInterval(tick, TICK_MS);
tick();
