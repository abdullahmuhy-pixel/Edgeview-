// node scanner/test/scalp.test.js : Scalping Mode engine (paper only)
const A = require('assert'), X = require('../../scalp.js');
let n = 0; const ok = (c, m) => { A.ok(c, m); n++; }; const near = (a, b, e, m) => ok(Math.abs(a - b) <= (e || 1e-9), `${m}: ${a} vs ${b}`);
const tz = 'Africa/Johannesburg', T0 = Date.UTC(2026, 10, 17, 10, 0);          // Tuesday 10:00 London (inside the London session)
// 1. configuration caps and the live lock
let c = X.normConfig({ riskPct: 1, maxOpen: 50, mode: 'live', dailyLossPct: 9, pairs: ['EUR/USD', 'BTC/USD'] });
ok(c.cfg.riskPct === 0.3 && c.cfg.maxOpen === 25 && c.cfg.mode === 'paper' && c.cfg.dailyLossPct === 3 && c.cfg.pairs.join() === 'EUR/USD', JSON.stringify(c));
ok(c.notes.some(x => /Live mode is locked/.test(x)), 'live note');
// 2. instruments
near(X.perPip('EUR/USD', 1, 1.1), 10, 1e-9, 'EUR/USD pip per lot'); near(X.perPip('XAU/USD', 1, 4000), 10, 1e-9, 'gold 0.1 pip per lot'); near(X.perPip('USD/JPY', 1, 150), 1000 / 150, 1e-9, 'USD/JPY pip per lot');
ok(X.sessionsAt(T0).includes('london') && !X.sessionsAt(T0).includes('newyork'), 'London only at 10:00 UTC'); ok(X.sessionsAt(Date.UTC(2026, 10, 17, 14)).includes('newyork'), 'NY at 14:00 UTC');
ok(!X.sessionsAt(Date.UTC(2026, 10, 21, 10)).length, 'no session on Saturday');
// 3. trade management on hand-made candles. Long EUR/USD: mid 1.10000, spread 0.6 pip, no entry slippage
const cfg = { on: true, pairs: ['EUR/USD'], balance: 10000, riskPct: 0.1, tpPips: 6, slPips: 8, beAfterPips: 4, beLockPips: 0.5, maxHoldMin: 45, slipPips: 0.2, dailyLossPct: 1 };
const P = 0.0001, spr = 0.6 * P, openT = T0 + 60000, entry = 1.1 + spr / 2;
const mkT = o => ({ id: 'EUR/USD|' + openT + '|1', sym: 'EUR/USD', side: 1, strat: 'meanrev', session: 'london', openT, mid: 1.1, entry, spread: spr, slipIn: 0, slip: 0.2 * P, sl: entry - 8 * P, tp: entry + 6 * P, lots: 0.12, riskAmt: 9.6, riskPct: 0.1, be: false, ...o });
const st0 = () => ({ ...X.newState(T0), last: { 'EUR/USD': T0 }, open: [mkT()] });
const run = (st, bars, cf) => X.step(st, { ...cfg, pairs: [], ...(cf || {}) }, { now: bars[bars.length - 1].t + 60000, bars: { 'EUR/USD': bars }, spreads: { 'EUR/USD': spr }, tz });
const bar = (i, o, h, l, c2) => ({ t: T0 + i * 60000, o, h, l, c: c2 });
// TP: bid must reach entry + 6 pips -> mid >= entry + 6 pips + spread/2
let r = run(st0(), [bar(1, 1.1, entry + 6 * P + spr / 2, 1.0999, 1.1003)]);
ok(r.closed.length === 1 && r.closed[0].reason === 'tp', 'TP hit'); near(r.closed[0].pnl, 6 * 0.12 * 10, 0.01, 'TP pnl = 6 pips x 0.12 lots x $10'); near(r.closed[0].pips, 6, 1e-6, 'TP pips');
// the same candle touching both: stop first (cautious)
r = run(st0(), [bar(1, 1.1, 1.1012, 1.0990, 1.1)]); ok(r.closed[0].reason === 'sl', 'stop before target'); near(r.closed[0].pnl, -(8 + 0.2) * 0.12 * 10, 0.01, 'SL pnl includes exit slippage');
// gap through the stop: exit at the open minus slippage
r = run(st0(), [bar(1, 1.0985, 1.0986, 1.0980, 1.0982)]); near(r.closed[0].exit, 1.0985 - spr / 2 - 0.2 * P, 1e-9, 'gap exit at the open');
// break-even: +4 pips on candle 1, back to entry on candle 2 -> exit at entry + 0.5 pip - slippage
r = run(st0(), [bar(1, 1.1, entry + 4.2 * P + spr / 2, 1.1, 1.1003), bar(2, 1.1003, 1.1003, 1.0995, 1.0996)]);
ok(r.closed.length === 1 && r.closed[0].reason === 'be', 'break-even exit ' + (r.closed[0] || {}).reason); near(r.closed[0].pnl, (0.5 - 0.2) * 1.2, 0.011, 'BE pnl');
// time exit after 45 minutes
const flat = []; for (let i = 1; i <= 46; i++) flat.push(bar(i, 1.1, 1.10005, 1.09995, 1.1));
r = run(st0(), flat); ok(r.closed.length === 1 && r.closed[0].reason === 'time' && r.closed[0].durMin === 45, 'time exit ' + JSON.stringify(r.closed[0] && [r.closed[0].reason, r.closed[0].durMin]));
// 4. the daily loss circuit breaker closes everything and locks; the target lock stops entries but still manages trades
const many = () => ({ ...X.newState(T0), last: { 'EUR/USD': T0 }, open: [0, 1, 2, 3].map(k => mkT({ id: 'x' + k, sl: entry - 40 * P, lots: 1 })) });
r = run(many(), [bar(1, 1.1, 1.1, 1.0970, 1.0972)]);   // 4 lots x ~28 pips = -$1,120 floating > $100 limit
ok(r.closed.length === 4 && r.closed.every(t => t.reason === 'breaker') && r.state.lock && r.state.lock.kind === 'loss', 'breaker ' + JSON.stringify(r.state.lock));
ok(X.entryBlock(r.state, X.normConfig(cfg).cfg, 'EUR/USD', T0 + 5 * 60000, tz) === r.state.lock.reason, 'locked after the breaker');
let tg = st0(); const d0 = X.dayKey(T0, tz); tg.days[d0] = { target: 50, lock: null, n: 10, net: 55, peak: 55, dd: 0 };
r = run(tg, [bar(1, 1.1, 1.1001, 1.0999, 1.1)], { dailyTarget: 50 });
ok(r.state.lock && r.state.lock.kind === 'target' && r.state.open.length === 1, 'target lock keeps the open trade');
r = run(r.state, [bar(2, 1.1, entry + 6 * P + spr / 2, 1.1, 1.1004)], { dailyTarget: 50 }); ok(r.closed.length === 1 && r.closed[0].reason === 'tp', 'open trade still managed after the target');
ok(X.today(r.state, { ...cfg, dailyTarget: 50 }, null, T0 + 3 * 60000, tz).progressPct === 100, 'progress capped at 100%');
// next day the lock clears
r = X.step(r.state, { ...cfg, dailyTarget: 50 }, { now: T0 + 864e5, bars: {}, tz }); ok(!r.state.lock, 'lock clears the next day');
// 5. entries: a stretched drop in a choppy market, then an up close -> meanrev BUY, sized from risk
function chop(nb, start, amp) { const b = []; let p = 1.1; for (let i = 0; i < nb; i++) { const o = p, c2 = 1.1 + (i % 2 ? amp : -amp); b.push({ t: start + i * 60000, o, h: Math.max(o, c2) + 0.2 * P, l: Math.min(o, c2) - 0.2 * P, c: c2 }); p = c2; } return b; }
const start = T0 - 300 * 60000, B = chop(300, start, 1 * P), L = B[B.length - 1];
B.push({ t: L.t + 60000, o: L.c, h: L.c, l: 1.0993, c: 1.0994 });                      // stretched down
B.push({ t: L.t + 120000, o: 1.0994, h: 1.0997, l: 1.0993, c: 1.0996 });                 // turns up
const i = B.length - 1, sig = X.STRATS.meanrev(B, i); ok(sig && sig.side === 1, 'meanrev fires ' + JSON.stringify(sig));
const fresh = { ...X.newState(T0), last: { 'EUR/USD': B[i - 1].t } };
r = X.step(fresh, { ...cfg, maxSpreadPips: { default: 1.2 } }, { now: B[i].t + 60000, bars: { 'EUR/USD': B }, spreads: { 'EUR/USD': spr }, tz });
ok(r.opened.length === 1, 'opened: ' + JSON.stringify(r.skipped));
const o = r.opened[0];   // risk 0.1% of 10 000 = $10; 8 pips x $10 per lot = $80 per lot -> 0.125 -> 0.12 lots
ok(o.lots === 0.12 && o.riskAmt === 9.6 && o.side === 1, 'lots from risk ' + JSON.stringify([o.lots, o.riskAmt]));
near(o.tp - o.entry, 6 * P, 1e-12, 'TP 6 pips'); near(o.entry - o.sl, 8 * P, 1e-12, 'SL 8 pips'); ok(o.entry > B[i].c + spr / 2 - 1e-12, 'buy fills on the ask plus slippage');
// spread filter, session filter, off switch, pause, pair switch
r = X.step(fresh, cfg, { now: B[i].t + 60000, bars: { 'EUR/USD': B }, spreads: { 'EUR/USD': 2 * P }, tz }); ok(!r.opened.length && Object.keys(r.skipped).some(k => /spread/.test(k)), 'spread filter');
const late = B.map(b => ({ ...b, t: b.t + 13 * 36e5 }));   // 23:00 UTC = 18:00 New York: neither London nor New York
r = X.step({ ...fresh, last: { 'EUR/USD': late[i - 1].t } }, cfg, { now: late[i].t + 60000, bars: { 'EUR/USD': late }, spreads: { 'EUR/USD': spr }, tz }); ok(!r.opened.length, 'session filter');
for (const [k, v] of [['on', false], ['paused', true], ['pairs', ['GBP/USD']]]) { r = X.step(fresh, { ...cfg, [k]: v }, { now: B[i].t + 60000, bars: { 'EUR/USD': B }, spreads: { 'EUR/USD': spr }, tz }); ok(!r.opened.length, k + ' blocks entries'); }
// money targets: $1.50 at 0.12 lots = 1.25 pips -> under 3x the 0.6-pip spread -> skipped
r = X.step(fresh, { ...cfg, tpStyle: 'money', tpMoney: 1.5 }, { now: B[i].t + 60000, bars: { 'EUR/USD': B }, spreads: { 'EUR/USD': spr }, tz }); ok(!r.opened.length && Object.keys(r.skipped).some(k => /3x the spread/.test(k)), 'money target vs spread');
r = X.step(fresh, { ...cfg, tpStyle: 'money', tpMoney: 3 }, { now: B[i].t + 60000, bars: { 'EUR/USD': B }, spreads: { 'EUR/USD': spr }, tz }); ok(r.opened.length && Math.abs((r.opened[0].tp - r.opened[0].entry) / P - 2.5) < 1e-6, '$3 at 0.12 lots = 2.5 pips');
// fixed lot over the 0.3% cap is refused
r = X.step(fresh, { ...cfg, sizing: 'fixed', fixedLot: 0.5 }, { now: B[i].t + 60000, bars: { 'EUR/USD': B }, spreads: { 'EUR/USD': spr }, tz }); ok(!r.opened.length && Object.keys(r.skipped).some(k => /above the 0.3% cap/.test(k)), 'fixed lot cap ' + JSON.stringify(r.skipped));
// 6. a long random simulation: 4 pairs, 3 trading days of 1-minute candles; the limits hold at every step
let seed = 99; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pairs = { 'EUR/USD': [1.1, P], 'GBP/USD': [1.27, P], 'USD/JPY': [150, 0.01], 'XAU/USD': [4000, 0.1] }, sim = {};
for (const [s, [p0, pp]] of Object.entries(pairs)) { const b = []; let p = p0, t = Date.UTC(2026, 10, 16, 0); for (let k = 0; k < 3 * 1440; k++) { const vol = pp * (1.2 + 3 * rnd() * rnd()), o = p, c2 = p + (rnd() - 0.5) * 2 * vol + (p0 - p) * 0.02; b.push({ t: t + k * 60000, o, h: Math.max(o, c2) + rnd() * vol, l: Math.min(o, c2) - rnd() * vol, c: c2 }); p = c2; } sim[s] = b; }
const scfg = { on: true, pairs: Object.keys(pairs), strategies: ['meanrev', 'breakout'], balance: 10000, riskPct: 0.2, maxOpen: 12, maxPerPair: 4, maxOpenRiskPct: 1.5, dailyLossPct: 1, dailyTarget: 60, maxTradesHour: 15, maxTradesDay: 80 };
let S = { ...X.newState(0), last: Object.fromEntries(Object.keys(pairs).map(s => [s, sim[s][299].t])) }, maxOpen = 0, maxPer = 0, maxRisk = 0, opened = 0, afterLock = 0;
for (let k = 300; k < 3 * 1440; k += 15) {
  const now = sim['EUR/USD'][k].t + 60000, bars = Object.fromEntries(Object.entries(sim).map(([s, b]) => [s, b.slice(Math.max(0, k - 400), k + 1)]));
  const lockedBefore = S.lock && S.lock.day; const R = X.step(S, scfg, { now, bars, tz });
  for (const t of R.opened) { opened++; if (S.lock && S.lock.day === X.dayKey(t.openT, tz) && S.lock.at <= t.openT) afterLock++; }
  S = R.state; maxOpen = Math.max(maxOpen, S.open.length); maxPer = Math.max(maxPer, ...Object.keys(pairs).map(s => S.open.filter(t => t.sym === s).length)); maxRisk = Math.max(maxRisk, S.open.reduce((a, t) => a + t.riskPct, 0));
}
const ST = X.stats(S, null, null, tz);
console.log(`simulation: ${opened} trades opened, ${ST.n} closed, win rate ${(ST.winRate * 100).toFixed(1)}%, net ${ST.net}, PF ${ST.pf}, max DD ${ST.maxDD}, avg ${ST.avgDurMin} min, spread cost ${ST.spreadCost}, slippage ${ST.slipCost}; target days ${ST.targetHit}/${ST.targetDays}, loss-limit days ${ST.lossDays}; exits ${JSON.stringify(Object.fromEntries(Object.entries(ST.byExit).map(([k, v]) => [k, v.n])))}`);
ok(opened > 20, 'the simulation trades'); ok(maxOpen <= 12 && maxPer <= 4, `open limits ${maxOpen}/${maxPer}`); ok(maxRisk <= 1.5 + 1e-9, 'open risk cap ' + maxRisk); ok(afterLock === 0, 'no entry after a lock on the same day');
near(ST.net, S.closed.reduce((a, t) => a + t.pnl, 0), 0.05, 'net = sum of trades'); near(Object.values(ST.byPair).reduce((a, g) => a + g.net, 0), ST.net, 0.05, 'by pair adds up');
ok(Object.values(ST.byPair).reduce((a, g) => a + g.n, 0) === ST.n, 'by pair counts');
ok(S.closed.every(t => t.reason !== 'tp' || t.pnl > 0) && S.closed.every(t => t.reason !== 'sl' || t.pnl < 0), 'TP exits win, SL exits lose');
near(ST.netBeforeCosts - ST.spreadCost - ST.slipCost, ST.net, 0.05, 'costs reconcile');
// trades per hour never above the cap (opening times)
const opens = S.closed.map(t => t.openT).concat(S.open.map(t => t.openT)).sort((a, b) => a - b); let hrMax = 0; for (let a = 0, b = 0; b < opens.length; b++) { while (opens[b] - opens[a] >= 36e5) a++; hrMax = Math.max(hrMax, b - a + 1); } ok(hrMax <= 15, 'per-hour cap ' + hrMax);
// stats on a hand-made set
const hs = { closed: [{ pnl: 3, exitT: T0, openT: T0 - 6e5, durMin: 10, spreadCost: 0.5, slipCost: 0, sym: 'EUR/USD', session: 'london', strat: 'meanrev', reason: 'tp' }, { pnl: 3, exitT: T0 + 1, openT: T0, durMin: 4, spreadCost: 0.5, slipCost: 0, sym: 'EUR/USD', session: 'london', strat: 'meanrev', reason: 'tp' }, { pnl: -4, exitT: T0 + 2, openT: T0, durMin: 6, spreadCost: 0.5, slipCost: 0.1, sym: 'XAU/USD', session: 'newyork', strat: 'breakout', reason: 'sl' }], days: {} };
const h = X.stats(hs, null, null, tz); ok(h.n === 3 && Math.abs(h.winRate - 2 / 3) < 1e-9 && h.pf === 1.5 && h.maxDD === 4 && h.avgDurMin === 6.67 && h.net === 2 && h.avgWin === 3 && h.avgLoss === -4, JSON.stringify(h));
const lr = X.liveReadiness(ST); ok(lr.ok === false && /not built/.test(lr.note), 'live stays locked');
ok(X.resetStats(S, 1).closed.length === 0 && X.resetStats(S, 1).open.length === S.open.length, 'reset keeps open trades');
if (require.main === module) console.log(`${n} checks passed`);
