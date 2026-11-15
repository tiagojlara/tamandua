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

export function portfolioHistory({ assets, transactions, prices, dividends, cash_balances = [], rates, homeCurrency }) {
  const dates = new Set([...transactions, ...prices, ...dividends, ...cash_balances].map((row) => row.date).filter(Boolean));
  const orderedTransactions = [...transactions].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  const orderedPrices = [...prices].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  const result = [];
  for (const date of [...dates].sort()) {
    let value = 0;
    let complete = true;
    for (const asset of assets) {
      let quantity = 0;
      for (const transaction of orderedTransactions) {
        if (transaction.asset_id !== asset.id || transaction.date > date) continue;
        if (transaction.kind === 'buy') quantity += Number(transaction.quantity || 0);
        if (transaction.kind === 'sell') quantity -= Number(transaction.quantity || 0);
      }
      if (quantity <= 0) continue;
      const price = [...orderedPrices].reverse().find((row) => row.asset_id === asset.id && row.date <= date);
      if (!price) { complete = false; break; }
      const fx = convertRate(rates, asset.currency, homeCurrency, date);
      if (fx == null) { complete = false; break; }
      value += quantity * Number(price.price) * fx;
    }
    if (complete) {
      const cashSlots = new Map();
      for (const balance of cash_balances) {
        if (balance.date > date) continue;
        const slot = `${balance.account_id}:${balance.asset_id ?? 'account'}`;
        const previous = cashSlots.get(slot);
        if (!previous || balance.date > previous.date || (balance.date === previous.date && balance.id > previous.id)) cashSlots.set(slot, balance);
      }
      for (const balance of cashSlots.values()) {
        const fx = convertRate(rates, balance.currency, homeCurrency, date);
        if (fx == null) { complete = false; break; }
        value += Number(balance.balance) * fx;
      }
    }
    if (complete) result.push({ date, value });
  }
  return result;
}
