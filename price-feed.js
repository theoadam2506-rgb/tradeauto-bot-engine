const BASE = {
  "BTC/USDT": 67420,
  "ETH/USDT": 3510,
  "SOL/USDT": 178,
  "BNB/USDT": 598,
  "XRP/USDT": 0.618,
  "AVAX/USDT": 36.4
};

const VOL = {
  "BTC/USDT": 0.007,
  "ETH/USDT": 0.011,
  "SOL/USDT": 0.016,
  "BNB/USDT": 0.009,
  "XRP/USDT": 0.02,
  "AVAX/USDT": 0.018
};

const state = { ...BASE };

function roundPrice(pair, value) {
  if (pair === "XRP/USDT") return Number(value.toFixed(5));
  if (value > 1000) return Number(value.toFixed(1));
  if (value > 1) return Number(value.toFixed(3));
  return Number(value.toFixed(5));
}

export function nextPrice(pair) {
  const current = state[pair] ?? BASE[pair] ?? 100;
  const vol = VOL[pair] ?? 0.01;

  const next = Math.max(
    current * 0.3,
    current * (1 + (Math.random() - 0.495) * vol + (Math.random() - 0.5) * vol * 0.4)
  );

  state[pair] = roundPrice(pair, next);
  return state[pair];
}
