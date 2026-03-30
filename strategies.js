export function fmt(n, d = 2) {
  return Number(Number(n).toFixed(d));
}

export function calcPnl(entryPrice, exitPrice, orderSize) {
  return fmt(((exitPrice - entryPrice) / entryPrice) * orderSize, 2);
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
    lastGI:       state?.runtime?.lastGI       ?? null,
    priceHistory: state?.runtime?.priceHistory ?? [],
    highWater:    state?.runtime?.highWater    ?? null,
    lastIndex:    state?.runtime?.lastIndex    ?? null,
    fearIndex:    state?.runtime?.fearIndex    ?? Math.floor(Math.random() * 100),
    fearTick:     state?.runtime?.fearTick     ?? 0,
  };
}

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
  const orderSize = Number(config.orderSize || bot.budget || 100);

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
      if (gi < prev && !next.runtime.pos) {
        next.runtime.pos    = price;
        next.runtime.lastGI = gi;
        trade = { a: "BUY", r: `Grid ↓ niv.${gi}` };
      } else if (gi > prev && next.runtime.pos) {
        const pnl = calcPnl(next.runtime.pos, price, orderSize);
        next.pnl            = fmt(next.pnl + pnl);
        next.runtime.pos    = null;
        next.runtime.lastGI = gi;
        trade = { a: "SELL", r: `Grid ↑ niv.${gi}`, p: pnl };
      } else {
        next.runtime.lastGI = gi;
      }
    }

    if (next.runtime.pos && price <= next.runtime.pos * (1 - stopLoss / 100)) {
      const pnl = calcPnl(next.runtime.pos, price, orderSize);
      next.pnl         = fmt(next.pnl + pnl);
      next.runtime.pos = null;
      trade = { a: "SELL", r: "🛑 SL", p: pnl };
    }
  }

  // ════════════════════════════════════════
  // DCA
  // ════════════════════════════════════════
  if (bot.strategy === "dca") {
    const now         = Date.now();
    const intervalMin = Number(config.intervalMin || 15);
    const takeProfit  = Number(config.takeProfit  || 3);
    const stopLoss    = Number(config.stopLoss    || 10);
    const intervalMs  = intervalMin * 60000;

    if (!next.runtime.pos && (now - next.runtime.lastBuy) >= intervalMs) {
      next.runtime.pos     = price;
      next.runtime.lastBuy = now;
      trade = { a: "BUY", r: "DCA auto" };
    }

    if (next.runtime.pos && price >= next.runtime.pos * (1 + takeProfit / 100)) {
      const pnl = calcPnl(next.runtime.pos, price, orderSize);
      next.pnl         = fmt(next.pnl + pnl);
      next.runtime.pos = null;
      trade = { a: "SELL", r: `✅ TP +${takeProfit}%`, p: pnl };
    }

    if (next.runtime.pos && price <= next.runtime.pos * (1 - stopLoss / 100)) {
      const pnl = calcPnl(next.runtime.pos, price, orderSize);
      next.pnl         = fmt(next.pnl + pnl);
      next.runtime.pos = null;
      trade = { a: "SELL", r: "🛑 SL", p: pnl };
    }
  }

  // ════════════════════════════════════════
  // SCALPING RSI
  // ════════════════════════════════════════
  if (bot.strategy === "scalp") {
    const rsiOversold  = Number(config.rsiOversold  || 32);
    const rsiOverbought= Number(config.rsiOverbought|| 68);
    const takeProfit   = Number(config.takeProfit   || 0.5);
    const stopLoss     = Number(config.stopLoss     || 0.3);

    const ph  = next.runtime.priceHistory;
    const rsi = ph.length >= 14 ? calcRSI(ph.slice(-14)) : 50;

    if (!next.runtime.pos && rsi < rsiOversold) {
      next.runtime.pos = price;
      trade = { a: "BUY", r: `RSI ${rsi.toFixed(0)}` };
    }

    if (next.runtime.pos) {
      const gain = (price - next.runtime.pos) / next.runtime.pos * 100;
      const loss = (next.runtime.pos - price) / next.runtime.pos * 100;

      if (rsi > rsiOverbought || gain >= takeProfit) {
        const pnl = calcPnl(next.runtime.pos, price, orderSize);
        next.pnl         = fmt(next.pnl + pnl);
        next.runtime.pos = null;
        trade = { a: "SELL", r: `RSI ${rsi.toFixed(0)} / TP`, p: pnl };
      } else if (loss >= stopLoss) {
        const pnl = calcPnl(next.runtime.pos, price, orderSize);
        next.pnl         = fmt(next.pnl + pnl);
        next.runtime.pos = null;
        trade = { a: "SELL", r: "🛑 SL", p: pnl };
      }
    }
  }

  // ════════════════════════════════════════
  // TREND FOLLOWING (MA crossover)
  // ════════════════════════════════════════
  if (bot.strategy === "trend") {
    const fastMA   = Math.max(3,  Number(config.fastMA   || 9));
    const slowMA   = Math.max(10, Number(config.slowMA   || 21));
    const stopLoss = Number(config.stopLoss  || 5);
    const trailPct = Number(config.trailPct  || 2);

    const ph = next.runtime.priceHistory;

    if (ph.length >= slowMA) {
      const fast = calcSMA(ph, fastMA);
      const slow = calcSMA(ph, slowMA);

      // Previous fast/slow (one tick ago)
      const phPrev = ph.slice(0, -1);
      const fastPrev = phPrev.length >= fastMA ? calcSMA(phPrev, fastMA) : fast;
      const slowPrev = phPrev.length >= slowMA ? calcSMA(phPrev, slowMA) : slow;

      // Bullish crossover → BUY
      if (!next.runtime.pos && fastPrev <= slowPrev && fast > slow) {
        next.runtime.pos       = price;
        next.runtime.highWater = price;
        trade = { a: "BUY", r: `MA↑ fast=${fast.toFixed(0)} slow=${slow.toFixed(0)}` };
      }

      if (next.runtime.pos) {
        // Update high water mark for trailing stop
        if (price > (next.runtime.highWater || price)) {
          next.runtime.highWater = price;
        }

        const trailStop = next.runtime.highWater * (1 - trailPct / 100);
        const hardStop  = next.runtime.pos * (1 - stopLoss / 100);
        const bearCross = fastPrev >= slowPrev && fast < slow;

        if (bearCross || price <= trailStop || price <= hardStop) {
          const pnl = calcPnl(next.runtime.pos, price, orderSize);
          next.pnl               = fmt(next.pnl + pnl);
          next.runtime.pos       = null;
          next.runtime.highWater = null;
          const reason = bearCross ? "MA↓ croisement" : price <= hardStop ? "🛑 SL" : "🛑 Trailing";
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
      const window    = ph.slice(-lookback - 1, -1); // exclude current price
      const resistance= Math.max(...window);
      const threshold = resistance * (1 + breakoutPct / 100);

      // BUY on breakout above resistance
      if (!next.runtime.pos && price >= threshold) {
        next.runtime.pos = price;
        trade = { a: "BUY", r: `Breakout ${resistance.toFixed(0)} → ${price.toFixed(0)}` };
      }
    }

    if (next.runtime.pos) {
      const gain = (price - next.runtime.pos) / next.runtime.pos * 100;
      const loss = (next.runtime.pos - price) / next.runtime.pos * 100;

      if (gain >= takeProfit) {
        const pnl = calcPnl(next.runtime.pos, price, orderSize);
        next.pnl         = fmt(next.pnl + pnl);
        next.runtime.pos = null;
        trade = { a: "SELL", r: `✅ TP +${takeProfit}%`, p: pnl };
      } else if (loss >= stopLoss) {
        const pnl = calcPnl(next.runtime.pos, price, orderSize);
        next.pnl         = fmt(next.pnl + pnl);
        next.runtime.pos = null;
        trade = { a: "SELL", r: "🛑 SL", p: pnl };
      }
    }
  }

  // ════════════════════════════════════════
  // BB SQUEEZE (Bollinger Bands)
  // ════════════════════════════════════════
  if (bot.strategy === "bb") {
    const bbPeriod         = Math.max(5, Number(config.bbPeriod         || 20));
    const bbStdDev         = Number(config.bbStdDev         || 2);
    const squeezeThreshold = Number(config.squeezeThreshold || 2);
    const takeProfit       = Number(config.takeProfit       || 3);
    const stopLoss         = Number(config.stopLoss         || 2);

    const ph = next.runtime.priceHistory;

    if (ph.length >= bbPeriod) {
      const bb = calcBollinger(ph, bbPeriod, bbStdDev);
      const bandwidthPct = bb.bandwidth * 100;

      // Squeeze detected + price breaks above mid → BUY
      if (!next.runtime.pos && bandwidthPct <= squeezeThreshold && price > bb.mid) {
        next.runtime.pos = price;
        trade = { a: "BUY", r: `BB Squeeze bw=${bandwidthPct.toFixed(1)}%` };
      }
    }

    if (next.runtime.pos) {
      const gain = (price - next.runtime.pos) / next.runtime.pos * 100;
      const loss = (next.runtime.pos - price) / next.runtime.pos * 100;

      if (gain >= takeProfit) {
        const pnl = calcPnl(next.runtime.pos, price, orderSize);
        next.pnl         = fmt(next.pnl + pnl);
        next.runtime.pos = null;
        trade = { a: "SELL", r: `✅ TP +${takeProfit}%`, p: pnl };
      } else if (loss >= stopLoss) {
        const pnl = calcPnl(next.runtime.pos, price, orderSize);
        next.pnl         = fmt(next.pnl + pnl);
        next.runtime.pos = null;
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
      const emaFast = calcEMA(ph, macdFast);
      const emaSlow = calcEMA(ph, macdSlow);
      const macdLine = emaFast - emaSlow;

      // Signal line = EMA of MACD line (approximate with recent history)
      const macdHistory = ph.slice(-macdSignal - 5).map((_, i, arr) => {
        const slice = ph.slice(0, ph.length - macdSignal - 5 + i + 1);
        if (slice.length < macdSlow) return 0;
        return calcEMA(slice, macdFast) - calcEMA(slice, macdSlow);
      });
      const signalLine = calcEMA(macdHistory, macdSignal);

      // Previous values
      const phPrev = ph.slice(0, -1);
      const emaFastPrev = calcEMA(phPrev, macdFast);
      const emaSlowPrev = calcEMA(phPrev, macdSlow);
      const macdPrev = emaFastPrev - emaSlowPrev;
      const signalPrev = signalLine * 0.98; // approximation

      // Bullish crossover: MACD crosses above signal
      if (!next.runtime.pos && macdPrev <= signalPrev && macdLine > signalLine && macdLine > 0) {
        next.runtime.pos = price;
        trade = { a: "BUY", r: `MACD↑ ${macdLine.toFixed(1)}` };
      }
    }

    if (next.runtime.pos) {
      const gain = (price - next.runtime.pos) / next.runtime.pos * 100;
      const loss = (next.runtime.pos - price) / next.runtime.pos * 100;

      if (gain >= takeProfit) {
        const pnl = calcPnl(next.runtime.pos, price, orderSize);
        next.pnl         = fmt(next.pnl + pnl);
        next.runtime.pos = null;
        trade = { a: "SELL", r: `✅ TP +${takeProfit}%`, p: pnl };
      } else if (loss >= stopLoss) {
        const pnl = calcPnl(next.runtime.pos, price, orderSize);
        next.pnl         = fmt(next.pnl + pnl);
        next.runtime.pos = null;
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

    // Simulate Fear & Greed index update every ~10 ticks
    next.runtime.fearTick = (next.runtime.fearTick || 0) + 1;
    if (next.runtime.fearTick >= 10) {
      next.runtime.fearTick = 0;
      // Random walk on fear index, biased toward current market direction
      const ph = next.runtime.priceHistory;
      const trend = ph.length >= 5 ? (ph[ph.length - 1] - ph[ph.length - 5]) / ph[ph.length - 5] * 100 : 0;
      const delta = (Math.random() - 0.5) * 12 + trend * 2;
      next.runtime.fearIndex = Math.max(0, Math.min(100, (next.runtime.fearIndex || 50) + delta));
    }

    const fearIndex = next.runtime.fearIndex || 50;

    // Extreme fear → BUY (contrarian)
    if (!next.runtime.pos && fearIndex <= fearThreshold) {
      next.runtime.pos = price;
      trade = { a: "BUY", r: `😨 Fear ${fearIndex.toFixed(0)}` };
    }

    // Extreme greed → SELL (take profit)
    if (next.runtime.pos && fearIndex >= greedThreshold) {
      const pnl = calcPnl(next.runtime.pos, price, orderSize);
      next.pnl         = fmt(next.pnl + pnl);
      next.runtime.pos = null;
      trade = { a: "SELL", r: `🤑 Greed ${fearIndex.toFixed(0)}`, p: pnl };
    }

    // TP / SL classiques
    if (next.runtime.pos) {
      const gain = (price - next.runtime.pos) / next.runtime.pos * 100;
      const loss = (next.runtime.pos - price) / next.runtime.pos * 100;

      if (gain >= takeProfit) {
        const pnl = calcPnl(next.runtime.pos, price, orderSize);
        next.pnl         = fmt(next.pnl + pnl);
        next.runtime.pos = null;
        trade = { a: "SELL", r: `✅ TP +${takeProfit}%`, p: pnl };
      } else if (loss >= stopLoss) {
        const pnl = calcPnl(next.runtime.pos, price, orderSize);
        next.pnl         = fmt(next.pnl + pnl);
        next.runtime.pos = null;
        trade = { a: "SELL", r: "🛑 SL", p: pnl };
      }
    }
  }

  // ── Log trade ────────────────────────────────────────
  if (trade) {
    const now = new Date();
    next.log = [{
      ...trade,
      price,
      ts:   now.toISOString(),
      t:    now.toLocaleTimeString("fr-FR"),
      date: now.toLocaleDateString("fr-FR"),
    }, ...next.log].slice(0, 100);
    next.trades += 1;
  }

  return next;
}
