import { convertRate } from './rates.mjs';

export function roiPercent(currentValue, costBasis) {
  if (!(Number(costBasis) > 0)) return null;
  return (Number(currentValue) - Number(costBasis)) / Number(costBasis) * 100;
}

export function periodReturn(points = []) {
  const first = points[0]; const last = points.at(-1);
  if (!first || !last || !(Number(first.value) > 0)) return null;
  return (Number(last.value) / Number(first.value) - 1) * 100;
}

const asOfThenId = (left, right) => String(left.date).localeCompare(String(right.date)) || Number(left.id ?? 0) - Number(right.id ?? 0);

// One portfolio valuation per date that carries a record. A point is the sum of what was held on that
// date, priced with the newest snapshot recorded on or before it, and converted with the exchange rate
// dated on or before that same point — never with today's rate.
//
// The conversion date is the point's own date, spelled out because getting it wrong is invisible: a
// portfolio that is 30% in USD moves in the home currency whenever the rate moves, and translating every
// historical point with the latest stored rate flattens exactly the movement a value-history chart is
// supposed to show. `convertRate` already walks backwards to the newest rate on or before a date; what
// this module must not do is call it without a date.
//
// Two more rules matter more than they look:
//
// - A holding that has no price snapshot yet is valued at the unit price of its newest recorded trade,
//   not dropped from the total. Dropping it silently deleted every date before the first snapshot of
//   the newest holding, which turned a one-year window into the last five weeks and made the line jump
//   on the day that snapshot arrived.
// - A holding with no dated exchange rate is left out of the point and marks it `complete: false`.
//   It is never converted with a different date's rate: using today's rate for an old point is exactly
//   the mistake this series exists to avoid.
//
// `estimated` marks a point that includes at least one holding valued at its purchase price, so the UI
// can say which part of the line is not market data.
export function portfolioHistory({ assets = [], transactions = [], prices = [], dividends = [], cash_balances = [], rates, homeCurrency } = {}) {
  const orderedTransactions = [...transactions].sort(asOfThenId);
  const pricesByAsset = new Map();
  for (const price of [...prices].sort(asOfThenId)) {
    if (!pricesByAsset.has(price.asset_id)) pricesByAsset.set(price.asset_id, []);
    pricesByAsset.get(price.asset_id).push(price);
  }
  const cashBySlot = new Map();
  for (const balance of [...cash_balances].sort(asOfThenId)) {
    const slot = `${balance.account_id}:${balance.asset_id ?? 'account'}`;
    if (!cashBySlot.has(slot)) cashBySlot.set(slot, []);
    cashBySlot.get(slot).push(balance);
  }

  const dates = [...new Set([...transactions, ...prices, ...dividends, ...cash_balances].map((row) => row.date).filter(Boolean))].sort();
  const result = [];

  // Running state, advanced once per date instead of rescanning every row for every point.
  const quantity = new Map();
  const lastTradePrice = new Map();
  const priceCursor = new Map();
  const cashCursor = new Map();
  let nextTransaction = 0;

  const applyTransactions = (date) => {
    while (nextTransaction < orderedTransactions.length && String(orderedTransactions[nextTransaction].date) <= date) {
      const transaction = orderedTransactions[nextTransaction++];
      if (!transaction.asset_id || !['buy', 'sell'].includes(transaction.kind)) continue;
      const signed = (transaction.kind === 'buy' ? 1 : -1) * Number(transaction.quantity || 0);
      quantity.set(transaction.asset_id, (quantity.get(transaction.asset_id) || 0) + signed);
      if (Number(transaction.unit_price) > 0) lastTradePrice.set(transaction.asset_id, Number(transaction.unit_price));
    }
  };

  const latestPrice = (assetId, date) => {
    const list = pricesByAsset.get(assetId) || [];
    let index = priceCursor.get(assetId) || 0;
    while (index < list.length && String(list[index].date) <= date) index += 1;
    priceCursor.set(assetId, index);
    return index ? list[index - 1] : null;
  };

  const latestCash = (slot, date) => {
    const list = cashBySlot.get(slot) || [];
    let index = cashCursor.get(slot) || 0;
    while (index < list.length && String(list[index].date) <= date) index += 1;
    cashCursor.set(slot, index);
    return index ? list[index - 1] : null;
  };

  for (const date of dates) {
    applyTransactions(date);
    let value = 0;
    let estimated = false;
    let complete = true;

    for (const asset of assets) {
      const held = quantity.get(asset.id) || 0;
      if (held <= 0) continue;
      const snapshot = latestPrice(asset.id, date);
      const unitPrice = snapshot ? Number(snapshot.price) : lastTradePrice.get(asset.id);
      if (!(unitPrice > 0)) { complete = false; continue; }
      if (!snapshot) estimated = true;
      // Dated conversion at the point's date. `convertRate` returns null when nothing was recorded on
      // or before that date, which is a gap to report, not an invitation to borrow a later rate.
      const rate = convertRate(rates, asset.currency, homeCurrency, date);
      if (rate == null) { complete = false; continue; }
      value += held * unitPrice * rate;
    }

    for (const slot of cashBySlot.keys()) {
      const balance = latestCash(slot, date);
      if (!balance) continue;
      const rate = convertRate(rates, balance.currency, homeCurrency, date);
      if (rate == null) { complete = false; continue; }
      value += Number(balance.balance) * rate;
    }

    result.push({ date, value, estimated, complete });
  }
  return result;
}

// Display metadata for a rendered window: the dates it covers, the change between its ends, and how
// much of it is not market data. Kept out of the component so the numbers can be tested.
export function historyStats(points = []) {
  const first = points[0] || null;
  const last = points.at(-1) || null;
  const change = periodReturn(points);
  return {
    first,
    last,
    change,
    changeValue: first && last ? Number(last.value) - Number(first.value) : null,
    // The first date a holding was valued at its purchase price, when the window contains one.
    estimatedFrom: points.find((point) => point.estimated)?.date || null,
    incomplete: points.filter((point) => point.complete === false).length,
    points: points.length,
  };
}
