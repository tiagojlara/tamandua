import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cashFlowSnapshot, dividendSnapshot, latestRecordedMonth, latestSnapshot,
  netWorthSnapshot, portfolioByAccount, portfolioMix,
} from '../src/client/overview.mjs';
import { convertRate } from '../src/client/rates.mjs';

const close = (actual, expected, epsilon = 1e-9) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} !== ${expected}`);

const rates = [
  { id: 1, date: '2024-01-02', base: 'EUR', quote: 'USD', rate: 1.1 },
  { id: 2, date: '2024-01-02', base: 'EUR', quote: 'BRL', rate: 5 },
  // A much later rate: nothing in this file may pick it up for a January snapshot.
  { id: 3, date: '2024-06-01', base: 'EUR', quote: 'USD', rate: 2 },
  { id: 4, date: '2024-06-01', base: 'EUR', quote: 'BRL', rate: 6 },
];

const holdings = [
  { id: 1, name: 'Coca Cola', currency: 'USD', quantity: 10, cost_basis: 100, current_value: 110, price_date: '2024-01-02', is_cash_balance: false },
  { id: 2, name: 'Cash · Broker', currency: 'BRL', quantity: 500, cost_basis: 500, current_value: 500, price_date: '2024-01-02', is_cash_balance: true, account_id: 2 },
];

test('portfolio mix converts each holding at its own snapshot date', () => {
  const mix = portfolioMix({ holdings, rates, homeCurrency: 'EUR' });
  // USD 110 at the January rate, BRL 500 at the January rate — not at the June rates.
  close(mix.total, 110 / 1.1 + 500 / 5);
  close(mix.investments, 110 / 1.1);
  close(mix.cash, 500 / 5);
  assert.equal(mix.complete, true);
  assert.equal(mix.currencies.length, 2);
  assert.equal(mix.currencies[0].currency, 'USD');
  close(mix.currencies[0].nativeValue, 110);
  close(mix.currencies[0].homeValue, 100);
  close(mix.currencies[0].share, 100 / 200 * 100);
  close(mix.investmentShare + mix.cashShare, 100);
  // The same total the cards use, through the same helper.
  close(mix.total, 100 + 100);
});

test('portfolio mix reports an incomplete total instead of dropping a position silently', () => {
  const mix = portfolioMix({
    holdings: [...holdings, { id: 3, name: 'No rate', currency: 'JPY', quantity: 1, current_value: 1000, price_date: '2024-01-02' }],
    rates,
    homeCurrency: 'EUR',
  });
  assert.equal(mix.complete, false);
  close(mix.total, 200);
});

test('portfolio by account keeps the rows equal to the portfolio total', () => {
  const rows = portfolioByAccount({
    holdings: [
      { id: 1, name: 'Fund', currency: 'USD', quantity: 10, current_value: 110, price_date: '2024-01-02', is_cash_balance: false },
      holdings[1],
    ],
    accounts: [{ id: 1, name: 'Broker' }, { id: 2, name: 'Bank' }],
    transactions: [
      { id: 1, asset_id: 1, account_id: 1, kind: 'buy', date: '2024-01-02', quantity: 6 },
      { id: 2, asset_id: 1, account_id: 2, kind: 'buy', date: '2024-01-03', quantity: 4 },
    ],
    rates,
    homeCurrency: 'EUR',
  });
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  close(total, 100 + 100);
  close(rows.reduce((sum, row) => sum + row.share, 0), 100);
  const broker = rows.find((row) => row.name === 'Broker' && row.currency === 'USD');
  close(broker.value, 100 * 0.6);
  const bankFund = rows.find((row) => row.name === 'Bank' && row.currency === 'USD');
  close(bankFund.value, 100 * 0.4);
  const bankCash = rows.find((row) => row.name === 'Bank' && row.currency === 'BRL');
  close(bankCash.value, 100);
});

test('latestSnapshot picks the newest record for one parent', () => {
  const rows = [
    { id: 1, physical_asset_id: 7, date: '2024-01-01', value: 10 },
    { id: 2, physical_asset_id: 7, date: '2024-03-01', value: 30 },
    { id: 3, physical_asset_id: 8, date: '2024-04-01', value: 99 },
  ];
  assert.equal(latestSnapshot(rows, 'physical_asset_id', 7).value, 30);
  assert.equal(latestSnapshot(rows, 'physical_asset_id', 9), null);
  assert.equal(latestSnapshot([], 'physical_asset_id', 7), null);
});

test('net worth values physical assets and loans at their own dates', () => {
  const snapshot = netWorthSnapshot({
    physicalAssets: [{ id: 1, name: 'Flat', currency: 'USD' }, { id: 2, name: 'Car', currency: 'BRL' }],
    physicalValuations: [
      { id: 1, physical_asset_id: 1, date: '2024-01-02', value: 220 },
      { id: 2, physical_asset_id: 1, date: '2023-01-02', value: 1 },
      { id: 3, physical_asset_id: 2, date: '2024-01-02', value: 5000 },
    ],
    liabilities: [{ id: 1, name: 'Mortgage', currency: 'USD' }],
    liabilityBalances: [{ id: 1, liability_id: 1, date: '2024-01-02', balance: 55 }],
    rates,
    homeCurrency: 'EUR',
  });
  close(snapshot.physical, 220 / 1.1 + 5000 / 5);
  close(snapshot.debt, 55 / 1.1);
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.valuedAssets, 2);
  assert.equal(snapshot.recordedLoans, 1);
});

test('net worth is incomplete when a recorded amount has no dated rate', () => {
  const snapshot = netWorthSnapshot({
    physicalAssets: [{ id: 1, name: 'Flat', currency: 'JPY' }],
    physicalValuations: [{ id: 1, physical_asset_id: 1, date: '2024-01-02', value: 220 }],
    rates,
    homeCurrency: 'EUR',
  });
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.physical, 0);
});

test('cash flow defaults to the newest month with a record', () => {
  const entries = [
    { id: 1, date: '2026-09-15', kind: 'income', amount: 1000, currency: 'SEK', category_id: 1, account_id: 1 },
    { id: 2, date: '2026-10-02', kind: 'expense', amount: 300, currency: 'SEK', category_id: 2, account_id: 1 },
    { id: 3, date: '2026-10-20', kind: 'expense', amount: 200, currency: 'SEK', category_id: 2, account_id: 1 },
  ];
  const categories = [{ id: 1, name: 'Salary', kind: 'income' }, { id: 2, name: 'Food', kind: 'expense' }];
  assert.equal(latestRecordedMonth(entries, '2026-11-15'), '2026-10');
  assert.equal(latestRecordedMonth([], '2026-11-15'), '2026-11');

  const snapshot = cashFlowSnapshot({ entries, categories, fallbackMonth: '2026-11-15' });
  assert.equal(snapshot.month, '2026-10');
  assert.deepEqual(snapshot.currencies, ['SEK']);
  assert.equal(snapshot.totals.SEK.expense, 500);
  assert.equal(snapshot.totals.SEK.income, 0);
  assert.equal(snapshot.totals.SEK.net, -500);
  assert.equal(snapshot.spending.length, 1);
  assert.equal(snapshot.spending[0].name, 'Food');
  assert.equal(snapshot.spending[0].total, 500);
});

test('dividend snapshot separates the trailing window from the full history', () => {
  const dividends = [
    { id: 1, date: '2025-01-10', amount: 100, currency: 'USD' },
    { id: 2, date: '2026-10-10', amount: 40, currency: 'USD' },
    { id: 3, date: '2026-11-01', amount: 60, currency: 'SEK' },
  ];
  const snapshot = dividendSnapshot({ dividends, asOf: '2026-11-15' }, 12);
  assert.equal(snapshot.fromMonth, '2025-12');
  assert.equal(snapshot.latest, '2026-11-01');
  const usd = snapshot.currencies.find((row) => row.currency === 'USD');
  assert.equal(usd.allTime, 140);
  assert.equal(usd.window, 40);
  assert.equal(usd.payments, 2);
  const sek = snapshot.currencies.find((row) => row.currency === 'SEK');
  assert.equal(sek.window, 60);
  assert.equal(snapshot.currencies[0].currency, 'USD');
});

test('the mix uses the same rate helper the rest of the client uses', () => {
  close(convertRate(rates, 'USD', 'EUR', '2024-01-02'), 1 / 1.1);
  const mix = portfolioMix({ holdings, rates, homeCurrency: 'EUR' });
  close(mix.total, 110 / 1.1 + 500 / 5);
});
