// Edgeview background scanner (v33). Runs on GitHub Actions every hour (see .github/workflows/scanner.yml).
// It does what the app's robot does while the app is open, and sends alerts to Telegram:
//   * at each session open (Sydney, Tokyo, London, New York): Claude Haiku screens every watchlist pair
//   * every hour: early-move detection on the 15-minute and 1-hour candles that closed in the last hour,
//     with strong signals confirmed by Haiku before you are alerted.
// Secrets: ANTHROPIC_API_KEY, TWELVE_DATA_KEY (gold and forex), TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.
// The watchlist comes from watchlist.json (the app's "Send watchlist to the background scanner" button writes it).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const D = require('../detect.js');

const env = process.env, now = +env.SCAN_NOW || Date.now();   // SCAN_NOW only for tests
const AK = env.ANTHROPIC_API_KEY || '', TK = env.TWELVE_DATA_KEY || '', TG = env.TELEGRAM_BOT_TOKEN || '', CHAT = env.TELEGRAM_CHAT_ID || '';
const STATE = '.scanner-state.json';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isCrypto = s => /^(BTC|ETH|SOL|XRP|BNB|ADA|DOGE|AVAX|DOT|LINK|LTC|TRX|TON|MATIC|SHIB|PEPE|SUI|APT|ARB|OP|NEAR|ATOM)\b/i.test(String(s).replace('/', ' '));
const pxDec = x => { const a = Math.abs(+x); return a >= 1000 ? 2 : a >= 20 ? 3 : a >= 0.1 ? 5 : a >= 0.001 ? 6 : 8; };
const f2 = x => x == null || isNaN(x) ? 'n/a' : Number(x).toFixed(pxDec(x));

const W = existsSync('watchlist.json') ? JSON.parse(readFileSync('watchlist.json', 'utf8')) : { pairs: ['XAU/USD'] };
const pairs = (W.pairs || []).slice(0, 12), minScore = +W.minScore || 60, model = W.model || 'claude-haiku-5-5';
let S = { alerts: [], sessions: {}, sig: [] };
try { if (existsSync(STATE)) S = { ...S, ...JSON.parse(readFileSync(STATE, 'utf8')) }; } catch (e) { }
S.alerts = (S.alerts || []).filter(a => now - a.t < 2 * 864e5);
S.sig = (S.sig || []).filter(x => now - x.seen < 120 * 864e5).slice(0, 600);   // every signal seen, scored for follow-through once its window has passed
const recent = (sym, side) => S.alerts.some(a => a.sym === sym && a.side === side && now - a.t < 4 * 36e5);

// markets: forex and gold are shut from Friday 21:00 UTC to Sunday 21:00 UTC; crypto never closes
function fxOpen(t) { const d = new Date(t), w = d.getUTCDay(), h = d.getUTCHours(); return !(w === 6 || (w === 5 && h >= 21) || (w === 0 && h < 21)); }

let lastTd = 0;
async function bars(sym, tf, n) {
  const ms = tf === '15M' ? 9e5 : 36e5;
  let out;
  if (isCrypto(sym) && !TK) {
    const pair = sym.toUpperCase().replace('/', '').replace(/USD$/, 'USDT');
    const r = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${pair}&interval=${tf === '15M' ? '15m' : '1h'}&limit=${n}`);
    if (!r.ok) throw new Error('Binance ' + r.status);
    out = (await r.json()).map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] }));
  } else {
    if (!TK) throw new Error('needs TWELVE_DATA_KEY');
    const w = lastTd + 8000 - Date.now(); if (w > 0) await sleep(w); lastTd = Date.now();   // free plan: 8 calls a minute
    const r = await fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=${tf === '15M' ? '15min' : '1h'}&outputsize=${n}&timezone=UTC&apikey=${TK}`);
    const j = await r.json();
    if (!j || j.status === 'error' || !j.values) throw new Error('Twelve Data: ' + (j && j.message || r.status));
    out = j.values.map(x => ({ t: Date.parse(x.datetime.replace(' ', 'T') + (x.datetime.length > 10 ? 'Z' : 'T00:00:00Z')), o: +x.open, h: +x.high, l: +x.low, c: +x.close })).reverse();
  }
  return { closed: out.filter(b => b.t + ms <= now), last: out[out.length - 1] };
}

