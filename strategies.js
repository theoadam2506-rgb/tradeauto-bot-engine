export function fmt(n, d = 2) {
  return Number(Number(n).toFixed(d));
}

export function calcPnl(entryPrice, exitPrice, orderSize) {
  return fmt(((exitPrice - entryPrice) / entryPrice) * orderSize, 2);
}

export function runTick(bot, state, price) {
  const config = bot.config || {};
  const next = {
    pnl: Number(state?.pnl || 0),
    trades: Number(state?.trades || 0),
    log: Array.isArray(state?.log) ? [...state.log] : [],
    runtime: {
      pos: state?.runtime?.pos ?? null,
      lastBuy: state?.runtime?.lastBuy ?? 0,
      lastGI: state?.runtime?.lastGI ?? null
    }
  };

  let trade = null;
  const orderSize = Number(config.orderSize || bot.budget || 100);

  // GRID
  if (bot.strategy === "grid") {
    const low = Number(config.gridLow || 60000);
    const high = Number(config.gridHigh || 75000);
    const levels = Math.max(1, Number(config.gridLevels || 10));
    const stopLoss = Number(config.stopLoss || 8);

    const step = (high - low) / levels;
    const gi = Math.floor((price - low) / step);
    const prev = next.runtime.lastGI ?? gi;

    if (price >= low && price <= high) {
      if (gi < prev && !next.runtime.pos) {
        next.runtime.pos = price;
        next.runtime.lastGI = gi;
        trade = { a: "BUY", r: `Grid ↓ niv.${gi}` };
      } else if (gi > prev && next.runtime.pos) {
        const pnl = calcPnl(next.runtime.pos, price, orderSize);
        next.pnl = fmt(next.pnl + pnl);
        next.runtime.pos = null;
        next.runtime.lastGI = gi;
        trade = { a: "SELL", r: `Grid ↑ niv.${gi}`, p: pnl };
      } else {
        next.runtime.lastGI = gi;
      }
    }

    if (
      next.runtime.pos &&
      price <= next.runtime.pos * (1 - stopLoss / 100)
    ) {
      const pnl = calcPnl(next.runtime.pos, price, orderSize);
      next.pnl = fmt(next.pnl + pnl);
      next.runtime.pos = null;
      trade = { a: "SELL", r: "🛑 SL", p: pnl };
    }
  }

  // DCA
  if (bot.strategy === "dca") {
    const now = Date.now();
    const intervalMin = Number(config.intervalMin || 15);
    const takeProfit = Number(config.takeProfit || 3);
    const stopLoss = Number(config.stopLoss || 10);

    const intervalMs = intervalMin * 60000;

    if (!next.runtime.pos && (now - next.runtime.lastBuy) >= intervalMs) {
      next.runtime.pos = price;
      next.runtime.lastBuy = now;
      trade = { a: "BUY", r: "DCA auto" };
    }

    if (
      next.runtime.pos &&
      price >= next.runtime.pos * (1 + takeProfit / 100)
    ) {
      const pnl = calcPnl(next.runtime.pos, price, orderSize);
      next.pnl = fmt(next.pnl + pnl);
      next.runtime.pos = null;
      trade = { a: "SELL", r: `✅ TP +${takeProfit}%`, p: pnl };
    }

    if (
      next.runtime.pos &&
      price <= next.runtime.pos * (1 - stopLoss / 100)
    ) {
      const pnl = calcPnl(next.runtime.pos, price, orderSize);
      next.pnl = fmt(next.pnl + pnl);
      next.runtime.pos = null;
      trade = { a: "SELL", r: "🛑 SL", p: pnl };
    }
  }

  if (trade) {
    const now = new Date();
    const logEntry = {
      ...trade,
      price,
      ts: now.toISOString(),
      t: now.toLocaleTimeString("fr-FR"),
      date: now.toLocaleDateString("fr-FR")
    };

    next.log = [logEntry, ...next.log].slice(0, 100);
    next.trades += 1;
  }

  return next;
}
