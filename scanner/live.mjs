// Edgeview live trader (v39). Runs on GitHub Actions every 15 minutes (see .github/workflows/live.yml).
// It trades one MetaTrader account through MetaApi (metaapi.cloud) under the mandate you set in the app
// (Robot > Live account), like a prop-firm challenge: profit target, maximum drawdown, daily loss limit,
// risk per trade, pairs, sessions and your own instructions. Claude decides the trades; this code enforces the limits.
// Secrets: METAAPI_TOKEN, METAAPI_ACCOUNT_ID, EDGEVIEW_PASSPHRASE, ANTHROPIC_API_KEY, TWELVE_DATA_KEY,
// optional TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID. GITHUB_TOKEN is provided by Actions.
// The mandate, your style and goals are read from the app's encrypted cloud memory (edgeview-data branch);
// the robot's account snapshot and trade log are written back encrypted to edgeview-live-state.json.
// Safety: it never trades a real-money account unless the mandate says "allow real account", it stops
// opening trades before the daily and overall limits can be breached, and it closes everything when a limit is hit.
import { webcrypto as wc } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const D = require('../detect.js'), TA = require('../ta.js');
import { isSynth, synthCode, synthBrief, derivCandles, SYNTH_LIST } from './deriv.mjs';
const crypto = globalThis.crypto || wc;

const env = process.env, now = +env.LIVE_NOW || Date.now();
const MT = env.METAAPI_TOKEN || '', ACC = env.METAAPI_ACCOUNT_ID || '', PASS = env.EDGEVIEW_PASSPHRASE || '';
const AK = env.ANTHROPIC_API_KEY || '', TK = env.TWELVE_DATA_KEY || '', TG = env.TELEGRAM_BOT_TOKEN || '', CHAT = env.TELEGRAM_CHAT_ID || '';
const GH = env.GITHUB_TOKEN || '', REPO = env.GITHUB_REPOSITORY || '', GHAPI = env.GITHUB_API || 'https://api.github.com', BR = 'edgeview-data';
const ANTH = env.ANTHROPIC_BASE || 'https://api.anthropic.com';
const MAGIC = 26110339;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isCrypto = s => /^(BTC|ETH|SOL|XRP|BNB|ADA|DOGE|AVAX|DOT|LINK|LTC|TRX|TON|SUI)\b/i.test(String(s).replace('/', ' '));
const pxDec = x => { const a = Math.abs(+x); return a >= 1000 ? 2 : a >= 20 ? 3 : a >= 0.1 ? 5 : 6; };
const f2 = x => x == null || isNaN(x) ? 'n/a' : Number(x).toFixed(pxDec(x));
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fxOpen = t => { const d = new Date(t), w = d.getUTCDay(), h = d.getUTCHours(); return !(w === 6 || (w === 5 && h >= 21) || (w === 0 && h < 22)); };

// ---------- encrypted cloud memory (same format as the app: PBKDF2-SHA256 210k + AES-256-GCM, gzip)
const b64 = u => Buffer.from(u).toString('base64'), unb64 = s => new Uint8Array(Buffer.from(s, 'base64'));
async function keyOf(pass, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 210000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function openBox(box, pass) {
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, await keyOf(pass, unb64(box.salt)), unb64(box.ct)));
  return JSON.parse(box.gz ? gunzipSync(pt).toString() : new TextDecoder().decode(pt));
}
async function sealBox(obj, pass) {
  const plain = gzipSync(Buffer.from(JSON.stringify(obj))), salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyOf(pass, salt), plain));
  return { v: 1, app: 'edgeview', gz: true, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}
