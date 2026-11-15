import { convertRate } from './rates.mjs';
import { roiPercent } from './history.mjs';
import { cashFlowTotals, categoryBreakdown, monthOf, shiftMonth } from './cashflow.mjs';

// Pure calculations behind the Overview dashboard. They live here, next to the other testable client
// helpers, because a dashboard is a set of definitions — what counts as "current value", how a share is
// computed, which month the cash-flow card shows — and those definitions must not be re-implemented
// inside JSX where nothing can check them.
//
// One rule runs through all of it: an amount is converted at the date of its own snapshot, through
// `convertRate`, and never with a hard-coded or "latest" rate. That keeps every panel consistent with
// the portfolio value on the cards, which uses the same rule.

// Newest row per parent, ties broken by id. Records are keyed by (parent, date), so this is simply the
// latest recorded valuation or balance.
export function latestSnapshot(rows = [], parentKey, id) {
  let latest = null;
  for (const row of rows) {
    if (row[parentKey] !== id) continue;
    if (!latest || String(row.date) > String(latest.date) || (row.date === latest.date && Number(row.id) > Number(latest.id))) latest = row;
  }
  return latest;
}

// Everything the dashboard needs from the holdings list, in the home currency: the total (identical to
// `getHomeValue`), the investment/cash split, and a per-holding and per-currency breakdown whose shares
// are taken from that same total.
export function portfolioMix({ holdings = [], rates, homeCurrency } = {}) {
  const byCurrency = new Map();
  const enriched = [];
  let total = 0;
  let investments = 0;
  let cash = 0;
  let investmentCost = 0;
  let complete = true;

  for (const holding of holdings) {
    if (!(Number(holding.quantity) > 0)) continue;
    if (holding.current_value == null) { complete = false; continue; }
    const rate = convertRate(rates, holding.currency, homeCurrency, holding.price_date);
    if (rate == null) { complete = false; continue; }
    const value = Number(holding.current_value) * rate;
    const cost = Number(holding.cost_basis || 0) * rate;
    total += value;
    if (holding.is_cash_balance) cash += value; else { investments += value; investmentCost += cost; }

    const row = byCurrency.get(holding.currency) || { currency: holding.currency, homeValue: 0, nativeValue: 0, cost: 0, positions: 0 };
    row.homeValue += value;
    row.nativeValue += Number(holding.current_value);
    row.cost += cost;
    row.positions += 1;
    byCurrency.set(holding.currency, row);

    enriched.push({
      id: holding.id,
      name: holding.name,
      ticker: holding.ticker,
      type: holding.type,
      currency: holding.currency,
      isCash: Boolean(holding.is_cash_balance),
      nativeValue: Number(holding.current_value),
      homeValue: value,
      priceDate: holding.price_date,
    });
  }

  const share = (value) => (total > 0 ? value / total * 100 : 0);
  return {
    total,
    investments,
    cash,
    investmentCost,
    investmentGain: investments - investmentCost,
    roi: roiPercent(investments, investmentCost),
    complete,
    currencies: [...byCurrency.values()]
      .map((row) => ({ ...row, share: share(row.homeValue) }))
      .sort((left, right) => right.homeValue - left.homeValue),
    holdings: enriched.map((row) => ({ ...row, share: share(row.homeValue) })).sort((left, right) => right.homeValue - left.homeValue),
    investmentShare: share(investments),
    cashShare: share(cash),
  };
}

// Value per account, in the home currency. A position held across several accounts is split in
// proportion to the quantity each account actually bought, normalised over the positive shares so the
// rows add up to the portfolio total instead of losing the part that was transferred or oversold.
export function portfolioByAccount({ holdings = [], accounts = [], transactions = [], rates, homeCurrency } = {}) {
  const rows = new Map();
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const add = (accountId, currency, value, nativeValue) => {
    const account = accountById.get(accountId);
    if (!account) return;
    const key = `${accountId}:${currency}`;
    const row = rows.get(key) || { id: key, name: account.name, currency, value: 0, nativeValue: 0 };
    row.value += value;
    row.nativeValue += nativeValue;
    rows.set(key, row);
  };

  for (const holding of holdings) {
    if (!(Number(holding.quantity) > 0) || holding.current_value == null) continue;
    const rate = convertRate(rates, holding.currency, homeCurrency, holding.price_date);
    if (rate == null) continue;
    const value = Number(holding.current_value) * rate;

    if (holding.is_cash_balance) { add(holding.account_id, holding.currency, value, Number(holding.current_value)); continue; }

    const byAccount = new Map();
    for (const transaction of transactions) {
      if (transaction.asset_id !== holding.id || !['buy', 'sell'].includes(transaction.kind)) continue;
      const signed = (transaction.kind === 'buy' ? 1 : -1) * Number(transaction.quantity || 0);
      byAccount.set(transaction.account_id, (byAccount.get(transaction.account_id) || 0) + signed);
    }
    const positive = [...byAccount.values()].reduce((sum, quantity) => sum + Math.max(0, quantity), 0);
    if (!(positive > 0)) continue;
    for (const [accountId, quantity] of byAccount) {
      if (quantity > 0) add(accountId, holding.currency, value * quantity / positive, Number(holding.current_value) * quantity / positive);
    }
  }

  const total = [...rows.values()].reduce((sum, row) => sum + row.value, 0);
  return [...rows.values()]
    .map((row) => ({ ...row, share: total > 0 ? row.value / total * 100 : 0 }))
    .sort((left, right) => right.value - left.value);
}

