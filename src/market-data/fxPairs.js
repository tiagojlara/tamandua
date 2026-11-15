// FX pairs for the currencies the app supports.
//
// Frankfurter is queried with EUR as the base and one quote per other currency. That is enough to
// derive every directed pair, and storing them all is what makes `USD → SEK` (and its inverse) a
// normal dated row for the UI, the assistant and backups — not an implicit cross-rate that only
// exists inside one helper. Manual rows stay sacred: provider syncs never overwrite them.

const SUPPORTED_FX = ['EUR', 'SEK', 'USD', 'BRL'];

function normalizeCurrency(value) {
  return String(value || '').trim().toUpperCase();
}

// Raw provider rows (EUR base) → every directed pair among the supported currencies for each date.
// Dates with only some quotes produce only the pairs those quotes can support.
function expandFxRates(rows, currencies = SUPPORTED_FX) {
  const byDate = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const date = String(row?.date || '');
    const base = normalizeCurrency(row?.base);
    const quote = normalizeCurrency(row?.quote);
    const rate = Number(row?.rate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || base !== 'EUR' || !currencies.includes(quote) || !(rate > 0)) continue;
    const eurRates = byDate.get(date) || { EUR: 1 };
    eurRates[quote] = rate;
    byDate.set(date, eurRates);
  }

  const expanded = [];
  for (const [date, eurRates] of byDate) {
    for (const base of currencies) {
      for (const quote of currencies) {
        if (base === quote) continue;
        const baseRate = eurRates[base];
        const quoteRate = eurRates[quote];
        if (!(baseRate > 0) || !(quoteRate > 0)) continue;
        expanded.push({ date, base, quote, rate: quoteRate / baseRate });
      }
    }
  }
  return expanded.sort((left, right) => left.date.localeCompare(right.date) || left.base.localeCompare(right.base) || left.quote.localeCompare(right.quote));
}

function validateManualFxRate(data) {
  const date = String(data?.date || '');
  const base = normalizeCurrency(data?.base);
  const quote = normalizeCurrency(data?.quote);
  const rate = Number(data?.rate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return 'Enter a valid date (YYYY-MM-DD).';
  if (!SUPPORTED_FX.includes(base) || !SUPPORTED_FX.includes(quote)) return `Choose currencies from ${SUPPORTED_FX.join(', ')}.`;
  if (base === quote) return 'Choose different currencies and enter a positive rate.';
  if (!(rate > 0)) return 'Enter a positive rate.';
  return null;
}

// A manual rate is one decision, so both directions are stored as Manual. Without the inverse, a
// provider row for the opposite direction would win after the next sync and quietly contradict what
// the person typed.
function saveManualFxRate(db, data) {
  const date = String(data.date);
  const base = normalizeCurrency(data.base);
  const quote = normalizeCurrency(data.quote);
  const rate = Number(data.rate);
  const upsert = db.prepare(`INSERT INTO fx_rates(date, base, quote, rate, source) VALUES(@date, @base, @quote, @rate, 'Manual')
    ON CONFLICT(date, base, quote) DO UPDATE SET rate = excluded.rate, source = 'Manual'`);
  db.transaction(() => {
    upsert.run({ date, base, quote, rate });
    upsert.run({ date, base: quote, quote: base, rate: 1 / rate });
  })();
  return db.prepare('SELECT * FROM fx_rates WHERE date = ? AND base = ? AND quote = ?').get(date, base, quote);
}

// Repairs databases written before all-pairs storage existed. It derives missing provider pairs from
// the EUR rows already on disk, and gives every legacy Manual row its inverse. Existing rows are left
// alone: a sync updates provider values, and nothing may overwrite a manual one.
function backfillFxPairs(db) {
  const quotes = SUPPORTED_FX.filter((currency) => currency !== 'EUR');
  const eurRows = db.prepare(`SELECT date, base, quote, rate, source FROM fx_rates
    WHERE base = 'EUR' AND source IN ('Frankfurter', 'Frankfurter · ECB')
      AND quote IN (${quotes.map(() => '?').join(',')})
    ORDER BY date, id`).all(...quotes);
  const sourceByDate = new Map();
  for (const row of eurRows) sourceByDate.set(row.date, row.source || 'Frankfurter');
  const insertProvider = db.prepare(`INSERT INTO fx_rates(date, base, quote, rate, source) VALUES(@date, @base, @quote, @rate, @source)
    ON CONFLICT(date, base, quote) DO NOTHING`);
  const insertManual = db.prepare(`INSERT INTO fx_rates(date, base, quote, rate, source) VALUES(@date, @base, @quote, @rate, 'Manual')
    ON CONFLICT(date, base, quote) DO UPDATE SET rate = excluded.rate, source = 'Manual' WHERE fx_rates.source != 'Manual'`);
  let inserted = 0;
  db.transaction(() => {
    for (const row of expandFxRates(eurRows)) {
      inserted += insertProvider.run({ ...row, source: sourceByDate.get(row.date) || 'Frankfurter' }).changes;
    }
    const manualRows = db.prepare("SELECT date, base, quote, rate FROM fx_rates WHERE source = 'Manual'").all();
    for (const row of manualRows) {
      if (!SUPPORTED_FX.includes(row.base) || !SUPPORTED_FX.includes(row.quote) || row.base === row.quote || !(Number(row.rate) > 0)) continue;
      inserted += insertManual.run({ date: row.date, base: row.quote, quote: row.base, rate: 1 / Number(row.rate) }).changes;
    }
  })();
  return inserted;
}

module.exports = { SUPPORTED_FX, expandFxRates, validateManualFxRate, saveManualFxRate, backfillFxPairs };
