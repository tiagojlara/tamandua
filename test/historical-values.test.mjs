import test from 'node:test';
import assert from 'node:assert/strict';
import { historyStats, periodReturn, portfolioHistory, roiPercent } from '../src/client/history.mjs';

const close = (actual, expected, epsilon = 1e-10) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} !== ${expected}`);

const base = {
  assets: [{ id: 1, currency: 'USD' }],
  transactions: [{ id: 1, asset_id: 1, kind: 'buy', date: '2024-01-02', quantity: 2, unit_price: 10 }],
  prices: [
    { id: 1, asset_id: 1, date: '2024-01-02', price: 10 },
    { id: 2, asset_id: 1, date: '2024-01-03', price: 12 },
  ],
  dividends: [],
  rates: [
    { id: 1, date: '2024-01-02', base: 'EUR', quote: 'USD', rate: 1.1 },
    { id: 2, date: '2024-01-03', base: 'EUR', quote: 'USD', rate: 1.2 },
  ],
  homeCurrency: 'EUR',
};

test('historical portfolio values use the FX rate available on each valuation date', () => {
  assert.deepEqual(portfolioHistory(base), [
    { date: '2024-01-02', value: 20 / 1.1, estimated: false, complete: true },
    { date: '2024-01-03', value: 24 / 1.2, estimated: false, complete: true },
  ]);
});

test('a point uses its own date\'s rate, never the newest rate stored', () => {
  // A later rate exists (June), so borrowing the latest stored rate would value January at 10 instead
  // of 18.18. This is the regression the dashboard chart was hiding: a rate dated later than the point
  // must not be used, and a rate for a date with no record must not create a point.
  const data = {
    ...base,
    rates: [
      { id: 1, date: '2024-01-02', base: 'EUR', quote: 'USD', rate: 1.1 },
      { id: 2, date: '2024-01-03', base: 'EUR', quote: 'USD', rate: 1.2 },
      { id: 3, date: '2024-06-01', base: 'EUR', quote: 'USD', rate: 2 },
    ],
  };
  const history = portfolioHistory(data);
  assert.deepEqual(history.map((point) => point.date), ['2024-01-02', '2024-01-03']);
  close(history[0].value, 20 / 1.1);
  close(history[1].value, 24 / 1.2);
});

test('history omits dates where an open holding has neither a price nor a purchase price', () => {
  const data = {
    ...base,
    transactions: [{ id: 1, asset_id: 1, kind: 'buy', date: '2024-01-02', quantity: 2 }],
    prices: [{ id: 1, asset_id: 1, date: '2024-01-03', price: 12 }],
  };
  const history = portfolioHistory(data);
  assert.deepEqual(history.map((point) => point.date), ['2024-01-02', '2024-01-03']);
  // The first point cannot value the holding at all, so it is empty rather than dropped: dropping it
  // would move the start of the series whenever a new holding appears.
  assert.equal(history[0].value, 0);
  assert.equal(history[0].complete, false);
  close(history[1].value, 24 / 1.2);
});

test('a holding with no price yet is valued at its purchase price instead of truncating the series', () => {
  // The purchase happened in January and the first manual price only exists in March. Before March the
  // position is valued at cost and the point is flagged `estimated`, so a one-year window still shows
  // a one-year line.
  const data = {
    ...base,
    prices: [{ id: 1, asset_id: 1, date: '2024-03-01', price: 15 }],
    rates: [
      { id: 1, date: '2024-01-02', base: 'EUR', quote: 'USD', rate: 1.1 },
      { id: 2, date: '2024-03-01', base: 'EUR', quote: 'USD', rate: 1.5 },
    ],
  };
  const history = portfolioHistory(data);
  assert.deepEqual(history.map((point) => point.date), ['2024-01-02', '2024-03-01']);
  close(history[0].value, 20 / 1.1);
  assert.equal(history[0].estimated, true);
  assert.equal(history[0].complete, true);
  close(history[1].value, 30 / 1.5);
  assert.equal(history[1].estimated, false);
});

test('a point with no dated rate is flagged and never falls back to a later rate', () => {
  const data = {
    ...base,
    rates: [{ id: 2, date: '2024-01-03', base: 'EUR', quote: 'USD', rate: 1.2 }],
  };
  const history = portfolioHistory(data);
  assert.deepEqual(history.map((point) => point.date), ['2024-01-02', '2024-01-03']);
  assert.deepEqual(history[0], { date: '2024-01-02', value: 0, estimated: false, complete: false });
  close(history[1].value, 24 / 1.2);
  assert.equal(history[1].complete, true);
});

test('cash balance snapshots are valued in portfolio history without trades', () => {
  const data = {
    ...base,
    assets: [], transactions: [], prices: [], dividends: [], homeCurrency: 'USD',
    cash_balances: [
      { id: 1, account_id: 1, asset_id: null, date: '2024-01-02', balance: 100, currency: 'EUR' },
      { id: 2, account_id: 1, asset_id: null, date: '2024-01-03', balance: 125, currency: 'EUR' },
    ],
    rates: [
      { id: 1, date: '2024-01-02', base: 'EUR', quote: 'USD', rate: 1.1 },
      { id: 2, date: '2024-01-03', base: 'EUR', quote: 'USD', rate: 1.2 },
    ],
  };
  const history = portfolioHistory(data);
  assert.deepEqual(history.map((point) => point.date), ['2024-01-02', '2024-01-03']);
  close(history[0].value, 110);
  close(history[1].value, 150);
});

test('the newest point matches the current valuation of the same holdings', () => {
  // A dashboard shows one "portfolio value" figure and one history line. The last point of the line is
  // the same valuation, so the two numbers must agree instead of differing by one stale snapshot.
  const history = portfolioHistory(base);
  const last = history.at(-1);
  close(last.value, 2 * 12 / 1.2);
});

test('historyStats reports the window, its change and where the line stops being market data', () => {
  const points = [
    { date: '2024-01-02', value: 100, estimated: true, complete: true },
    { date: '2024-01-03', value: 0, estimated: false, complete: false },
    { date: '2024-01-04', value: 115, estimated: false, complete: true },
  ];
  const stats = historyStats(points);
  assert.equal(stats.first.date, '2024-01-02');
  assert.equal(stats.last.date, '2024-01-04');
  close(stats.change, 15);
  close(stats.changeValue, 15);
  assert.equal(stats.estimatedFrom, '2024-01-02');
  assert.equal(stats.incomplete, 1);
  assert.equal(stats.points, 3);
  assert.deepEqual(historyStats([]), { first: null, last: null, change: null, changeValue: null, estimatedFrom: null, incomplete: 0, points: 0 });
});

test('ROI and period return use transparent start/end value calculations', () => {
  assert.equal(roiPercent(120, 100), 20);
  assert.equal(roiPercent(0, 0), null);
  assert.ok(Math.abs(periodReturn([{ value: 100 }, { value: 115 }]) - 15) < 1e-10);
  assert.equal(periodReturn([{ value: 0 }, { value: 115 }]), null);
});