const ghH = () => ({ Authorization: 'Bearer ' + GH, Accept: 'application/vnd.github+json', 'User-Agent': 'edgeview-live' });
async function ghGet(path) {
  const u = `${GHAPI}/repos/${REPO}/contents/${path}?ref=${BR}`, r = await fetch(u, { headers: ghH() });
  if (r.status === 404) return null; if (!r.ok) throw new Error('GitHub ' + r.status);
  const j = await r.json(), raw = await fetch(u, { headers: { ...ghH(), Accept: 'application/vnd.github.raw+json' } });
  return { sha: j.sha, box: await raw.json() };
}
async function ghPut(path, box, sha) {
  const r = await fetch(`${GHAPI}/repos/${REPO}/contents/${path}`, { method: 'PUT', headers: ghH(), body: JSON.stringify({ message: 'Edgeview live robot state', branch: BR, content: b64(Buffer.from(JSON.stringify(box))), ...(sha ? { sha } : {}) }) });
  if (!r.ok) throw new Error('GitHub write ' + r.status + ' ' + (await r.text()).slice(0, 200));
}

// ---------- MetaApi (REST)
let BASE = '';
async function mt(method, path, body) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`${BASE}/users/current/accounts/${ACC}${path}`, { method, headers: { 'auth-token': MT, 'content-type': 'application/json', accept: 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { }
    if (r.ok) return j;
    if (r.status === 404 && /specification|current-price/.test(path)) return null;
    if (r.status >= 500 || r.status === 429) { await sleep(3000 * (i + 1)); continue; }
    throw new Error(`MetaApi ${method} ${path.split('?')[0]}: ${r.status} ${(j && (j.message || j.error)) || t.slice(0, 160)}`);
  }
  throw new Error(`MetaApi ${method} ${path}: unavailable`);
}
const tradeOk = r => r && (r.numericCode === 10009 || r.numericCode === 10008 || r.stringCode === 'TRADE_RETCODE_DONE' || r.stringCode === 'TRADE_RETCODE_PLACED');
async function trade(body) { const r = await mt('POST', '/trade', body); if (!tradeOk(r)) throw new Error(`broker refused ${body.actionType}: ${r && (r.stringCode + ' ' + (r.message || ''))}`); return r; }

// ---------- candles
let lastTd = 0;
async function bars(sym, tf, n) {
  const ms = tf === '15M' ? 9e5 : 36e5; let out;
  if (env.BARS_FILE) { const B = JSON.parse(require('node:fs').readFileSync(env.BARS_FILE, 'utf8')); out = B[sym + '|' + tf]; if (!out) throw new Error('no test bars'); }
  else if (isSynth(sym)) out = await derivCandles(synthCode(sym), tf === '15M' ? 900 : 3600, n);
  else if (isCrypto(sym) && !TK) {
    const r = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${sym.toUpperCase().replace('/', '').replace(/USD$/, 'USDT')}&interval=${tf === '15M' ? '15m' : '1h'}&limit=${n}`);
    if (!r.ok) throw new Error('Binance ' + r.status); out = (await r.json()).map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] }));
  } else {
    if (!TK) throw new Error('needs TWELVE_DATA_KEY');
    const w = lastTd + 8000 - Date.now(); if (w > 0) await sleep(w); lastTd = Date.now();
    const r = await fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=${tf === '15M' ? '15min' : '1h'}&outputsize=${n}&timezone=UTC&apikey=${TK}`), j = await r.json();
    if (!j || j.status === 'error' || !j.values) throw new Error('Twelve Data: ' + (j && j.message || r.status));
    out = j.values.map(x => ({ t: Date.parse(x.datetime.replace(' ', 'T') + 'Z'), o: +x.open, h: +x.high, l: +x.low, c: +x.close })).reverse();
  }
  return { closed: out.filter(b => b.t + ms <= now), last: out[out.length - 1] };
}

