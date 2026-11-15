const { SUPPORTED_FX } = require('./fxPairs');

async function fetchFxRates({ provider = 'frankfurter', from, to }) {
  const url = new URL('https://api.frankfurter.dev/v2/rates');
  url.searchParams.set('base', 'EUR');
  url.searchParams.set('quotes', SUPPORTED_FX.filter((currency) => currency !== 'EUR').join(','));
  url.searchParams.set('from', from);
  url.searchParams.set('to', to);
  if (provider === 'ecb') url.searchParams.set('providers', 'ecb');

  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) {
    const error = new Error(`Frankfurter returned HTTP ${response.status}`);
    error.status = 502;
    error.publicMessage = error.message;
    throw error;
  }
  let rows;
  try { rows = await response.json(); } catch { rows = null; }
  if (!Array.isArray(rows)) {
    const error = new Error('Unexpected response from Frankfurter');
    error.status = 502;
    error.publicMessage = error.message;
    throw error;
  }
  return rows;
}

module.exports = { fetchFxRates };
