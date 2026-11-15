import { getLanguage } from './i18n.js';
import { convertRate } from './rates.mjs';

export const currencies = ['EUR', 'SEK', 'USD', 'BRL'];
export const api = async (path, options = {}) => {
  const response = await fetch(`/api/${path}`, {
    headers: { 'Content-Type': 'application/json' }, ...options,
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); }
  catch {
    // An HTML body means the request never reached a matching API route — typically a
    // server process older than the UI. Say so instead of leaking a JSON parse error.
    throw new Error(response.status === 404
      ? 'The API server does not have this endpoint — it is probably older than the interface. Restart the server (npm run dev or npm start) and try again.'
      : `The server returned an unexpected response (HTTP ${response.status}).`);
  }
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
};
// Assistant endpoints are their own tree (/api/assistant/...), never the generic
// /api/:table CRUD surface, so nothing here can touch a financial record.
export const assistantApi = (path = '', options = {}) => api(`assistant/${path}`, options);

// No streaming helper lives here any more. The assistant's answer arrives over the CopilotKit endpoint
// (`/api/copilotkit`, components/TamanduaChat.jsx), which owns its own transport and event folding; the
// hand-rolled `POST /api/assistant/chat` reader that used to sit in this file was deleted with the route
// it served. What the client still needs from this module is the plain JSON surface: conversations,
// messages, disclosure, settings — `assistantApi` below.

// Server stamps are UTC instants (history.js and the summary rows both normalise them), so
// they need an explicit local rendering — a raw ISO string in the UI reads as a machine log.
export const stamp = (value, { time = true } = {}) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const locale = getLanguage() === 'pt-BR' ? 'pt-BR' : 'en';
  const formattedDay = date.toLocaleDateString(locale);
  return time ? `${formattedDay} ${date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}` : formattedDay;
};

export const money = (value, currency = 'EUR', digits = 0) => value == null ? '—' :
  new Intl.NumberFormat(getLanguage() === 'pt-BR' ? 'pt-BR' : 'en', { style: 'currency', currency, maximumFractionDigits: digits }).format(value);
export const today = () => new Date().toISOString().slice(0, 10);
export const escapeCsv = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;

export { convertRate };
export function getHomeValue(holdings, rates, homeCurrency) {
  let value = 0; let cost = 0; let complete = true;
  for (const holding of holdings) {
    if (!holding.quantity) continue;
    if (holding.current_value == null) { complete = false; continue; }
    const rate = convertRate(rates, holding.currency, homeCurrency, holding.price_date);
    if (rate == null) { complete = false; continue; }
    value += holding.current_value * rate;
    cost += holding.cost_basis * rate;
  }
  return { value, cost, complete };
}