// ---------- Claude decides
const LIVE_SYS = `You are the trading robot that runs the user's MetaTrader account inside Edgeview, under a written mandate like a prop-firm challenge.
You get compact candle data, market structure and tools for one instrument, the account and challenge state, the trader's own style, goals and instructions.
Decide whether to open ONE trade on this instrument now. Protecting the account comes first: pass whenever the setup is not clearly good, the stop would sit inside obvious liquidity, the reward is too small, or the instructions say no.
Build entries, stops and targets the way the trader's style says, using exact prices from the data (stops beyond swing points and liquidity, targets at real levels).
Reply with ONLY one JSON object:
{"decision":"TRADE|NO_TRADE","side":"BUY|SELL","order":"MARKET|LIMIT|STOP","entry":0,"sl":0,"tp":[0,0],"valid_hours":6,"confidence":0,"why":"two short sentences","manage":"one short sentence"}
order MARKET uses the current price as entry. LIMIT: buy below / sell above the current price. STOP: buy above / sell below it. tp has one to three targets, nearest first. confidence is 0-100 (chance TP1 is hit before the stop).`;
async function claude(model, system, user) {
  const body = { model, max_tokens: 3000, system, messages: [{ role: 'user', content: user }] };
  const send = b => fetch(ANTH + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': AK, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(b) });
  let r = await send({ ...body, thinking: { type: 'disabled' } }); if (!r.ok && r.status === 400) r = await send(body);
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error('Anthropic: ' + ((j.error && j.error.message) || r.status));
  const t = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join(''), m = t.match(/\{[\s\S]*\}/);
  try { return m ? JSON.parse(m[0]) : null; } catch (e) { return null; }
}
async function telegram(html) {
  if (!TG || !CHAT) return;
  await fetch(`https://api.telegram.org/bot${TG}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: CHAT, text: html, parse_mode: 'HTML', disable_web_page_preview: true }) }).catch(() => { });
}

// ---------- pure rules (exported for tests)
export function dayKey(t) { return new Date(t + 2 * 36e5).toISOString().slice(0, 10); }          // broker day: starts 22:00 UTC
export function inSession(t, list) {
  const h = new Date(t).getUTCHours(), L = (list && list.length ? list : ['london', 'newyork']);
  return L.some(s => s === 'all' || (s === 'asia' && (h >= 23 || h < 7)) || (s === 'london' && h >= 7 && h < 16) || (s === 'newyork' && h >= 12 && h < 21));
}
export function limits(M, ch, day, acct, openRisk) {
  const eq = acct.equity, bal = acct.balance;
  const ddUsed = Math.max(0, (ch.startBal - eq) / ch.startBal * 100), dayUsed = Math.max(0, (day.startBal - eq) / day.startBal * 100);
  const gain = (eq - ch.startBal) / ch.startBal * 100;
  const ddRoom = ch.startBal * (M.maxDD / 100) - Math.max(0, ch.startBal - eq) - openRisk;          // money left before the overall limit, if every open stop is hit
  const dayRoom = day.startBal * (M.dayLoss / 100) - Math.max(0, day.startBal - eq) - openRisk;
  return { ddUsed, dayUsed, gain, ddRoom, dayRoom, breachDD: ddUsed >= M.maxDD, breachDay: dayUsed >= M.dayLoss, target: M.target > 0 && gain >= M.target, bal };
}
export function validPlan(p, px, minRR, atr) {
  if (!p || p.decision !== 'TRADE') return 'no trade';
  const side = p.side === 'BUY' ? 1 : p.side === 'SELL' ? -1 : 0; if (!side) return 'no side';
  const entry = p.order === 'MARKET' ? (side > 0 ? px.ask : px.bid) : +p.entry, sl = +p.sl, tps = (p.tp || []).map(Number).filter(x => x > 0);
  if (!(entry > 0 && sl > 0 && tps.length)) return 'missing prices';
  if (side * (entry - sl) <= 0) return 'stop on the wrong side';
  if (tps.some(t => side * (t - entry) <= 0)) return 'target on the wrong side';
  if (p.order === 'LIMIT' && side * (entry - (side > 0 ? px.ask : px.bid)) >= 0) return 'limit price is not better than the market';
  if (p.order === 'STOP' && side * (entry - (side > 0 ? px.ask : px.bid)) <= 0) return 'stop-entry price is not beyond the market';
  const risk = Math.abs(entry - sl), rr = Math.abs(tps[0] - entry) / risk;
  if (rr + 1e-9 < minRR) return `reward to risk ${rr.toFixed(2)} is below the minimum ${minRR}`;
  if (atr && (risk < 0.2 * atr || risk > 4 * atr)) return `stop distance ${f2(risk)} is unrealistic against the 1H ATR ${f2(atr)}`;
  return { side, entry, sl, tps, rr, risk };
}
export function lots(riskMoney, dist, spec, price) {
  const tick = +spec.tickSize || Math.pow(10, -(+spec.digits || 5)), tv = +(price.lossTickValue || price.profitTickValue);
  if (!(tick > 0 && tv > 0 && dist > 0)) return 0;
  const raw = riskMoney / (dist / tick * tv), step = +spec.volumeStep || 0.01;
  let v = Math.floor(raw / step + 1e-9) * step; v = Math.min(v, +spec.maxVolume || 100);
  const dec = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
  return v + 1e-12 < (+spec.minVolume || step) ? 0 : +v.toFixed(dec);
}
function defaults(M) {
  return { on: false, allowReal: false, region: 'london', pairs: ['XAU/USD'], risk: 0.5, target: 8, maxDD: 8, dayLoss: 4, maxOpen: 2, maxDay: 3, minRR: 1.5, sessions: ['london', 'newyork'], tpMode: 'split', be: true, maxLot: 1, maxCalls: 10, model: 'claude-sonnet-5-5', notes: '', symMap: '', ...(M || {}) };
}

// ---------- the run
export async function run() {
  if (!MT || !ACC || !PASS || !GH || !REPO) { log('live trading is not set up (needs METAAPI_TOKEN, METAAPI_ACCOUNT_ID and EDGEVIEW_PASSPHRASE secrets)'); return; }
  const sync = await ghGet('edgeview-sync.json'); if (!sync) { log('no cloud memory yet: turn on sync in the app'); return; }
  let mem; try { mem = await openBox(sync.box, PASS); } catch (e) { log('cannot decrypt the cloud memory: EDGEVIEW_PASSPHRASE must equal the backup passphrase'); return; }
  const kv = k => { try { return JSON.parse((mem.kv && mem.kv[k] && mem.kv[k][0]) || 'null'); } catch (e) { return (mem.kv && mem.kv[k] && mem.kv[k][0]) || null; } };
  const M = defaults(kv('ev_live')), style = (mem.kv && mem.kv.ev_style && mem.kv.ev_style[0]) || '', goals = kv('ev_goals') || {};
  BASE = env.METAAPI_BASE || `https://mt-client-api-v1.${M.region || 'london'}.agiliumtrade.ai`;
  const prev = await ghGet('edgeview-live-state.json').catch(() => null);
  let S = { log: [], trades: [], calls: {}, sessDone: {}, sym: {} };
  if (prev && prev.box && prev.box.ct) { try { S = { ...S, ...(await openBox(prev.box, PASS)) }; } catch (e) { log('previous state unreadable, starting fresh'); } }
  const note = (msg, tg) => { S.log.unshift({ t: now, msg }); S.log = S.log.slice(0, 200); log(msg.replace(/\d[\d.,]*/g, '#')); /* Actions logs of a public repository are public: no figures */ if (tg) return telegram(tg === true ? esc(msg) : tg); };
  const save = async () => { S.at = now; S.mandate = { on: M.on, rev: M.startAt }; await ghPut('edgeview-live-state.json', await sealBox(S, PASS), prev && prev.sha); };
  try {
    const acct = await mt('GET', '/account-information');
    const real = /REAL/i.test(acct.type || ''), [pos, ord] = await Promise.all([mt('GET', '/positions'), mt('GET', '/orders')]);
    S.acct = { balance: acct.balance, equity: acct.equity, currency: acct.currency, type: acct.type, leverage: acct.leverage, broker: acct.broker, server: acct.server, real, margin: acct.margin, freeMargin: acct.freeMargin };
    const mine = x => x.magic === MAGIC || /^EV/.test(x.clientId || '');
    S.pos = (pos || []).map(p => ({ id: p.id, sym: p.symbol, type: p.type, vol: p.volume, open: p.openPrice, sl: p.stopLoss, tp: p.takeProfit, cur: p.currentPrice, pl: (p.profit || 0) + (p.swap || 0) + (p.commission || 0), mine: mine(p), cid: p.clientId || '' }));
    S.ord = (ord || []).map(o => ({ id: o.id, sym: o.symbol, type: o.type, vol: o.volume, open: o.openPrice, sl: o.stopLoss, tp: o.takeProfit, mine: mine(o), cid: o.clientId || '' }));
    // the challenge starts when you press Start in the app
    if (M.startAt && (!S.ch || S.ch.startAt !== M.startAt)) { S.ch = { startAt: M.startAt, startBal: acct.balance, peak: acct.equity, status: 'running' }; S.trades = []; await note(`New mandate started on ${acct.broker || 'the account'}: balance ${acct.balance} ${acct.currency}, target +${M.target}%, max drawdown ${M.maxDD}%, daily loss ${M.dayLoss}%, risk ${M.risk}% per trade.`, true); }
    if (!S.ch) { await note('No mandate started yet: press Start in the app (Robot > Live account).'); return await save(); }
    S.ch.peak = Math.max(S.ch.peak || 0, acct.equity);
    const dk = dayKey(now); if (!S.day || S.day.key !== dk) S.day = { key: dk, startBal: Math.max(acct.balance, acct.equity), trades: 0, halted: false };
    // results of our closed trades
    await settle(S, note);
    const openRisk = S.trades.filter(t => t.st === 'open').reduce((s, t) => s + (t.riskMoney || 0), 0);
    const L = limits(M, S.ch, S.day, acct, openRisk); S.lim = L;
    const closeAll = async why => {
      for (const o of S.ord) { try { await trade({ actionType: 'ORDER_CANCEL', orderId: o.id }); } catch (e) { await note('cancel failed: ' + e.message); } }
      for (const p of S.pos) { try { await trade({ actionType: 'POSITION_CLOSE_ID', positionId: p.id }); } catch (e) { await note('close failed: ' + e.message); } }
      if (S.ord.length || S.pos.length) await note(`Closed ${S.pos.length} position(s) and cancelled ${S.ord.length} order(s): ${why}.`, `🛑 <b>Edgeview live: everything closed</b>\n${esc(why)}`);
    };
    if (M.flatAt && (!S.flatDone || S.flatDone < M.flatAt)) { await closeAll('you asked to close everything'); S.flatDone = M.flatAt; }
    if (S.ch.status === 'running') {
      if (L.breachDD) { S.ch.status = 'failed'; S.ch.reason = `maximum drawdown of ${M.maxDD}% reached`; await closeAll(S.ch.reason); }
      else if (L.target) { S.ch.status = 'passed'; S.ch.reason = `profit target of +${M.target}% reached`; await closeAll(S.ch.reason); }
      else if (L.breachDay && !S.day.halted) { S.day.halted = true; await closeAll(`daily loss limit of ${M.dayLoss}% reached; trading resumes next broker day`); }
      else if (M.endDate && now > Date.parse(M.endDate + 'T21:00:00Z')) { S.ch.status = 'ended'; S.ch.reason = 'end date reached'; await note('Mandate end date reached: no new trades.', true); }
    }
    await manage(S, M, note);
    // why no new trades?
    const stop = !M.on ? 'paused in the app' : real && !M.allowReal ? 'this is a real-money account and the mandate does not allow real accounts' : S.ch.status !== 'running' ? `challenge ${S.ch.status}: ${S.ch.reason}` :
      S.day.halted ? 'daily loss limit reached today' : !inSession(now, M.sessions) ? 'outside your trading sessions' : S.day.trades >= M.maxDay ? `already ${S.day.trades} trades today (max ${M.maxDay})` :
      S.pos.filter(p => p.mine).length + S.ord.filter(o => o.mine).length >= M.maxOpen ? `${M.maxOpen} trades already open or pending` : '';
    S.idle = stop || '';
    if (stop) { log('no new trades:', stop.replace(/\d[\d.,]*/g, '#')); return await save(); }
    const ck = dk; S.calls = S.calls.day === ck ? S.calls : { day: ck, n: 0 };
    for (const sym of M.pairs.slice(0, 6)) {
      if (S.calls.n >= M.maxCalls) { log('daily analysis budget used'); break; }
      if (!isCrypto(sym) && !isSynth(sym) && !fxOpen(now)) continue;
      const bsym = await brokerSym(S, M, sym); if (!bsym) { await note(`${sym}: no matching symbol on the broker; set it in the symbol map`); continue; }
      if (S.pos.some(p => p.sym === bsym && p.mine) || S.ord.some(o => o.sym === bsym && o.mine)) continue;
      if (S.pos.filter(p => p.mine).length + S.ord.filter(o => o.mine).length >= M.maxOpen || S.day.trades >= M.maxDay) break;
      try {
        const a = await bars(sym, '15M', 300), b = await bars(sym, '1H', 300), h4 = D.to4h(b.closed), px0 = (a.last || b.last).c;
        const sess = D.justOpened(now, 20), sk = sess ? sym + sess.name + sess.t : '';
        const sig = D.detect(a.closed, b.closed, { tf: '15M' }).concat(D.detect(b.closed, h4, { tf: '1H' })).filter(s => now - s.at < 45 * 60000 && s.score >= 60).sort((x, y) => y.score - x.score);
        if (!(sk && !S.sessDone[sk]) && !sig.length && !env.LIVE_FORCE) { log(sym, 'nothing new'); continue; }
        if (sk) S.sessDone[sk] = 1;
        const price = await mt('GET', `/symbols/${encodeURIComponent(bsym)}/current-price`), spec = await mt('GET', `/symbols/${encodeURIComponent(bsym)}/specification`);
        if (!price || !spec) { await note(`${sym}: broker has no price or specification for ${bsym}`); continue; }
        const atr = TA.atr(b.closed, 14), atrN = Array.isArray(atr) ? atr[atr.length - 1] : atr;
        const data = (isSynth(sym) ? synthBrief(sym) + '\n' : '') + D.brief(sym, a.closed, b.closed, h4) + '\n' + [TA.tfTools('1H', b.closed, px0, 3), TA.tfTools('15M', a.closed, px0, 3)].filter(Boolean).join('\n') +
          `\nBROKER PRICE NOW (${bsym}): bid ${price.bid}, ask ${price.ask}, spread ${f2(price.ask - price.bid)}` + (sig.length ? '\nEARLY-MOVE SIGNALS: ' + sig.slice(0, 3).map(s => `${s.tf} ${s.side} score ${s.score}: ${(s.patterns || []).join(' + ')}`).join('; ') : '') + (sess ? `\nThe ${sess.name} session just opened.` : '');
        const ctx = `TIME ${new Date(now).toISOString()}\nACCOUNT: balance ${acct.balance} ${acct.currency}, equity ${acct.equity}; challenge ${L.gain.toFixed(2)}% of +${M.target}% target; drawdown used ${L.ddUsed.toFixed(2)}% of ${M.maxDD}%; today's loss used ${L.dayUsed.toFixed(2)}% of ${M.dayLoss}%; ${S.day.trades} trade(s) today.\n` +
          `RECENT ROBOT TRADES: ${S.trades.slice(0, 6).map(t => `${t.sym} ${t.side} ${t.st}${t.pl != null ? ' ' + t.pl.toFixed(2) : ''}`).join('; ') || 'none'}\n` +
          `MANDATE: minimum reward to risk ${M.minRR}. ${M.notes ? 'TRADER\'S INSTRUCTIONS FOR THIS ACCOUNT: ' + M.notes : ''}\nTRADER'S STYLE:\n${style || '(not described)'}\nGOALS: today ${goals.day || 'none'}; week ${goals.week || 'none'}`;
        S.calls.n++;
        const p = await claude(M.model, LIVE_SYS, `${ctx}\n\nINSTRUMENT ${sym}\n${data}`);
        const v = validPlan(p, price, M.minRR, atrN);
        if (typeof v === 'string') { await note(`${sym}: no trade (${v}${p && p.why ? ': ' + p.why : ''})`); continue; }
        // size from the account currency tick value; never risk more than the room left under the daily and overall limits
        let riskMoney = acct.balance * Math.min(M.risk, 2) / 100;
        const streak = (() => { let n = 0; for (const t of S.trades) { if (t.st === 'loss') n++; else if (t.st === 'win') break; } return n; })(); if (streak >= 3) riskMoney /= 2;
        riskMoney = Math.min(riskMoney, L.dayRoom * 0.9, L.ddRoom * 0.9);
        if (!(riskMoney > 0)) { await note(`${sym}: skipped, no room left under the loss limits`); continue; }
        let vol = Math.min(lots(riskMoney, v.risk, spec, price), +M.maxLot || 1);
        if (!vol) { await note(`${sym}: skipped, the smallest lot would risk more than ${riskMoney.toFixed(2)} ${acct.currency}`); continue; }
        const legs = [], step = +spec.volumeStep || 0.01, minV = +spec.minVolume || step;
        if (M.tpMode === 'split' && v.tps.length > 1 && vol >= 2 * minV) { const h = Math.floor(vol / 2 / step + 1e-9) * step, dec = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)); legs.push([+h.toFixed(dec), v.tps[0]], [+(vol - h).toFixed(dec), v.tps[Math.min(1, v.tps.length - 1)]]); }
        else legs.push([vol, M.tpMode === 'tp2' && v.tps[1] ? v.tps[1] : v.tps[0]]);
        const kind = p.order === 'MARKET' ? '' : p.order === 'LIMIT' ? '_LIMIT' : '_STOP', id = 'EV' + now.toString(36).slice(-5) + Math.random().toString(36).slice(2, 4) + sym.replace(/\W/g, '').slice(0, 3);
        const ids = [];
        for (const [i, [lv, tp]] of legs.entries()) {
          const r = await trade({ actionType: `ORDER_TYPE_${v.side > 0 ? 'BUY' : 'SELL'}${kind}`, symbol: bsym, volume: lv, ...(kind ? { openPrice: v.entry, expiration: { type: 'ORDER_TIME_SPECIFIED', time: new Date(now + Math.min(24, Math.max(1, +p.valid_hours || 6)) * 36e5).toISOString() } } : {}), stopLoss: v.sl, takeProfit: tp, comment: 'Edgeview', clientId: id + i, magic: MAGIC });
          ids.push({ cid: id + i, orderId: r.orderId || null, positionId: r.positionId || null, vol: lv, tp });
        }
        S.day.trades++;
        S.trades.unshift({ id, at: now, sym, bsym, side: v.side > 0 ? 'BUY' : 'SELL', order: p.order, entry: v.entry, sl: v.sl, tps: v.tps, vol, riskMoney: +riskMoney.toFixed(2), rr: +v.rr.toFixed(2), conf: p.confidence, why: p.why, manage: p.manage, legs: ids, st: 'open' });
        S.trades = S.trades.slice(0, 300);
        await note(`${sym}: placed ${p.order} ${v.side > 0 ? 'BUY' : 'SELL'} ${vol} lots at ${f2(v.entry)}, stop ${f2(v.sl)}, targets ${v.tps.map(f2).join(' / ')}, risking ${riskMoney.toFixed(2)} ${acct.currency}.`,
          `🤖 <b>Edgeview live: ${esc(sym)} ${v.side > 0 ? 'BUY' : 'SELL'} ${esc(p.order)}</b>\nEntry ${f2(v.entry)} | SL ${f2(v.sl)} | TP ${v.tps.map(f2).join(' / ')}\n${vol} lots, risk ${riskMoney.toFixed(2)} ${esc(acct.currency)} (R:R ${v.rr.toFixed(2)})\n${esc(p.why || '')}`);
      } catch (e) { await note(`${sym}: error ${e.message || e}`); }
    }
    await save();
  } catch (e) { S.err = String(e.message || e); await note('robot error: ' + S.err); await save().catch(x => log('could not save state', x.message)); process.exitCode = 1; }
}
async function brokerSym(S, M, sym) {
  const map = Object.fromEntries(String(M.symMap || '').split(',').map(x => x.split('=').map(y => y.trim())).filter(x => x[0] && x[1]));
  if (map[sym]) return map[sym]; if (S.sym[sym]) return S.sym[sym];
  if (isSynth(sym)) { const c = synthCode(sym), nm = (SYNTH_LIST.find(x => x[1] === c) || [])[0]; for (const k of [nm, c].filter(Boolean)) { const sp = await mt('GET', `/symbols/${encodeURIComponent(k)}/specification`).catch(() => null); if (sp && (sp.symbol || sp.tickSize)) { S.sym[sym] = k; return k; } } return null; }
  const base = sym.replace('/', '').toUpperCase(), cands = [...(/^XAU/.test(base) ? ['GOLD', 'XAUUSD'] : /^XAG/.test(base) ? ['SILVER', 'XAGUSD'] : [base])].flatMap(c => [c, c + '#', c + '.', c + 'm', c + '.a']);
  for (const c of cands) { const s = await mt('GET', `/symbols/${encodeURIComponent(c)}/specification`).catch(() => null); if (s && (s.symbol || s.tickSize)) { S.sym[sym] = c; return c; } }
  return null;
}
// move the stop to break-even at +1R; trades whose orders and positions are all gone are settled from the deal history
async function manage(S, M, note) {
  if (!M.be) return;
  for (const t of S.trades.filter(x => x.st === 'open')) {
    const risk = Math.abs(t.entry - t.sl), side = t.side === 'BUY' ? 1 : -1;
    for (const p of S.pos.filter(p => t.legs.some(l => l.cid === p.cid))) {
      const moved = side * (p.cur - p.open);
      if (moved >= risk && side * ((p.sl || 0) - p.open) < 0) {
        try { await trade({ actionType: 'POSITION_MODIFY', positionId: p.id, stopLoss: p.open, takeProfit: p.tp }); await note(`${t.sym}: stop moved to break-even at ${f2(p.open)} (+1R reached)`); }
        catch (e) { await note(`${t.sym}: break-even move failed: ${e.message}`); }
      }
    }
  }
}
async function settle(S, note) {
  const open = S.trades.filter(t => t.st === 'open'); if (!open.length) return;
  const live = new Set([...S.pos.map(p => p.cid), ...S.ord.map(o => o.cid)]);
  const done = open.filter(t => !t.legs.some(l => live.has(l.cid))); if (!done.length) return;
  const from = new Date(Math.min(...done.map(t => t.at)) - 36e5).toISOString(), to = new Date(now + 6e4).toISOString();
  const deals = await mt('GET', `/history-deals/time/${from}/${to}`).catch(() => []) || [];
  for (const t of done) {
    const ds = deals.filter(d => t.legs.some(l => l.cid === d.clientId) || (d.clientId || '').startsWith(t.id));
    const filled = ds.some(d => /IN/.test(d.entryType || '')); const pl = ds.reduce((s, d) => s + (d.profit || 0) + (d.commission || 0) + (d.swap || 0), 0);
    if (!filled) { t.st = 'expired'; await note(`${t.sym}: order expired or was cancelled without filling`); continue; }
    t.pl = +pl.toFixed(2); t.st = pl > 0 ? 'win' : pl < 0 ? 'loss' : 'be'; t.closedAt = now; t.r = t.riskMoney ? +(pl / t.riskMoney).toFixed(2) : null;
    await note(`${t.sym}: ${t.side} closed, ${t.pl >= 0 ? '+' : ''}${t.pl}${t.r != null ? ` (${t.r >= 0 ? '+' : ''}${t.r}R)` : ''}`, `${t.pl >= 0 ? '✅' : '❌'} <b>Edgeview live: ${esc(t.sym)} ${t.side} closed</b> ${t.pl >= 0 ? '+' : ''}${t.pl}${t.r != null ? ` (${t.r}R)` : ''}`);
  }
}
if (import.meta.url === `file://${process.argv[1]}`) await run();