const SCREEN_SYS = `You are a fast market screener for a discretionary trader in forex, gold and crypto. You get compact candle data for one instrument on 4H, 1H and 15M, and any early-move signals found in code (stop sweeps, changes of character, squeeze breakouts, momentum candles), each with a score and how far price has already moved from the origin in ATRs.
Decide if there is a trade worth a full analysis now or in the next few hours. Favour the start of a move: a sweep of a high or low that reverses, a change of character after a trend, a squeeze breaking out from a level, or a pullback to a key level inside a clear trend. Be sceptical of moves already more than about 2 ATR from their origin, of signals against the 4H trend without a clear level, and of thin data. Most of the time the right answer is "no" or "watch".
Reply with ONLY one JSON object and nothing else:
{"opportunity":"yes|watch|no","direction":"BUY|SELL|NONE","quality":1,"setup":"a few words","trigger":"what must happen next, with the price","invalidation":0,"why":"one or two short sentences"}
quality is 1 to 5 (5 = textbook). invalidation is the price that proves the idea wrong, or null. Use exact prices from the data.`;
async function haiku(user) {
  if (!AK) return null;
  const body = { model, max_tokens: 2000, system: SCREEN_SYS, messages: [{ role: 'user', content: user }], output_config: { effort: 'low' } };
  const send = b => fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': AK, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(b) });
  let r = await send(body); if (!r.ok && r.status === 400) { delete body.output_config; r = await send(body); }
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error('Anthropic: ' + ((j.error && j.error.message) || r.status));
  const t = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join(''), m = t.match(/\{[\s\S]*\}/);
  try { return m ? JSON.parse(m[0]) : null; } catch (e) { return null; }
}
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
async function telegram(html) {
  if (!TG || !CHAT) { log('Telegram not set up; alert was:\n' + html.replace(/<[^>]+>/g, '')); return; }
  const r = await fetch(`https://api.telegram.org/bot${TG}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: CHAT, text: html, parse_mode: 'HTML', disable_web_page_preview: true }) });
  if (!r.ok) log('Telegram error', r.status, await r.text());
}
const sigText = s => `${s.tf} ${s.side} score ${s.score}: ${s.patterns.join(' + ')}; ${s.why.join('; ')}; origin ${f2(s.origin)}, price now ${f2(s.price)}, ATR ${f2(s.atr)}`;

// signals on any 15M or 1H candle that closed since the last run (an hour ago), re-scored against the price now
function freshSignals(m15, h1, h4, pxNow) {
  const out = [], since = now - 65 * 60000;
  for (const [b, htf, tf, back] of [[m15, h1, '15M', 4], [h1, h4, '1H', 1]]) {
    for (let k = 0; k < back; k++) {
      const sub = b.slice(0, b.length - k); if (sub.length < 60 || sub[sub.length - 1].t < since - (tf === '1H' ? 36e5 : 9e5)) continue;
      for (const s of D.detect(sub, htf, { tf })) {
        const after = s.dir * (pxNow - s.price) / s.atr;          // how far price has moved since the signal candle closed
        if (after > 1.5) continue;                                // the move has already gone: not early any more
        out.push({ ...s, score: s.score - (after > 0.8 ? 10 : 0) - k * 3, price: pxNow });
      }
    }
  }
  const best = {}; for (const s of out) { const key = s.side; if (!best[key] || s.score > best[key].score) best[key] = s; }
  return Object.values(best).sort((a, b) => b.score - a.score);
}

const sess = D.justOpened(now, 70), sessKey = sess ? sess.name + sess.t : '';
const doSession = !!(sess && W.sessionScreen !== false && !S.sessions[sessKey]);
log(`pairs ${pairs.join(', ')}; session ${sess ? sess.name : 'none'}${doSession ? ' (screening)' : ''}`);
const sent = [];
for (const sym of pairs) {
  if (!isCrypto(sym) && !fxOpen(now)) { log(sym, 'market closed'); continue; }
  try {
    const a = await bars(sym, '15M', 300), b = await bars(sym, '1H', 300), h4 = D.to4h(b.closed), pxNow = (a.last || b.last).c;
    const sig = freshSignals(a.closed, b.closed, h4, pxNow);
    for (const p of S.sig) { if (p.sym !== sym || p.res) continue; const r = D.scoreSignal(p, p.tf === '15M' ? a.closed : b.closed); if (r) { p.res = r.res; p.mfe = r.mfe; p.mae = r.mae; } else if (now - p.seen > 3 * 864e5) p.res = 'void'; }
    for (const x of sig) if (!S.sig.some(p => p.sym === sym && p.tf === x.tf && p.at === x.at && p.side === x.side)) S.sig.unshift({ sym, tf: x.tf, side: x.side, score: x.score, atr: x.atr, price: x.price, at: x.at, patterns: x.patterns, why: x.why.filter(w => /trend/.test(w)), seen: now });
    const track = [...new Set(sig.map(x => D.sigVerdict(x, S.sig).line).filter(Boolean))];
    const data = D.brief(sym, a.closed, b.closed, h4) + `\nPRICE NOW ${f2(pxNow)}\nEARLY-MOVE SIGNALS (last hour):\n` + (sig.length ? sig.map(sigText).join('\n') : 'none') + (track.length ? '\nPAST FOLLOW-THROUGH OF THESE SIGNAL TYPES (1 ATR with the signal before 1 ATR against): ' + track.join(' ') : '');
    if (doSession) {
      const v = await haiku(`${sess.name} session open screen. Current UTC time ${new Date(now).toISOString()}.\n${data}`);
      log(sym, 'session', JSON.stringify(v));
      if (v && v.opportunity === 'yes' && (+v.quality || 0) >= 3 && !recent(sym, v.direction)) {
        sent.push({ sym, side: v.direction, t: now });
        await telegram(`🔔 <b>${esc(sym)}: possible ${esc(v.direction)}</b> (${esc(v.quality)}/5) at the ${esc(sess.name)} open\n${esc(v.setup)}. ${esc(v.why)}\nTrigger: ${esc(v.trigger)}\nInvalidation: ${v.invalidation != null ? esc(f2(+v.invalidation)) : 'n/a'}\nPrice ${esc(f2(pxNow))}. Open Edgeview for a full analysis.`);
      }
    } else if (W.earlyDetection !== false && sig.length && sig[0].score >= minScore && !recent(sym, sig[0].side) && D.sigVerdict(sig[0], S.sig).weak && sig[0].score < minScore + 15) {
      log(sym, 'skipped weak signal type', D.sigVerdict(sig[0], S.sig).line);
    } else if (W.earlyDetection !== false && sig.length && sig[0].score >= minScore && !recent(sym, sig[0].side)) {
      const s = sig[0], v = await haiku(`An early-move signal fired in the last hour. Confirm or reject it. Current UTC time ${new Date(now).toISOString()}.\n${data}`);
      log(sym, 'early', s.side, s.score, JSON.stringify(v));
      if (!AK || (v && v.opportunity !== 'no' && (v.direction === s.side || v.direction === 'NONE'))) {
        sent.push({ sym, side: s.side, t: now });
        await telegram(`⚡ <b>${esc(sym)}: early ${esc(s.side)} move</b> (${esc(s.tf)}, score ${s.score})\n${esc(v ? `${v.setup}. ${v.why}` : s.why.join('; '))}\n${v ? 'Trigger: ' + esc(v.trigger) + '\n' : ''}${(() => { const t = D.sigVerdict(s, S.sig).line; return t ? esc(t) + '\n' : ''; })()}Origin ${esc(f2(s.origin))}, stop idea ${esc(f2(s.stopIdea))}, price ${esc(f2(pxNow))}. Open Edgeview for a full analysis.`);
      }
    } else log(sym, 'no alert', sig.length ? `best ${sig[0].side} ${sig[0].score}` : 'no signal');
  } catch (e) { log(sym, 'error', e.message || e); }
}
if (doSession) S.sessions[sessKey] = true;
S.sessions = Object.fromEntries(Object.entries(S.sessions).slice(-20));
S.alerts = S.alerts.concat(sent);
writeFileSync(STATE, JSON.stringify(S));
log(`done: ${sent.length} alert${sent.length === 1 ? '' : 's'}`);
