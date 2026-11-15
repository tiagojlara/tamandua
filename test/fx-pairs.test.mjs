import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { convertRate } from '../src/client/rates.mjs';

const require = createRequire(import.meta.url);
const { openDatabase } = require('../src/db');

test('a manual rate wins over a provider row in the opposite direction', () => {
  const rates = [
    { date: '2024-01-03', base: 'USD', quote: 'EUR', rate: 0.9, source: 'Frankfurter' },
    { date: '2024-01-03', base: 'EUR', quote: 'USD', rate: 2, source: 'Manual' },
  ];
  assert.equal(convertRate(rates, 'USD', 'EUR', '2024-01-03'), 0.5);
});

test('opening an existing database backfills all pairs and manual inverses', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tamandua-fx-pairs-'));
  try {
    let db = openDatabase(dataDir);
    const insert = db.prepare("INSERT INTO fx_rates(date, base, quote, rate, source) VALUES(?, ?, ?, ?, ?)");
    insert.run('2024-01-03', 'EUR', 'SEK', 11, 'Frankfurter');
    insert.run('2024-01-03', 'EUR', 'USD', 1.1, 'Frankfurter');
    insert.run('2024-01-03', 'EUR', 'BRL', 5.5, 'Frankfurter');
    insert.run('2024-01-03', 'USD', 'BRL', 6, 'Manual');
    db.close();

    db = openDatabase(dataDir);
    const rows = db.prepare('SELECT * FROM fx_rates WHERE date = ?').all('2024-01-03');
    assert.equal(rows.length, 12, 'every directed pair is present');
    const usdSek = rows.find((row) => row.base === 'USD' && row.quote === 'SEK');
    assert.ok(Math.abs(usdSek.rate - 11 / 1.1) < 1e-12);
    const brlUsd = rows.find((row) => row.base === 'BRL' && row.quote === 'USD');
    assert.equal(brlUsd.source, 'Manual', 'the manual inverse replaces the provider cross');
    assert.ok(Math.abs(brlUsd.rate - 1 / 6) < 1e-12);
    db.close();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
