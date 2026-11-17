// node scanner/test/tradePlan.test.js : tradePlan.js against the sample bars and hand-made signals
const A = require('assert'), D = require('../../detect.js'), P = require('../../tradePlan.js'), B = require('../../bars.json');
let n = 0; const ok = (c, m) => { A.ok(c, m); n++; };
const m15 = B['XAU/USD|15M'], h1 = B['XAU/USD|1H'], h4 = D.to4h(h1);
// 1. every real detection from the sample bars becomes a valid TRADE or a NO TRADE with reasons
let seen = 0, trades = 0;
for (const MS of [60, 0]) for (const [b, htf, tf] of [[m15, h1, '15M'], [h1, h4, '1H']]) for (let k = 60; k <= b.length; k++) {
  const sub = b.slice(0, k);
  for (const s of D.detect(sub, htf.filter(x => x.t < sub[sub.length - 1].t), { tf })) {
    seen++;
    const ctx = P.planContext(s, { m15: m15.filter(x => x.t <= s.at), h1: h1.filter(x => x.t <= s.at), h4 }, { symbol: 'XAU/USD', minScore: MS, now: s.at + 9e5, source: 'scanner' });
    const { plan, errors } = P.planSignal(s, ctx, { equity: 10000, open: [] });
    ok(!errors.length || plan.decision === 'NO TRADE', 'invalid TRADE leaked: ' + errors.join('; '));
    ok(P.validatePlan(plan).length === 0, 'plan fails the contract: ' + P.validatePlan(plan).join('; '));
    if (plan.decision === 'TRADE') { trades++; ok(plan.risk_pct > 0 && plan.size_units > 0, 'TRADE without size'); ok(plan.targets[0].rr >= 1.3, 'target under 1.3R'); }
    else ok(plan.no_trade_reasons.length > 0, 'NO TRADE without reasons');
  }
}
console.log(`sample bars (min score 60, then 0): ${seen} plans -> ${trades} TRADE, ${seen - trades} NO TRADE`);
ok(seen > 0 && trades > 0, 'the sample bars should give both outcomes');
// 2. hand-made signals for each rule
const base = { tf: '1H', dir: 1, side: 'BUY', score: 72, price: 2000, atr: 10, origin: 1996, stopIdea: 1993, patterns: ['sweep'], why: ['swept the 22-bar low', 'with the higher-timeframe trend', 'only 0.4 ATR from the origin (early)'], at: Date.UTC(2026, 10, 4, 9) };
const ctx0 = { symbol: 'XAU/USD', minScore: 60, now: base.at + 36e5, fingerprint: { trd: 'trending', pd: 'favourable', div: 'none' } };
let p = P.buildPlanFromDetect(base, ctx0);
ok(p.decision === 'TRADE' && p.entry_type === 'limit', 'sweep -> limit TRADE');
A.deepStrictEqual(p.entry_zone, [1996, 1997.5]); n++;
ok(p.invalidation === 1993 && Math.abs(p.stop_distance - 3.75) < 1e-9, 'stop from stopIdea, distance from zone mid');
A.deepStrictEqual(p.targets.map(t => [t.price, t.rr]), [[1996.75 + 1.5 * 3.75, 1.5], [1996.75 + 2.5 * 3.75, 2.5]]); n++;
ok(p.time_stop_bars === 12 && p.expires_at === base.at + 12 * 36e5, '1H time stop');
ok(p.id === `XAU/USD|1H|${base.at}` && p.confidence === 72, 'id and confidence');
ok(P.validatePlan(p).length === 0, P.validatePlan(p).join('; '));
// ignition -> stop entry just beyond price; SELL mirror
p = P.buildPlanFromDetect({ ...base, dir: -1, side: 'SELL', patterns: ['ignition'], origin: 2008, stopIdea: 2011 }, ctx0);
A.deepStrictEqual([p.entry_type, p.entry_zone], ['stop', [1999, 2000]]); n++;
ok(p.invalidation === 2011 && p.targets.every(t => t.price < 1999.5), 'SELL ignition levels');
// fallback stop and wrong-side repair
p = P.buildPlanFromDetect({ ...base, stopIdea: undefined }, ctx0); ok(Math.abs(p.invalidation - (1996 - 3.5)) < 1e-9, 'fallback origin - 0.35 ATR');
p = P.buildPlanFromDetect({ ...base, stopIdea: 2005 }, ctx0); ok(p.invalidation < p.entry_zone[0] && P.validatePlan(p).length === 0, 'stop forced below the zone');
// fib targets
p = P.buildPlanFromDetect(base, { ...ctx0, fib: { r1272: 2003.0, r1618: 2008.2, r2: 2011, up: true } });
ok(p.targets.length === 3 && p.targets.some(t => t.label === 'Fib 1.618') && p.targets.map(t => t.rr).join() === [...p.targets.map(t => t.rr)].sort((a, b) => a - b).join(), 'fib target added and sorted: ' + JSON.stringify(p.targets));
p = P.buildPlanFromDetect(base, { ...ctx0, fib: { r1272: 2003.0, r1618: 2008.2, r2: 2011, up: false } }); ok(p.targets.length === 2, 'fib of the other direction ignored');
// gates
const reasons = (s, c) => P.buildPlanFromDetect({ ...base, ...s }, { ...ctx0, ...c });
p = reasons({ score: 55 }); ok(p.decision === 'NO TRADE' && /below the minimum 60/.test(p.no_trade_reasons[0]), 'score gate');
p = reasons({ price: 2022 }); ok(p.decision === 'NO TRADE' && /2.6 ATR/.test(p.no_trade_reasons.join()), 'late gate > 2.5 ATR');
p = reasons({ price: 2015 }); ok(p.decision === 'TRADE' && p.confidence === 64 && /Late entry/.test(p.kill_conditions[0]), '1.8-2.5 ATR: -8 and a kill condition');
p = reasons({ why: ['against the higher-timeframe trend (counter-trend start)'] }); ok(p.confidence === 62 && /Counter-trend/.test(p.kill_conditions.join()), 'counter-trend -10');
p = reasons({}, { fingerprint: { trd: 'ranging', pd: 'unfavourable', div: 'none' } }); ok(p.confidence === 72 - 12 - 8, 'ranging -12 and unfavourable -8');
p = reasons({}, { trackRecord: { rate: 0.35, n: 22, weak: false } }); ok(p.decision === 'NO TRADE' && /weak track record/.test(p.no_trade_reasons.join()), 'track record block');
p = reasons({}, { trackRecord: { rate: 0.45, n: 16 } }); ok(p.decision === 'TRADE' && p.confidence === 62 && /Half size/.test(p.kill_conditions.join()), 'marginal track record');
p = reasons({}, { orderBlocks: [{ dir: -1, lo: 2005, hi: 2007 }, { dir: 1, lo: 2004, hi: 2005 }, { dir: -1, lo: 2030, hi: 2032 }] }); ok(p.kill_conditions.filter(k => /Opposing order block/.test(k)).length === 1, 'opposing OB within 1.2 ATR only');
p = reasons({}, { session: { levels: [{ name: 'Previous day high', p: 2003 }, { name: 'Asia low', p: 1990 }, { name: 'Previous week high', p: 2020 }] } }); ok(p.kill_conditions.filter(k => /ahead: abort/.test(k)).length === 1, 'session level within 0.8 ATR ahead only');
p = reasons({ price: 1992 }); ok(p.decision === 'NO TRADE' && /through the invalidation/.test(p.no_trade_reasons[0]), 'price through the stop');
ok(P.validatePlan(reasons({ atr: 0 })).length === 0 && reasons({ atr: 0 }).decision === 'NO TRADE', 'missing ATR -> valid NO TRADE');
const c15 = P.buildPlanFromDetect({ ...base, tf: '15M' }, ctx0); ok(c15.time_stop_bars === 16 && c15.expires_at === base.at + 16 * 9e5, '15M time stop');
// 3. sizePlan
const T = P.buildPlanFromDetect(base, ctx0);
let z = P.sizePlan(T, { equity: 10000, open: [] });
// risk 0.5% of 10 000 = 50; stop 3.75 x 100 oz = 375 per lot -> 0.1333 -> 0.13 lots -> 0.4875%
ok(z.ok && z.size_units === 0.13 && z.risk_pct === 0.49, 'XAU sizing ' + JSON.stringify(z));
z = P.sizePlan({ ...T, fingerprint: { ...T.fingerprint, trd: 'ranging' } }, { equity: 10000 }); ok(z.ok && z.size_units === 0.05 && z.risk_pct === 0.19, 'ranging 0.4 x 0.5% = 0.2% -> 0.05 lots ' + JSON.stringify(z));
z = P.sizePlan({ ...T, fingerprint: { ...T.fingerprint, trd: 'ranging' } }, { equity: 10000 }, { baseRiskPct: 0.3 }); ok(!z.ok && /floor/.test(z.reasons.join()), '0.4 x 0.3% = 0.12% is under the floor');
z = P.sizePlan({ ...T, fingerprint: { ...T.fingerprint, trd: 'transition' } }, { equity: 100000 }); ok(z.ok && Math.abs(z.risk_pct - 0.35) < 0.01, 'transition 0.7x');
z = P.sizePlan(T, { equity: 10000, open: [{ symbol: 'EUR/USD', risk_pct: 1 }, { symbol: 'GBP/USD', risk_pct: 1.2 }] }); ok(!z.ok && /heat/.test(z.reasons[0]), 'heat cap 2.5%');
z = P.sizePlan(T, { equity: 100000, open: [{ symbol: 'XAG/USD', risk_pct: 0.7 }] }); ok(z.ok && Math.abs(z.risk_pct - 0.3) < 0.01 && z.groupRisk === 0.7, 'metals group cut to 0.3%: ' + JSON.stringify(z));
z = P.sizePlan(T, { equity: 10000, open: [{ symbol: 'XAG/USD', risk_pct: 0.9 }] }); ok(!z.ok, 'group cut under the floor rejects');
z = P.sizePlan({ ...T, targets: [{ price: 2000, rr: 1.2 }] }, { equity: 10000 }); ok(!z.ok && /below the minimum 1.4R/.test(z.reasons[0]), 'minRR');
z = P.sizePlan(T, { equity: 10000 }, { trackRecord: { rate: 0.45, n: 16 } }); ok(z.ok && z.size_units === 0.06, 'marginal track record halves the size');
z = P.sizePlan(T, { equity: 10000 }, { trackRecord: { weak: true, n: 25, rate: 0.3 } }); ok(!z.ok, 'weak track record rejects');
const late = P.buildPlanFromDetect({ ...base, patterns: ['ignition'], origin: 1985, stopIdea: 1982, price: 2000 }, ctx0);
z = P.sizePlan(late, { equity: 100000 }, { price: 2000 }); ok(z.ok && Math.abs(z.risk_pct - 0.375) < 0.01 && /0.75x/.test(z.reasons[0]), 'late run 1.5 ATR -> 0.75x ' + JSON.stringify(z));
z = P.sizePlan({ ...T, decision: 'NO TRADE' }, { equity: 10000 }); ok(!z.ok, 'NO TRADE is never sized');
const eu = P.buildPlanFromDetect({ ...base, price: 1.1600, atr: 0.0015, origin: 1.1590, stopIdea: 1.1585 }, { ...ctx0, symbol: 'EUR/USD' });
z = P.sizePlan(eu, { equity: 10000 }); ok(z.ok && Math.abs(z.size_units - Math.floor(50 / (eu.stop_distance * 100000) / 0.01 + 1e-9) * 0.01) < 1e-9, 'FX sizing ' + JSON.stringify(z) + ' d=' + eu.stop_distance);
const failed = P.applySize(T, { ok: false, reasons: ['portfolio heat'] }); ok(failed.decision === 'NO TRADE' && failed.no_trade_reasons.includes('portfolio heat') && P.validatePlan(failed).length === 0, 'applySize turns a failed size into NO TRADE');
ok(P.groupsOf('EUR/JPY').join() === 'euro,yen' && P.groupsOf('XAU/USD').join() === 'metals', 'groups');
// 4. validator catches broken plans
const good = P.applySize(T, P.sizePlan(T, { equity: 10000 }));
const bad = (f, re) => { const q = JSON.parse(JSON.stringify(good)); f(q); const e = P.validatePlan(q); ok(e.some(x => re.test(x)), 'validator missed ' + re + ': ' + e.join('; ')); };
bad(q => q.entry_zone = [1997.5, 1996], /ordered/); bad(q => q.invalidation = 1998, /wrong side|inside/); bad(q => q.targets = [], /1 to 3/);
bad(q => q.targets.reverse(), /sorted/); bad(q => q.targets[0].rr = 3, /does not match/); bad(q => q.time_stop_bars = 10, /time_stop_bars/);
bad(q => q.decision = 'MAYBE', /decision/); bad(q => q.no_trade_reasons = ['x'], /cannot carry/); bad(q => q.patterns = ['vibes'], /subset/);
bad(q => { q.decision = 'NO TRADE'; q.no_trade_reasons = []; }, /needs at least one reason/);
// 5. model plan through the same gates
const mp = P.planFromModel({ decision: 'BUY', order: 'BUY LIMIT', entry: '1996.50', 'stop loss': '1992.00', tp1: '2004.00', tp2: '2010', reason: 'Sweep of the Asia low into 4H demand.' }, { symbol: 'XAU/USD', tf: '1H', atr: 10, price: 2000, now: base.at, fingerprint: { trd: 'trending' } });
ok(mp.decision === 'TRADE' && mp.source === 'coach' && P.validatePlan(mp).length === 0, 'model plan -> TRADE ' + P.validatePlan(mp).join('; '));
ok(P.planFromModel({ decision: 'BUY', order: 'BUY LIMIT', entry: '2001', 'stop loss': '1992', tp1: '2010' }, { symbol: 'XAU/USD', atr: 10, price: 2000, now: 1 }).decision === 'NO TRADE', 'limit above the market rejected');
ok(P.planFromModel({ decision: 'NO TRADE' }, { symbol: 'XAU/USD', atr: 10, now: 1 }).decision === 'NO TRADE', 'model NO TRADE stays NO TRADE');
const weakModel = P.planFromModel({ decision: 'SELL', order: 'MARKET', 'stop loss': '2005', tp1: '1996' }, { symbol: 'XAU/USD', atr: 10, price: 2000, now: 1 });
ok(weakModel.decision === 'NO TRADE' && weakModel.targets[0].rr === 0.8 && /no target reaches 1.3R/.test(weakModel.no_trade_reasons.join()), 'a 0.8R model plan is refused by the code gate');
ok(P.validatePlan(weakModel).length === 0, 'and is a valid NO TRADE');
// 6. alert text
const txt = P.renderPlanAlert(good); ok(/✅ XAU\/USD BUY: TRADE/.test(txt) && /Abort if:/.test(txt) && /Risk: 0.49%/.test(txt), txt);
const nt = P.renderPlanAlert(reasons({ score: 50 })); ok(/⛔/.test(nt) && /Reasons: score 50/.test(nt) && /Levels it would have used/.test(nt), nt);
if (require.main === module) { console.log(txt + '\n\n' + nt); console.log(`\n${n} checks passed`); }
module.exports = { n };
