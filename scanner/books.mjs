// Edgeview: saves OANDA's order book and position book for the watchlist to the edgeview-data branch (edgeview-books.json),
// so the app can read them even when the phone's browser is not allowed to call OANDA directly. Runs after the hourly scanner.
// Secrets: OANDA_TOKEN (free from an OANDA demo account), optional OANDA_ENV (practice or live). GITHUB_TOKEN is provided by Actions.
// These are public market statistics about OANDA's clients, not account data, so the file is not encrypted.
import { readFileSync, existsSync } from 'node:fs';
const env = process.env, TOK = env.OANDA_TOKEN || '', GH = env.GITHUB_TOKEN || '', REPO = env.GITHUB_REPOSITORY || '', BR = 'edgeview-data', PATH = 'edgeview-books.json';
const HOST = (env.OANDA_ENV || 'practice') === 'live' ? 'api-fxtrade.oanda.com' : 'api-fxpractice.oanda.com';
const OK = /^(EUR|GBP|AUD|NZD|USD|XAU|XAG)_(USD|JPY|CHF|CAD|GBP|AUD|NZD)$/;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
export function trim(book, pct = 0.03) {            // keep the buckets within 3% of the price so the file stays small
  if (!book || !book.buckets) return null; const px = +book.price;
  return { time: book.time, price: book.price, bucketWidth: book.bucketWidth, buckets: book.buckets.filter(b => Math.abs(+b.price - px) <= px * pct) };
}
async function run() {
  if (!TOK) { log('no OANDA_TOKEN secret: skipping the order books'); return; }
  const W = existsSync('watchlist.json') ? JSON.parse(readFileSync('watchlist.json', 'utf8')) : { pairs: [] };
  const inst = [...new Set((W.pairs || []).map(s => String(s).toUpperCase().replace('/', '_')).filter(s => OK.test(s)))].slice(0, 12);
  if (!inst.length) { log('no watchlist pair has an OANDA book'); return; }
  const books = {};
  for (const i of inst) {
    try {
      const [o, p] = await Promise.all(['orderBook', 'positionBook'].map(b => fetch(`https://${HOST}/v3/instruments/${i}/${b}`, { headers: { Authorization: 'Bearer ' + TOK } }).then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.errorMessage || r.status); return j; })));
      books[i] = { ob: trim(o.orderBook), pb: trim(p.positionBook) }; log(i, 'ok');
    } catch (e) { log(i, 'failed:', e.message || e); }
  }
  if (!Object.keys(books).length) return;
  if (!GH || !REPO) { log('no GITHUB_TOKEN: not saved'); return; }
  const api = `https://api.github.com/repos/${REPO}/contents/${PATH}`, H = { Authorization: 'Bearer ' + GH, Accept: 'application/vnd.github+json' };
  const cur = await fetch(`${api}?ref=${BR}`, { headers: H }), sha = cur.ok ? (await cur.json()).sha : undefined;
  if (!cur.ok && cur.status !== 404) { log('cannot read the data branch:', cur.status); return; }
  const body = { message: 'order books', branch: BR, content: Buffer.from(JSON.stringify({ at: new Date().toISOString(), host: HOST, books })).toString('base64'), ...(sha ? { sha } : {}) };
  const r = await fetch(api, { method: 'PUT', headers: H, body: JSON.stringify(body) });
  log(r.ok ? `saved ${Object.keys(books).length} books` : `save failed ${r.status} (open the app once with backup turned on so the ${BR} branch exists)`);
}
if (import.meta.url === `file://${process.argv[1]}`) await run();
