// Currency conversion, with the rate list indexed once.
//
// The app supports four currencies, so all-pairs storage turns a small rate array into ~17k dated
// rows. Filtering that array for every holding, chart date and cash balance would be wasteful; the
// WeakMap below builds pair → date-sorted lists when the array identity changes and reuses them until
// the next refresh replaces the array.

const indexCache = new WeakMap();

const todayString = () => new Date().toISOString().slice(0, 10);
const compareDesc = (left, right) => String(right.date).localeCompare(String(left.date)) || Number(right.id ?? 0) - Number(left.id ?? 0);

function rateIndex(rates) {
  const source = Array.isArray(rates) ? rates : [];
  const cached = indexCache.get(source);
  if (cached) return cached;
  const byPair = new Map();
  const manualByPair = new Map();
  for (const rate of source) {
    if (!rate || typeof rate !== 'object' || !rate.base || !rate.quote) continue;
    const pair = `${rate.base}|${rate.quote}`;
    if (!byPair.has(pair)) byPair.set(pair, []);
    byPair.get(pair).push(rate);
    if (rate.source === 'Manual') {
      if (!manualByPair.has(pair)) manualByPair.set(pair, []);
      manualByPair.get(pair).push(rate);
    }
  }
  for (const rows of byPair.values()) rows.sort(compareDesc);
  for (const rows of manualByPair.values()) rows.sort(compareDesc);
  const index = { byPair, manualByPair };
  indexCache.set(source, index);
  return index;
}

// Rows are newest first, so the first row on or before `asOf` is the applicable one.
function latestOnOrBefore(rows, asOf) {
  if (!rows?.length) return null;
  let low = 0;
  let high = rows.length - 1;
  let found = null;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (String(rows[middle].date) <= asOf) {
      found = rows[middle];
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  return found;
}

export function convertRate(rates, from, to, asOf = todayString()) {
  if (from === to) return 1;
  const date = asOf || todayString();
  const index = rateIndex(rates);
  const pair = (base, quote) => index.byPair.get(`${base}|${quote}`);
  const manualPair = (base, quote) => index.manualByPair.get(`${base}|${quote}`);

  // A manual rate is a decision, not a provider snapshot. If one exists in either direction, it wins
  // over a provider row in the opposite direction (which all-pairs syncing would otherwise create).
  const manualDirect = latestOnOrBefore(manualPair(from, to), date);
  if (manualDirect) return Number(manualDirect.rate);
  const manualInverse = latestOnOrBefore(manualPair(to, from), date);
  if (manualInverse) return 1 / Number(manualInverse.rate);

  const direct = latestOnOrBefore(pair(from, to), date);
  if (direct) return Number(direct.rate);
  const inverse = latestOnOrBefore(pair(to, from), date);
  if (inverse) return 1 / Number(inverse.rate);

  const eurRate = (currency) => latestOnOrBefore(pair('EUR', currency), date)?.rate;
  if (from !== 'EUR' && to !== 'EUR') {
    const source = eurRate(from);
    const target = eurRate(to);
    if (source && target) return Number(target) / Number(source);
  }
  if (to === 'EUR' && eurRate(from)) return 1 / Number(eurRate(from));
  if (from === 'EUR' && eurRate(to)) return Number(eurRate(to));
  return null;
}
