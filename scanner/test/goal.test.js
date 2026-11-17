// node scanner/test/goal.test.js : the daily goal layer
const A = require('assert'), G = require('../../goal.js'), P = require('../../tradePlan.js');
let n = 0; const ok = (c, m) => { A.ok(c, m); n++; }; const eq = (a, b, m) => { A.deepStrictEqual(a, b, m); n++; };
const now = Date.UTC(2026, 10, 17, 8), tz = 'Africa/Johannesburg';
// 1. parsing the phrasings from the brief
let x = G.parseGoalText('I have $4,800 in the account. I want to make $180 today.');
eq([x.set.balance, x.set.target, x.set.currency], [4800, 180, '$']); ok(x.intents[0] === 'set', 'set intent');
x = G.parseGoalText('Account is $5200, I want $200 today'); eq([x.set.balance, x.set.target], [5200, 200]);
x = G.parseGoalText('Make it 3% today'); eq([x.set.target_pct, x.set.balance], [3, undefined]);
x = G.parseGoalText('Change risk to 0.75% per trade'); eq([x.set.risk, x.set.target, x.set.target_pct], [0.75, undefined, undefined]);
x = G.parseGoalText('Find me trades to reach the goal'); ok(x.intents.includes('trades') && x.set.target == null, 'find trades');
x = G.parseGoalText('Show me the best setup right now for the goal'); ok(x.intents.includes('trades'), 'best setup');
x = G.parseGoalText('I need something on gold or EUR'); ok(x.intents.includes('trades') && x.symbols.includes('XAU/USD') && x.currencies.includes('EUR'), 'gold or EUR ' + JSON.stringify(x));
x = G.parseGoalText("What's left to hit today's target?"); ok(x.intents.includes('progress') && x.set.target == null, 'progress ' + JSON.stringify(x));
x = G.parseGoalText('I won $40 on gold'); eq(x.result, { amount: 40 }); ok(!x.set.target, 'a result is not a target');
x = G.parseGoalText('lost 24'); eq(x.result, { amount: -24 });
x = G.parseGoalText('stopped out'); eq(x.result, { r: -1 });
x = G.parseGoalText('closed EUR/USD for +1.6R'); eq(x.result, { r: 1.6 });
x = G.parseGoalText('hit TP1'); eq(x.result, { tp: true });
x = G.parseGoalText('balance R25 000? no: my balance is R25,000 and I want R500 today'); eq([x.set.balance, x.set.target, x.set.currency], [25000, 500, 'R']);
x = G.parseGoalText('account 5k, target 1.5% today, max 2 trades'); eq([x.set.balance, x.set.target_pct, x.set.max_trades], [5000, 1.5, 2]);
x = G.parseGoalText('risk 3% per trade'); eq(x.set.risk, 3);
// 2. state and the honesty check
let s = G.newGoal({ balance: 4800, target: 180 }, now, tz);
eq([s.daily_target_pct, s.remaining_to_goal, s.risk_per_trade_pct, s.max_trades_today, s.status], [3.75, 180, 0.5, 3, 'active']);
let a = G.assessGoal(s, null);
ok(a.risk === 24 && Math.abs(a.needR - 7.5) < 1e-9 && a.winsNeeded === 5 && a.verdict === 'unrealistic', 'unrealistic $180 on $4,800 ' + JSON.stringify(a));
ok(a.chance === 0, '3 trades of +1.8R cannot reach 7.5R');
// brute force the even-odds target independently: all 2^3 paths, stop on reaching R or the loss limit (2% = 96 = 4R)
const exactSmall = (R, left, p, W) => { const go = (k, sum) => sum >= R - 1e-9 ? 1 : k === 0 ? 0 : p * go(k - 1, sum + W) + (1 - p) * go(k - 1, sum - 1); return go(left, 0); };
ok(Math.abs(G.reachChance(1.8, 3, 0.45, 1.8, null) - exactSmall(1.8, 3, 0.45, 1.8)) < 1e-12, 'reachChance recursion');
// 1.8R in 3 trades: W first (0.45), or L then W W (-1 + 1.8 + 1.8 = 2.6): 0.45 + 0.55 x 0.45^2 = 0.561375; L W alone is only +0.8R
ok(Math.abs(G.reachChance(1.8, 3, 0.45, 1.8, null) - (0.45 + 0.55 * 0.45 ** 2)) < 1e-12, 'paths to 1.8R');
// 3.6R needs two wins; with W=1.8 a loss in between still lets two wins reach 2.6 < 3.6, so: WW, WLW? 1.8-1+1.8=2.6 no, LWW 2.6 no -> only W W first two: 0.45^2
ok(Math.abs(G.reachChance(3.6, 3, 0.45, 1.8, null) - 0.45 ** 2) < 1e-12, 'two wins in a row needed');
ok(a.fairTarget === 1.75 * 24 || a.fairTarget === 1.5 * 24 || a.fairTarget > 0, 'fair target found ' + a.fairTarget);
// a realistic goal
let s2 = G.newGoal({ balance: 10000, target: 50, risk: 0.5 }, now, tz), a2 = G.assessGoal(s2, { win_rate: 0.5, avg_win_r: 1.8, n: 40 });
ok(a2.verdict === 'realistic' && a2.winsNeeded === 1, 'realistic ' + JSON.stringify(a2));
// risk cap and notes
let s3 = G.applyGoalPatch(s, { risk: 3 }, now); ok(s3.risk_per_trade_pct === 1 && /capped at 1%/.test(s3.notes[0]), 'risk capped at 1%');
// percentage goal before the balance is known
let s4 = G.newGoal({ target_pct: 3 }, now, tz); ok(s4.daily_target_profit == null, 'no money yet'); s4 = G.applyGoalPatch(s4, { balance: 5200 }, now); ok(s4.daily_target_profit === 156, '3% of 5200 ' + s4.daily_target_profit);
// 3. goal context: the sweep plan from the plan tests (XAU, stop 3.75)
const base = { tf: '1H', dir: 1, side: 'BUY', score: 72, price: 2000, atr: 10, origin: 1996, stopIdea: 1993, patterns: ['sweep'], why: ['swept the 22-bar low', 'with the higher-timeframe trend'], at: now - 36e5 };
const plan = P.buildPlanFromDetect(base, { symbol: 'XAU/USD', minScore: 60, now, fingerprint: { trd: 'trending', pd: 'favourable', div: 'none' } });
let q = G.goalContext(plan, s, {});
// 0.5% of 4800 = 24; 3.75 x 100 = 375 per lot -> 0.064 -> 0.06 lots -> $22.50 risk; TP1 1.5R = $33.75 = 18.75% of 180
eq([q.goal_context.suggested_lot_size, q.goal_context.risk_amount, q.goal_context.potential_profit_at_targets, q.goal_context.contribution_to_goal_pct], [0.06, 22.5, [33.75, 56.25], 18.75]);
// still needed after TP1: (180 - 33.75) / (22.5 x 1.8) = 3.61 -> 4
ok(q.goal_context.trades_still_needed_estimate === 4, 'trades still needed ' + q.goal_context.trades_still_needed_estimate);
ok(P.validatePlan(q).length === 0, 'goal plan is still a valid plan ' + P.validatePlan(q).join('; '));
const txt = G.renderGoalPlan(q, s); ok(/Suggested lot size: 0.06/.test(txt) && /Risk: \$22.50 \(0.47% of the account\)/.test(txt) && /about \$33.75 \(19% of what is left\)/.test(txt) && /4 more good trades/.test(txt), txt);
// one trade can finish a small goal
q = G.goalContext(plan, s2, {}); ok(q.goal_context.trades_still_needed_estimate === 0 && /finish today's goal/.test(G.renderGoalPlan(q, s2)), 'finishes the goal');
// 4. ranking: NO TRADE never offered, heat and correlation counted across picks, duplicates dropped
const weak = P.buildPlanFromDetect({ ...base, score: 40 }, { symbol: 'EUR/USD', minScore: 60, now });
const silver = P.buildPlanFromDetect({ ...base, price: 30, atr: 0.2, origin: 29.9, stopIdea: 29.84, score: 68 }, { symbol: 'XAG/USD', minScore: 60, now, fingerprint: { trd: 'trending' } });
let rk = G.rankForGoal([weak, plan, plan, silver], G.newGoal({ balance: 100000, target: 2000 }, now, tz), { now });
ok(rk.picks.length === 2 && rk.picks.every(p => p.decision === 'TRADE') && rk.skipped.some(x => /below the minimum/.test(x.why)), 'NO TRADE skipped, duplicate dropped ' + JSON.stringify(rk.skipped.map(x => x.why)));
// metals group cap 1%: gold 0.5% then silver gets at most the remaining 0.5%
ok(rk.picks.reduce((t, p) => t + p.risk_pct, 0) <= 1.0001, 'metals group total within 1%');
rk = G.rankForGoal([weak], s, { now }); ok(!rk.picks.length && /No suitable trades right now/.test(G.noTradesText(rk, s)) && /below the minimum/.test(G.noTradesText(rk, s)), G.noTradesText(rk, s));
// contribution floor: a tiny size is skipped, not shown
rk = G.rankForGoal([plan], G.newGoal({ balance: 4800, target: 2000 }, now, tz), { now }); ok(!rk.picks.length && /would add only/.test(rk.skipped[0].why), 'under 10% contribution skipped');
// expired plan skipped
rk = G.rankForGoal([plan], s, { now: plan.expires_at + 1 }); ok(!rk.picks.length && /expired/.test(rk.skipped[0].why), 'expired');
// 5. results, limits, reached
let st = G.noteRecs(s, [G.goalContext(plan, s, {})], now);
let r = G.recordResult(st, { tp: true }, now); ok(r.applied === 33.75 && r.state.remaining_to_goal === 146.25 && r.state.trades_taken === 1, 'hit TP1 uses the recommended size');
r = G.recordResult(r.state, { r: -1 }, now); ok(r.applied === -22.5, 'stopped out = -1R of the last recommendation ' + r.applied);
r = G.recordResult(r.state, { amount: -50 }, now); ok(r.state.status === 'paused' && /3-trade limit/.test(r.state.pause_reason), 'trade limit pauses ' + r.state.pause_reason);
ok(G.rankForGoal([plan], r.state, { now }).blocked, 'no picks when paused');
let L = G.newGoal({ balance: 5000, target: 100 }, now, tz); L = G.recordResult(L, { amount: -100 }, now).state; ok(L.status === 'paused' && /loss limit/.test(L.pause_reason), 'daily loss limit 2% = $100');
let W = G.recordResult(G.newGoal({ balance: 5000, target: 100 }, now, tz), { amount: 120 }, now).state; ok(W.status === 'reached' && /Goal reached/.test(G.goalStatusText(W)) && /capital protection/.test(G.goalStatusText(W)), 'reached');
// 6. paper tracking with planOutcome
const H = 36e5, bars = [{ t: now, o: 2000, h: 2001, l: 1997, c: 1998 }, { t: now + H, o: 1998, h: 1999, l: 1996.5, c: 1998 }, { t: now + 2 * H, o: 1998, h: 2003.5, l: 1997.5, c: 2003 }];
const pl2 = { ...plan, created_at: now };
eq(P.planOutcome(pl2, bars), { res: 'win', r: 1.5, fillAt: now + H, at: now + 2 * H });
eq(P.planOutcome(pl2, [{ t: now, o: 2000, h: 2000, l: 1992, c: 1995 }]).res, 'cancelled');
eq(P.planOutcome(pl2, [{ t: now + H, o: 1997, h: 1998, l: 1996.6, c: 1997 }, { t: now + 2 * H, o: 1997, h: 1997, l: 1992.5, c: 1993 }]).res, 'loss');
let pst = G.noteRecs({ ...s, track_paper: true }, [G.goalContext(pl2, s, {})], now);
const rr = G.resolveRecs(pst, { 'XAU/USD|1H': bars }, now + 3 * H); ok(rr.done.length === 1 && rr.state.realized === 33.75 && rr.state.results[0].src === 'paper', 'paper win counts when tracking is on');
const rr2 = G.resolveRecs(G.noteRecs(s, [G.goalContext(pl2, s, {})], now), { 'XAU/USD|1H': bars }, now + 3 * H); ok(rr2.done.length === 1 && rr2.state.realized === 0, 'paper result not counted when tracking is off');
// 7. the conversation
let t = G.handleGoalMessage('I have $4,800 in the account. I want to make $180 today.', null, { now, tz });
ok(t.handled && t.state.daily_target_profit === 180 && t.state.status === 'unrealistic' && /unrealistic/.test(t.reply) && /7.5R/.test(t.reply), t.reply);
console.log('\n--- set goal ---\n' + t.reply);
t = G.handleGoalMessage('Change risk to 0.75% per trade', t.state, { now, tz }); ok(t.state.risk_per_trade_pct === 0.75 && t.state.daily_target_profit === 180 && /\$36/.test(t.reply), t.reply);
console.log('\n--- risk ---\n' + t.reply);
t = G.handleGoalMessage('Find me trades to reach the goal', t.state, { now, tz }); ok(t.wantTrades, 'asks the app to scan');
t = G.handleGoalMessage('I won $40', t.state, { now, tz }); ok(t.state.remaining_to_goal === 140 && /\$40 logged/.test(t.reply), t.reply);
console.log('\n--- result ---\n' + t.reply);
t = G.handleGoalMessage("What's left to hit today's target?", t.state, { now, tz }); ok(/\$140 still needed/.test(t.reply), t.reply);
ok(G.handleGoalMessage('Find me trades', null, { now, tz }).wantTrades === false, 'no goal: ask for one first');
ok(G.handleGoalMessage('Find me trades', t.state, { now: now + 864e5, tz }).wantTrades === false, 'yesterday\'s goal does not carry over');
t = G.handleGoalMessage('how does an order block work?', t.state, { now, tz }); ok(!t.handled, 'other questions go to the coach');
console.log('\n--- plan under the goal ---\n' + txt);
if (require.main === module) console.log(`\n${n} checks passed`);
