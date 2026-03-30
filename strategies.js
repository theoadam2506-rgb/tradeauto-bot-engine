export function fmt(n, d = 2) {
  return Number(Number(n).toFixed(d));
}

// Frais Binance : 0.1% maker + 0.1% taker = 0.2% par aller-retour
const FEE_RATE = 0.001; // 0.1% par ordre

export function calcPnl(entryPrice, exitPrice, orderSize) {
  const gross = ((exitPrice - entryPrice) / entryPrice) * orderSize;
  const fees  = orderSize * FEE_RATE * 2; // BUY fee + SELL fee
  return fmt(gross - fees, 2);
}

// ── Helpers ──────────────────────────────────────────
function calcRSI(prices) {
  if (prices.length < 2) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avg = prices.length - 1;
  const rs = (gains / avg) / ((losses / avg) || 1);
  return 100 - 100 / (1 + rs);
}

function calcEMA(prices, period) {
  if (prices.length === 0) return 0;
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcSMA(prices, period) {
  const slice = prices.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function calcBollinger(prices, period, stdDev) {
  const sma = calcSMA(prices, period);
  const slice = prices.slice(-period);
  const variance = slice.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / slice.length;
  const sd = Math.sqrt(variance);
  return { upper: sma + stdDev * sd, lower: sma - stdDev * sd, mid: sma, bandwidth: (2 * stdDev * sd) / sma };
}

// ── Runtime init ─────────────────────────────────────
function initRuntime(state) {
  return {
    pos:          state?.runtime?.pos          ?? null,
    lastBuy:      state?.runtime?.lastBuy      ?? 0,
    lastTrade:    state?.runtime?.lastTrade    ?? 0,   // timestamp dernier trade
    lastGI:       state?.runtime?.lastGI       ?? null,
    priceHistory: state?.runtime?.priceHistory ?? [],
    highWater:    state?.runtime?.highWater    ?? null,
    lastIndex:    state?.runtime?.lastIndex    ?? null,
    fearIndex:    state?.runtime?.fearIndex    ?? Math.floor(Math.random() * 100),
    fearTick:     state?.runtime?.fearTick     ?? 0,
  };
}

// Cooldowns minimaux par stratégie (en ms)
// Empêche de trader à chaque tick de 5 secondes
const COOLDOWNS = {
  grid:     60  * 1000,  // min 1 minute entre trades Grid
  dca:      0,           // DCA gère son propre intervalle
  scalp:    30  * 1000,  // min 30s entre trades Scalp
  trend:    120 * 1000,  // min 2 minutes Trend
  breakout: 120 * 1000,  // min 2 minutes Breakout
  bb:       90  * 1000,  // min 90s BB Squeeze
  macd:     120 * 1000,  // min 2 minutes MACD
  feargreed:300 * 1000,  // min 5 minutes Fear & Greed
};

// ── Main tick ─────────────────────────────────────────
export function runTick(bot, state, price) {
  const config = bot.config || {};
  const next = {
    pnl:     Number(state?.pnl    || 0),
    trades:  Number(state?.trades || 0),
    log:     Array.isArray(state?.log) ? [...state.log] : [],
    runtime: initRuntime(state),
  };

  // Append price to history (max 100 points)
  next.runtime.priceHistory = [...next.runtime.priceHistory, price].slice(-100);

  let trade = null;
  const orderSize  = Number(config.orderSize || bot.budget || 100);
  const now        = Date.now();
  const cooldown   = COOLDOWNS[bot.strategy] ?? 60000;
  const canTrade   = (now - (next.runtime.lastTrade || 0)) >= cooldown;

  // ════════════════════════════════════════
  // GRID
  // ════════════════════════════════════════
  if (bot.strategy === "grid") {
    const low      = Number(config.gridLow    || 60000);
    const high     = Number(config.gridHigh   || 75000);
    const levels   = Math.max(1, Number(config.gridLevels || 10));
    const stopLoss = Number(config.stopLoss   || 8);

    const step = (high - low) / levels;
    const gi   = Math.floor((price - low) / step);
    const prev = next.runtime.lastGI ?? gi;

    if (price >= low && price <= high) {
      // BUY : on descend d'un niveau + pas de position + cooldown respecté
      if (gi < prev && !next.runtime.pos && canTrade) {
        next.runtime.pos       = price;
        next.runtime.lastGI    = gi;
        next.runtime.lastTrade = now;
        trade = { a: "BUY", r: `Grid ↓ niv.${gi}` };

      // SELL : on monte d'un niveau + position ouverte + cooldown respecté
      } else if (gi > prev && next.runtime.pos && canTrade) {
        const pnl = calcPnl(next.runtime.pos, price, orderSize);
        next.pnl               = fmt(next.pnl + pnl);
        next.runtime.pos       = null;
        next.runtime.lastGI    = gi;
        next.runtime.lastTrade = now;
        trade = { a: "SELL", r: `Grid ↑ niv.${gi}`, p: pnl };

      } else {
        next.runtime.lastGI = gi;
      }
    }

    // Stop-loss (toujours actif, pas de cooldown)
    if (next.runtime.pos && price <= next.runtime.pos * (1 - stopLoss / 100)) {
      const pnl = calcPnl(next.runtime.pos, price, orderSize);
      next.pnl               = fmt(next.pnl + pnl);
      next.runtime.pos       = null;
      next.runtime.lastTrade = now;
      trade = { a: "SELL", r: "🛑 SL", p: pnl };
    }
  }

  // ════════════════════════════════════════
  // DCA
  // ════════════════════════════════════════
  if (bot.strategy === "dca") {
    const intervalMin = Number(config.intervalMin || 15);
    const takeProfit  = Number(config.takeProfit  || 3);
    const stopLoss    = Number(config.stopLoss    || 10);
    const intervalMs  = intervalMin * 60000;

    if (!next.runtime.pos && (now - next.runtime.lastBuy) >= intervalMs) {
      next.runtime.pos       = price;
      next.runtime.lastBuy   = now;
      next.runtime.lastTrade = now;
      trade = { a: "BUY", r: "DCA auto" };
    }

    if (next.runtime.pos && price >= next.runtime.pos * (1 + takeProfit / 100)) {
      const pnl = calcPnl(next.runtime.pos, price, orderSize);
      next.pnl               = fmt(next.pnl + pnl);
      next.runtime.pos       = null;
      next.runtime.lastTrade = now;
      trade = { a: "SELL", r: `✅ TP +${takeProfit}%`, p: pnl };
    }

    if (next.runtime.pos && price <= next.runtime.pos * (1 - stopLoss / 100)) {
      const pnl = calcPnl(next.runtime.pos, price, orderSize);
      next.pnl               = fmt(next.pnl + pnl);
      next.runtime.pos       = null;
      next.runtime.lastTrade = now;
      trade = { a: "SELL", r: "🛑 SL", p: pnl };
    }
  }

  // ════════════════════════════════════════
  // SCALPING RSI
  // ════════════════════════════════════════
  if (bot.strategy === "scalp") {
    const rsiOversold   = Number(config.rsiOversold   || 32);
    const rsiOverbought = Number(config.rsiOverbought || 68);
    const takeProfit    = Number(config.takeProfit    || 0.5);
    const stopLoss      = Number(config.stopLoss      || 0.3);

    const ph  = next.runtime.priceHistory;
    const rsi = ph.length >= 14 ? calcRSI(ph.slice(-14)) : 50;

    if (!next.runtime.pos && rsi < rsiOversold && canTrade) {
      next.runtime.pos       = price;
      next.runtime.lastTrade = now;
      trade = { a: "BUY", r: `RSI ${rsi.toFixed(0)}` };
    }

    if (next.runtime.pos) {
      const gain = (price - next.runtime.pos) / next.runtime.pos * 100;
      const loss = (next.runtime.pos - price) / next.runtime.pos * 100;

      if ((rsi > rsiOverbought || gain >= takeProfit) && canTrade) {
        const pnl = calcPnl(next.runtime.pos, price, orderSize);
        next.pnl               = fmt(next.pnl + pnl);
        next.runtime.pos       = null;
        next.runtime.lastTrade = now;
        trade = { a: "SELL", r: `RSI ${rsi.toFixed(0)} / TP`, p: pnl };
      } else if (loss >= stopLoss) {
        const pnl = calcPnl(next.runtime.pos, price, orderSize);
        next.pnl               = fmt(next.pnl + pnl);
        next.runtime.pos       = null;
        next.runtime.lastTrade = now;
        trade = { a: "SELL", r: "🛑 SL", p: pnl };
      }
    }
  }

  // ════════════════════════════════════════
  // TREND FOLLOWING
  // ════════════════════════════════════════
  if (bot.strategy === "trend") {
    const fastMA   = Math.max(3,  Number(config.fastMA   || 9));
    const slowMA   = Math.max(10, Number(config.slowMA   || 21));
    const stopLoss = Number(config.stopLoss || 5);
    const trailPct = Number(config.trailPct || 2);

    const ph = next.runtime.priceHistory;

    if (ph.length >= slowMA) {
      const fast     = calcSMA(ph, fastMA);
      const slow     = calcSMA(ph, slowMA);
      const phPrev   = ph.slice(0, -1);
      const fastPrev = phPrev.length >= fastMA ? calcSMA(phPrev, fastMA) : fast;
      const slowPrev = phPrev.length >= slowMA ? calcSMA(phPrev, slowMA) : slow;

      if (!next.runtime.pos && fastPrev <= slowPrev && fast > slow && canTrade) {
        next.runtime.pos       = price;
        next.runtime.highWater = price;
        next.runtime.lastTrade = now;
        trade = { a: "BUY", r: `MA↑ fast=${fast.toFixed(0)} slow=${slow.toFixed(0)}` };
      }

      if (next.runtime.pos) {
        if (price > (next.runtime.highWater || price)) {
          next.runtime.highWater = price;
        }
        const trailStop = next.runtime.highWater * (1 - trailPct / 100);
        const hardStop  = next.runtime.pos * (1 - stopLoss / 100);
        const bearCross = fastPrev >= slowPrev && fast < slow;

        if (price <= trailStop || price <= hardStop || bearCross) {
          const reason = bearCross ? "MA↓ crossover" : price <= hardStop ? "🛑 SL" : `🔒 Trail ${trailPct}%`;
          const pnl = calcPnl(next.runtime.pos, price, orderSize);
          next.pnl               = fmt(next.pnl + pnl);
          next.runtime.pos       = null;
          next.runtime.highWater = null;
          next.runtime.lastTrade = now;
          trade = { a: "SELL", r: reason, p: pnl };
        }
      }
    }
  }

  // ════════════════════════════════════════
  // BREAKOUT
  // ════════════════════════════════════════
  if (bot.strategy === "breakout") {
    const lookback    = Math.max(5, Number(config.lookback    || 20));
    const breakoutPct = Number(config.breakoutPct || 1);
    const takeProfit  = Number(config.takeProfit  || 4);
    const stopLoss    = Number(config.stopLoss    || 2);

    const ph = next.runtime.priceHistory;

    if (ph.length >= lookback) {
      const window     = ph.slice(-lookback - 1, -1);
      const resistance = Math.max(...window);
      const threshold  = resistance * (1 + breakoutPct / 100);

      if (!next.runtime.pos && price >= threshold && canTrade) {
        next.runtime.pos       = price;
        next.runtime.lastTrade = now;
        trade = { a: "BUY", r: `Breakout ${resistance.toFixed(0)} → ${price.toFixed(0)}` };
      }
    }

    if (next.runtime.pos) {
      const gain = (price - next.runtime.pos) / next.runtime.pos * 100;
      const loss = (next.runtime.pos - price) / next.runtime.pos * 100;

      if (gain >= takeProfit) {
        const pnl = calcPnl(next.runtime.pos, price, orderSize);
        next.pnl               = fmt(next.pnl + pnl);
        next.runtime.pos       = null;
        next.runtime.lastTrade = now;
        trade = { a: "SELL", r: `✅ TP +${takeProfit}%`, p: pnl };
      } else if (loss >= stopLoss) {
        const pnl = calcPnl(next.runtime.pos, price, orderSize);
        next.pnl               = fmt(next.pnl + pnl);
        next.runtime.pos       = null;
        next.runtime.lastTrade = now;
        trade = { a: "SELL", r: "🛑 SL", p: pnl };
      }
    }
  }

  // ════════════════════════════════════════
  // BB SQUEEZE
  // ════════════════════════════════════════
  if (bot.strategy === "bb") {
    const bbPeriod         = Math.max(5, Number(config.bbPeriod         || 20));
    const bbStdDev         = Number(config.bbStdDev         || 2);
    const squeezeThreshold = Number(config.squeezeThreshold || 2);
    const takeProfit       = Number(config.takeProfit       || 3);
    const stopLoss         = Number(config.stopLoss         || 2);

    const ph = next.runtime.priceHistory;

    if (ph.length >= bbPeriod) {
      const bb           = calcBollinger(ph, bbPeriod, bbStdDev);
      const bandwidthPct = bb.bandwidth * 100;

      if (!next.runtime.pos && bandwidthPct <= squeezeThreshold && price > bb.mid && canTrade) {
        next.runtime.pos       = price;
        next.runtime.lastTrade = now;
        trade = { a: "BUY", r: `BB Squeeze bw=${bandwidthPct.toFixed(1)}%` };
      }
    }

    if (next.runtime.pos) {
      const gain = (price - next.runtime.pos) / next.runtime.pos * 100;
      const loss = (next.runtime.pos - price) / next.runtime.pos * 100;

      if (gain >= takeProfit) {
        const pnl = calcPnl(next.runtime.pos, price, orderSize);
        next.pnl               = fmt(next.pnl + pnl);
        next.runtime.pos       = null;
        next.runtime.lastTrade = now;
        trade = { a: "SELL", r: `✅ TP +${takeProfit}%`, p: pnl };
      } else if (loss >= stopLoss) {
        const pnl = calcPnl(next.runtime.pos, price, orderSize);
        next.pnl               = fmt(next.pnl + pnl);
        next.runtime.pos       = null;
        next.runtime.lastTrade = now;
        trade = { a: "SELL", r: "🛑 SL", p: pnl };
      }
    }
  }

  // ════════════════════════════════════════
  // MACD
  // ════════════════════════════════════════
  if (bot.strategy === "macd") {
    const macdFast   = Math.max(5,  Number(config.macdFast   || 12));
    const macdSlow   = Math.max(10, Number(config.macdSlow   || 26));
    const macdSignal = Math.max(3,  Number(config.macdSignal || 9));
    const takeProfit = Number(config.takeProfit || 3);
    const stopLoss   = Number(config.stopLoss   || 2);

    const ph = next.runtime.priceHistory;

    if (ph.length >= macdSlow + macdSignal) {
      const emaFast  = calcEMA(ph, macdFast);
      const emaSlow  = calcEMA(ph, macdSlow);
      const macdLine = emaFast - emaSlow;

      const macdHistory = ph.slice(-macdSignal - 5).map((_, i, arr) => {
        const slice = ph.slice(0, ph.length - macdSignal - 5 + i + 1);
        if (slice.length < macdSlow) return 0;
        return calcEMA(slice, macdFast) - calcEMA(slice, macdSlow);
      });
      const signalLine = calcEMA(macdHistory, macdSignal);

      const phPrev      = ph.slice(0, -1);
      const emaFastPrev = calcEMA(phPrev, macdFast);
      const emaSlowPrev = calcEMA(phPrev, macdSlow);
      const macdPrev    = emaFastPrev - emaSlowPrev;
      const signalPrev  = signalLine * 0.98;

      if (!next.runtime.pos && macdPrev <= signalPrev && macdLine > signalLine && macdLine > 0 && canTrade) {
        next.runtime.pos       = price;
        next.runtime.lastTrade = now;
        trade = { a: "BUY", r: `MACD↑ ${macdLine.toFixed(1)}` };
      }
    }

    if (next.runtime.pos) {
      const gain = (price - next.runtime.pos) / next.runtime.pos * 100;
      const loss = (next.runtime.pos - price) / next.runtime.pos * 100;

      if (gain >= takeProfit) {
        const pnl = calcPnl(next.runtime.pos, price, orderSize);
        next.pnl               = fmt(next.pnl + pnl);
        next.runtime.pos       = null;
        next.runtime.lastTrade = now;
        trade = { a: "SELL", r: `✅ TP +${takeProfit}%`, p: pnl };
      } else if (loss >= stopLoss) {
        const pnl = calcPnl(next.runtime.pos, price, orderSize);
        next.pnl               = fmt(next.pnl + pnl);
        next.runtime.pos       = null;
        next.runtime.lastTrade = now;
        trade = { a: "SELL", r: "🛑 SL", p: pnl };
      }
    }
  }

  // ════════════════════════════════════════
  // FEAR & GREED
  // ════════════════════════════════════════
  if (bot.strategy === "feargreed") {
    const fearThreshold  = Number(config.fearThreshold  || 20);
    const greedThreshold = Number(config.greedThreshold || 80);
    const takeProfit     = Number(config.takeProfit     || 10);
    const stopLoss       = Number(config.stopLoss       || 8);

    next.runtime.fearTick = (next.runtime.fearTick || 0) + 1;
    if (next.runtime.fearTick >= 10) {
      next.runtime.fearTick = 0;
      const ph    = next.runtime.priceHistory;
      const trend = ph.length >= 5 ? (ph[ph.length - 1] - ph[ph.length - 5]) / ph[ph.length - 5] * 100 : 0;
      const delta = (Math.random() - 0.5) * 12 + trend * 2;
      next.runtime.fearIndex = Math.max(0, Math.min(100, (next.runtime.fearIndex || 50) + delta));
    }

    const fearIndex = next.runtime.fearIndex || 50;

    if (!next.runtime.pos && fearIndex <= fearThreshold && canTrade) {
      next.runtime.pos       = price;
      next.runtime.lastTrade = now;
      trade = { a: "BUY", r: `😨 Fear ${fearIndex.toFixed(0)}` };
    }

    if (next.runtime.pos && fearIndex >= greedThreshold && canTrade) {
      const pnl = calcPnl(next.runtime.pos, price, orderSize);
      next.pnl               = fmt(next.pnl + pnl);
      next.runtime.pos       = null;
      next.runtime.lastTrade = now;
      trade = { a: "SELL", r: `🤑 Greed ${fearIndex.toFixed(0)}`, p: pnl };
    }

    if (next.runtime.pos) {
      const gain = (price - next.runtime.pos) / next.runtime.pos * 100;
      const loss = (next.runtime.pos - price) / next.runtime.pos * 100;

      if (gain >= takeProfit) {
        const pnl = calcPnl(next.runtime.pos, price, orderSize);
        next.pnl               = fmt(next.pnl + pnl);
        next.runtime.pos       = null;
        next.runtime.lastTrade = now;
        trade = { a: "SELL", r: `✅ TP +${takeProfit}%`, p: pnl };
      } else if (loss >= stopLoss) {
        const pnl = calcPnl(next.runtime.pos, price, orderSize);
        next.pnl               = fmt(next.pnl + pnl);
        next.runtime.pos       = null;
        next.runtime.lastTrade = now;
        trade = { a: "SELL", r: "🛑 SL", p: pnl };
      }
    }
  }

  // ── Log trade ────────────────────────────────────────
  if (trade) {
    const nowDate = new Date();
    next.log = [{
      ...trade,
      price,
      ts:   nowDate.toISOString(),
      t:    nowDate.toLocaleTimeString("fr-FR"),
      date: nowDate.toLocaleDateString("fr-FR"),
    }, ...next.log].slice(0, 100);
    next.trades += 1;
  }

  return next;
}