// Physical assets and loans at their newest recorded valuation, in the home currency. `complete` is
// false when a recorded amount has no dated exchange rate, so the page can say the net figure is partial
// rather than printing a number that silently dropped a position.
export function netWorthSnapshot({ physicalAssets = [], physicalValuations = [], liabilities = [], liabilityBalances = [], rates, homeCurrency } = {}) {
  const assets = physicalAssets.map((asset) => ({ ...asset, valuation: latestSnapshot(physicalValuations, 'physical_asset_id', asset.id) }));
  const loans = liabilities.map((loan) => ({ ...loan, snapshot: latestSnapshot(liabilityBalances, 'liability_id', loan.id) }));
  const convert = (amount, currency, date) => {
    const rate = convertRate(rates, currency, homeCurrency, date);
    return rate == null ? null : Number(amount) * rate;
  };

  let physical = 0;
  let debt = 0;
  let complete = true;
  for (const asset of assets) {
    if (!asset.valuation) continue;
    const value = convert(asset.valuation.value, asset.currency, asset.valuation.date);
    if (value == null) { complete = false; continue; }
    physical += value;
  }
  for (const loan of loans) {
    if (!loan.snapshot) continue;
    const value = convert(loan.snapshot.balance, loan.currency, loan.snapshot.date);
    if (value == null) { complete = false; continue; }
    debt += value;
  }
  return {
    assets,
    loans,
    physical,
    debt,
    complete,
    valuedAssets: assets.filter((asset) => asset.valuation).length,
    recordedLoans: loans.filter((loan) => loan.snapshot).length,
  };
}

// Cash flow for one month, per currency. The month defaults to the newest month with a record, because a
// card that says "this month" and shows nothing for the first two weeks of a month reads as a bug.
export function latestRecordedMonth(entries = [], fallback = '') {
  let latest = '';
  for (const entry of entries) {
    const month = monthOf(entry);
    if (month > latest) latest = month;
  }
  return latest || String(fallback).slice(0, 7);
}

export function cashFlowSnapshot({ entries = [], categories = [], month, fallbackMonth = '' } = {}) {
  const selected = month || latestRecordedMonth(entries, fallbackMonth);
  const inMonth = entries.filter((entry) => monthOf(entry) === selected);
  const totals = cashFlowTotals(inMonth);
  return {
    month: selected,
    entries: inMonth,
    totals,
    spending: categoryBreakdown(inMonth, categories, 'expense'),
    income: categoryBreakdown(inMonth, categories, 'income'),
    currencies: Object.keys(totals).sort(),
  };
}

// Dividend income by currency: everything recorded, and the part inside the trailing window. `asOf` is
// passed in so tests do not depend on the clock.
export function dividendSnapshot({ dividends = [], asOf } = {}, months = 12) {
  const today = String(asOf || new Date().toISOString().slice(0, 10));
  const fromMonth = shiftMonth(today.slice(0, 7), -(months - 1));
  const byCurrency = new Map();
  for (const payment of dividends) {
    const row = byCurrency.get(payment.currency) || { currency: payment.currency, allTime: 0, window: 0, payments: 0, latest: '' };
    row.allTime += Number(payment.amount);
    row.payments += 1;
    if (String(payment.date).slice(0, 7) >= fromMonth && String(payment.date) <= today) row.window += Number(payment.amount);
    if (String(payment.date) > row.latest) row.latest = payment.date;
    byCurrency.set(payment.currency, row);
  }
  return {
    months,
    fromMonth,
    currencies: [...byCurrency.values()].sort((left, right) => right.allTime - left.allTime),
    latest: [...byCurrency.values()].reduce((latest, row) => (row.latest > latest ? row.latest : latest), ''),
  };
}
