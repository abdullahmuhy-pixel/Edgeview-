/* Edgeview daily goal (v44). Shared by the app (window.EVGoal) and Node tests. Analysis only: the trader places every trade.
   "I have $4,800 in the account. I want to make $180 today." becomes a goal state; every TRADE plan the normal gates pass
   gets a lot size, the money at risk, what it can add to the goal, and how many more good trades are still likely needed.
   The goal never lowers a standard: only plans that are already TRADE after EVPlan's gates and sizing are offered,
   risk per trade is capped at 1%, there is a soft daily trade limit and a daily loss limit, and an unrealistic goal is
   called unrealistic with the arithmetic. Everything here is pure: no DOM, no network.
     parseGoalText(text)                    what the message sets, reports or asks
     newGoal / applyGoalPatch / recordResult / refreshGoal     state
     assessGoal(state, stats)               required R, trades needed, chance of reaching it, verdict
     goalContext(plan, state, opts)         size the plan for the goal and attach goal_context
     rankForGoal(plans, state, opts)        only TRADE plans, sized one after another (heat), ordered for the goal
     resolveRecs(state, barsBySym, now)     paper-track recommended plans with EVPlan.planOutcome
     handleGoalMessage(text, state, ctx)    the conversational turn: new state + reply text + whether to look for trades
     renderGoalPlan / goalStatusText / noTradesText    text for the chat and alerts */
(function (root) {
  'use strict';
  const P = typeof module !== 'undefined' && module.exports ? require('./tradePlan.js') : root.EVPlan;
  const num = x => { const v = typeof x === 'number' ? x : parseFloat(String(x == null ? '' : x).replace(/,/g, '')); return isFinite(v) ? v : null; };
  const r2 = x => Math.round(x * 100) / 100;
  const DEF = { risk_per_trade_pct: 0.5, max_risk_pct: 1.0, max_trades_today: 3, max_daily_loss_pct: 2.0, avg_win_r: 1.8, win_rate: 0.45, min_contribution_pct: 10 };

  // ---- day key in the trader's time zone (Intl only; falls back to UTC)
  function dayKey(t, tz) {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t)); }
    catch (e) { return new Date(t).toISOString().slice(0, 10); }
  }
  const money = (x, cur) => { const v = num(x); if (v == null) return 'n/a'; const w = Math.abs(v), s = w >= 100 || Math.abs(w - Math.round(w)) < 0.005 ? Math.round(w).toLocaleString('en-US') : w.toFixed(2); return (v < 0 ? '-' : '') + (cur || '$') + s; };
  const pct = x => (Math.round(x * 100) / 100).toString() + '%';
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

  // ---- 1. parsing: numbers with $, R, €, £, "k", commas
  const AMT = String.raw`(\$|usd\s?|us\$|€|eur\s?|£|gbp\s?|r(?=\s?\d)|zar\s?)?\s?(\d{1,3}(?:[, ]\d{3})+(?![\d.,])|\d+)(?:\.(\d+))?\s?(k\b)?`;
  const amtOf = m => { if (!m) return null; let v = +(m[2].replace(/[, ]/g, '') + (m[3] ? '.' + m[3] : '')); if (m[4]) v *= 1000; return isFinite(v) ? v : null; };
  const curOf = s => { s = String(s || '').trim().toLowerCase(); return !s ? null : /\$|usd/.test(s) ? '$' : /€|eur/.test(s) ? '€' : /£|gbp/.test(s) ? '£' : /^r$|zar/.test(s) ? 'R' : null; };
  const SYM_WORDS = [[/\bgold\b|\bxau/i, 'XAU/USD'], [/\bsilver\b|\bxag/i, 'XAG/USD'], [/\bbitcoin\b|\bbtc/i, 'BTC/USD'], [/\bether(eum)?\b|\beth\b/i, 'ETH/USD']];
  function parseGoalText(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim(), lo = t.toLowerCase(), out = { set: {}, intents: [], result: null, symbols: [], currencies: [] };
    if (!t) return out;
    // balance
    let m = lo.match(new RegExp(String.raw`(?:account(?: balance)?|balance|equity|capital|i have|i've got|i got|sitting at)\s*(?:is|of|at|=|:|now)?\s*(?:about |around |roughly )?` + AMT + String.raw`(?!\s?%|\d)`, 'i'));
    if (m && amtOf(m) > 0) { out.set.balance = amtOf(m); const c = curOf(m[1]); if (c) out.set.currency = c; }
    // risk per trade
    m = lo.match(/\brisk(?:ing)?\b[^%\d]{0,25}?(\d+(?:\.\d+)?)\s?%/); if (m) out.set.risk = +m[1];
    // daily loss limit
    m = lo.match(new RegExp(String.raw`(?:max(?:imum)? (?:daily )?loss|loss limit|stop (?:if|after|when) (?:i )?(?:lose|lost|am down|i'm down)|don'?t (?:want to )?lose more than)\D{0,12}?` + AMT + String.raw`\s?(%)?`, 'i'));
    if (m) { const v = amtOf(m); if (m[5]) out.set.max_loss_pct = v; else out.set.max_loss_abs = v; }
    // trade limit
    m = lo.match(/(?:max(?:imum)?|no more than|at most|up to|only)\s*(\d{1,2})\s*trades?/) || lo.match(/\b(\d{1,2})\s*trades?\s*(?:max|a day|per day|today)\b/);
    if (m) out.set.max_trades = +m[1];
    if (/\bone more trade\b/.test(lo)) out.set.max_trades_plus = 1;
    // target (absolute or %), unless the sentence is a reported result
    const past = /\b(won|made|banked|profited|took profit|closed|lost|stopped out|hit (?:my )?(?:stop|sl|tp\d?|target))\b/.test(lo);
    m = lo.match(new RegExp(String.raw`(?:make|earn|target|goal|want|need|aim(?:ing)? for|get|hit|reach|grow (?:it|the account) by|make it)\s*(?:of|is|to|at|=|:|another|about|around)?\s*(?:make |earn |get )?` + AMT + String.raw`\s?(%|percent)?`, 'i'));
    const tgtWords = /\b(today|daily|a day|per day|goal|target|this session)\b/.test(lo);
    if (m && amtOf(m) > 0 && !(past && !tgtWords) && !(out.set.risk != null && m[5] && +m[2] === out.set.risk)) {
      if (m[5]) out.set.target_pct = amtOf(m); else { out.set.target = amtOf(m); const c = curOf(m[1]); if (c && !out.set.currency) out.set.currency = c; }
    }
    // results the trader reports ("won $40", "lost 24", "+1.5R", "hit TP1", "stopped out")
    if (past) {
      const neg = /\b(lost|stopped out|hit (?:my )?(?:stop|sl))\b/.test(lo);
      const rm = lo.match(/([+-]?\d+(?:\.\d+)?)\s?r\b/), am = lo.match(new RegExp(String.raw`(?:won|made|banked|profited|took profit(?: of)?|closed[^\d$€£]{0,20}|lost|for|of)\s*` + AMT, 'i'));
      if (rm) out.result = { r: (neg ? -1 : 1) * Math.abs(+rm[1]) };
      else if (am && amtOf(am) != null) out.result = { amount: (neg ? -1 : 1) * amtOf(am) };
      else if (/\bhit (?:my )?(tp\d?|target)\b/.test(lo)) out.result = { tp: true };
      else if (neg) out.result = { r: -1 };
      if (out.result) { out.intents.push('result'); delete out.set.target; delete out.set.target_pct; }
    }
    if (/\b(find|show|give|get|any|what|scan|look for|search)\b.{0,40}\b(trades?|setups?|opportunit\w*|entr(?:y|ies)|ideas?)\b|\bbest (?:setup|trade)\b|\bsomething (?:on|in|for)\b|\bwhat (?:should|can) i (?:trade|take)\b/.test(lo)) out.intents.push('trades');
    if (/\b(how much|what'?s|what is)\b.{0,25}\b(left|remaining|still need|to go)\b|\bprogress\b|\bwhere am i\b|\bstatus\b|\bhow am i doing\b|\bleft to (?:hit|reach|make)\b/.test(lo)) out.intents.push('progress');
    if (/\b(pause|stop for (?:the )?(?:day|today)|done for (?:the )?(?:day|today)|i'?m done)\b/.test(lo)) out.intents.push('pause');
    if (/\b(resume|unpause|carry on|back on)\b/.test(lo)) out.intents.push('resume');
    if (/\b(cancel|clear|delete|remove|reset|forget)\b.{0,12}\bgoal\b/.test(lo)) out.intents.push('clear');
    if (/\b(track|count|use)\b.{0,20}\bpaper\b|\bsimulated progress\b/.test(lo)) out.set.track_paper = !/\b(don'?t|do not|stop|no)\b.{0,15}\b(track|count|use)\b/.test(lo);
    for (const [re, s] of SYM_WORDS) if (re.test(t)) out.symbols.push(s);
    for (const x of t.toUpperCase().match(/\b[A-Z]{3}\/?[A-Z]{3}\b/g) || []) { const k = x.replace('/', ''); if (/^(EUR|GBP|USD|JPY|AUD|NZD|CAD|CHF|XAU|XAG)/.test(k) && /(EUR|GBP|USD|JPY|AUD|NZD|CAD|CHF)$/.test(k)) out.symbols.push(k.slice(0, 3) + '/' + k.slice(3)); }
    for (const x of t.toUpperCase().match(/\b(EUR|GBP|JPY|AUD|NZD|CAD|CHF|YEN|EURO|POUND|CABLE)\b/g) || []) out.currencies.push({ YEN: 'JPY', EURO: 'EUR', POUND: 'GBP', CABLE: 'GBP' }[x] || x);
    out.symbols = [...new Set(out.symbols)]; out.currencies = [...new Set(out.currencies)];
    if (Object.keys(out.set).some(k => /balance|target|risk|max_|currency/.test(k))) out.intents.unshift('set');
    return out;
  }

  // ---- 2. state
  function newGoal(o, now, tz) {
    const s = {
      version: 1, day: dayKey(now, tz), account_balance: null, starting_balance: null, daily_target_profit: null, daily_target_pct: null, remaining_to_goal: null,
      risk_per_trade_pct: DEF.risk_per_trade_pct, max_trades_today: DEF.max_trades_today, max_daily_loss_pct: DEF.max_daily_loss_pct,
      trades_taken: 0, realized: 0, results: [], recs: [], track_paper: false, currency: '$', created_at: now, status: 'active', pause_reason: '', notes: [],
    };
    return applyGoalPatch(s, o || {}, now);
  }
  // patch keys as parseGoalText().set returns them
  function applyGoalPatch(st, x, now) {
    const s = { ...st, results: [...(st.results || [])], recs: [...(st.recs || [])], notes: [] };
    if (x.currency) s.currency = x.currency;
    if (num(x.balance) > 0) { s.account_balance = num(x.balance); if (!s.trades_taken) s.starting_balance = s.account_balance; else s.starting_balance = r2(s.account_balance - s.realized); }
    if (num(x.risk) > 0) { const r = num(x.risk); s.risk_per_trade_pct = Math.min(r, DEF.max_risk_pct); if (r > DEF.max_risk_pct) s.notes.push(`Risk is capped at ${DEF.max_risk_pct}% per trade; ${r}% would let two losses take a big bite out of the day.`); }
    if (num(x.max_trades) > 0) { s.max_trades_today = Math.min(num(x.max_trades), 8); if (num(x.max_trades) > 8) s.notes.push('Capped at 8 trades a day: past that, overtrading usually costs more than it earns.'); }
    if (x.max_trades_plus) s.max_trades_today = Math.min(8, s.max_trades_today + 1);
    if (num(x.max_loss_pct) > 0) s.max_daily_loss_pct = Math.min(num(x.max_loss_pct), 5);
    if (num(x.max_loss_abs) > 0 && s.starting_balance > 0) s.max_daily_loss_pct = Math.min(r2(num(x.max_loss_abs) / s.starting_balance * 100), 5);
    if (x.track_paper != null) s.track_paper = !!x.track_paper;
    if (num(x.target_pct) > 0) { s.daily_target_pct = num(x.target_pct); s.daily_target_profit = s.starting_balance > 0 ? r2(s.starting_balance * s.daily_target_pct / 100) : null; }
    else if (num(x.target) > 0) { s.daily_target_profit = num(x.target); s.daily_target_pct = s.starting_balance > 0 ? r2(s.daily_target_profit / s.starting_balance * 100) : null; }
    else if (s.daily_target_pct != null && s.starting_balance > 0 && num(x.balance) > 0) s.daily_target_profit = r2(s.starting_balance * s.daily_target_pct / 100);   // % goal set before the balance
    if (x.status) { s.status = x.status; s.pause_reason = x.pause_reason || ''; }
    return refreshGoal(s, now);
  }
  function refreshGoal(st, now) {
    const s = { ...st }; const tgt = num(s.daily_target_profit);
    s.realized = r2((s.results || []).reduce((a, x) => a + (num(x.amount) || 0), 0));
    if (s.starting_balance > 0) s.account_balance = r2(s.starting_balance + s.realized);
    s.remaining_to_goal = tgt != null ? r2(Math.max(0, tgt - s.realized)) : null;
    const lossLimit = s.starting_balance > 0 ? s.starting_balance * s.max_daily_loss_pct / 100 : null;
    if (s.status === 'paused' && s.pause_reason === 'you paused it') return s;
    if (tgt != null && s.realized >= tgt - 1e-9) { s.status = 'reached'; s.pause_reason = ''; }
    else if (lossLimit != null && s.realized <= -lossLimit + 1e-9) { s.status = 'paused'; s.pause_reason = `the daily loss limit (${s.max_daily_loss_pct}%) is reached`; }
    else if (s.trades_taken >= s.max_trades_today) { s.status = 'paused'; s.pause_reason = `the ${s.max_trades_today}-trade limit for today is used`; }
    else if (s.status === 'unrealistic' || s.status === 'active' || s.status === 'reached' || s.status === 'paused') { s.status = s.unrealistic ? 'unrealistic' : 'active'; s.pause_reason = ''; }
    return s;
  }
  const isToday = (s, now, tz) => !!s && s.day === dayKey(now, tz);
  const ready = s => !!s && s.account_balance > 0 && s.daily_target_profit > 0;
  const riskAmount = s => r2(s.account_balance * s.risk_per_trade_pct / 100);

  // ---- 3. honesty: what the goal needs, and the chance of getting there
  // stats: { win_rate, avg_win_r, n } from the trader's own closed trades (perfStats); shrunk toward defaults when n is small.
  function statsFor(stats) {
    const n = num(stats && stats.n) || 0, w = n > 0 ? (n / (n + 20)) : 0;
    const wr = stats && num(stats.win_rate) != null ? w * num(stats.win_rate) + (1 - w) * DEF.win_rate : DEF.win_rate;
    const aw = stats && num(stats.avg_win_r) > 0 ? w * num(stats.avg_win_r) + (1 - w) * DEF.avg_win_r : DEF.avg_win_r;
    return { win_rate: Math.min(0.75, Math.max(0.2, wr)), avg_win_r: Math.min(4, Math.max(0.8, aw)), n, own: n >= 10 };
  }
  // exact chance of reaching `need` R within `left` trades: each trade +W or -1; stop when reached or the loss limit is hit
  function reachChance(need, left, p, W, lossR) {
    if (need <= 0) return 1; if (left <= 0) return 0;
    const go = (k, sum) => { if (sum >= need - 1e-9) return 1; if (k === 0 || (lossR != null && sum <= -lossR + 1e-9)) return 0; return p * go(k - 1, sum + W) + (1 - p) * go(k - 1, sum - 1); };
    return go(Math.min(left, 10), 0);
  }
  function assessGoal(s, stats) {
    if (!ready(s)) return null;
    const S = statsFor(stats), risk = riskAmount(s), need = s.remaining_to_goal, needR = risk > 0 ? need / risk : Infinity, left = Math.max(0, s.max_trades_today - s.trades_taken);
    const lossR = s.starting_balance > 0 ? (s.starting_balance * s.max_daily_loss_pct / 100 + Math.min(0, s.realized)) / risk : null;
    const winsNeeded = need <= 0 ? 0 : Math.ceil(needR / S.avg_win_r - 1e-9), chance = reachChance(needR, left, S.win_rate, S.avg_win_r, lossR);
    const tPct = s.daily_target_pct != null ? s.daily_target_pct : (s.starting_balance > 0 ? s.daily_target_profit / s.starting_balance * 100 : null);
    // risk % that would make the goal one average winner, and a target worth about a 50% chance at the current risk
    const riskForOne = s.account_balance > 0 && need > 0 ? need / (s.account_balance * S.avg_win_r) * 100 : 0;
    let fair = 0; for (let R = 0.25; R <= S.avg_win_r * Math.max(1, left); R += 0.25) if (reachChance(R, left, S.win_rate, S.avg_win_r, lossR) >= 0.5) fair = R;
    const why = [];
    if (need <= 0) return { verdict: 'reached', needR: 0, winsNeeded: 0, left, chance: 1, risk, stats: S, tPct, riskForOne: 0, fairTarget: 0, why };
    if (winsNeeded > left) why.push(`it needs at least ${plural(winsNeeded, 'winning trade')} at ${S.own ? 'your' : 'a typical'} average win of ${S.avg_win_r.toFixed(1)}R, more than the ${plural(left, 'trade')} left today`);
    if (tPct != null && tPct > 5) why.push(`${pct(r2(tPct))} of the account in a day is beyond what a survivable risk can deliver`);
    if (chance < 0.15) why.push(`with a ${Math.round(S.win_rate * 100)}% win rate the chance of getting there in ${plural(left, 'trade')} is about ${Math.round(chance * 100)}%`);
    const verdict = why.length ? 'unrealistic' : (chance < 0.35 || (tPct != null && tPct > 2)) ? 'stretch' : 'realistic';
    return { verdict, needR, winsNeeded, left, chance, risk, stats: S, tPct, riskForOne, fairTarget: r2(fair * risk), why };
  }

  // ---- 4. the plan under the goal: size it at the goal's risk and attach goal_context
  // opts: { open: [{symbol, risk_pct}], trackRecord, price, contractSize, quoteToAccount, stats }
  function goalContext(plan, s, opts) {
    opts = opts || {};
    if (!plan || plan.decision !== 'TRADE' || !ready(s)) return { ...plan, goal_context: null };
    const sz = P.sizePlan(plan, { equity: s.account_balance, open: opts.open || [] }, { baseRiskPct: s.risk_per_trade_pct, maxRiskPct: Math.min(DEF.max_risk_pct, s.risk_per_trade_pct), trackRecord: opts.trackRecord, price: opts.price, contractSize: opts.contractSize, quoteToAccount: opts.quoteToAccount });
    const Q = P.applySize(plan, sz); if (Q.decision !== 'TRADE') return { ...Q, goal_context: null };
    const cs = num(opts.contractSize) || P.contractSizeOf(Q.symbol), q2a = num(opts.quoteToAccount) || 1;
    const riskAmt = r2(Q.size_units * Q.stop_distance * cs * q2a), rem = s.remaining_to_goal, S = statsFor(opts.stats);
    const atT = Q.targets.map(t => r2(riskAmt * t.rr)), first = atT[0] || 0;
    const contribution = rem > 0 ? r2(first / rem * 100) : 0;
    const after = rem - first, still = after <= 0 ? 0 : Math.ceil(after / (riskAmt * S.avg_win_r) - 1e-9);
    return { ...Q, goal_context: { remaining_to_goal: rem, suggested_lot_size: Q.size_units, potential_profit_1r: riskAmt, potential_profit_at_targets: atT, contribution_to_goal_pct: contribution, trades_still_needed_estimate: still, risk_amount: riskAmt, risk_pct_of_account: s.account_balance > 0 ? r2(riskAmt / s.account_balance * 100) : null, approx_size: !opts.quoteToAccount && !/USD$/.test(String(Q.symbol).replace('/', '').toUpperCase().replace(/USDT$/, 'USD')) } };
  }
  // only TRADE plans; each is sized with the earlier picks counted as open risk, so heat and correlation limits hold for the set
  function rankForGoal(plans, s, opts) {
    opts = opts || {}; const out = { picks: [], skipped: [], blocked: null };
    if (!ready(s)) { out.blocked = 'no goal yet'; return out; }
    if (s.status === 'reached') { out.blocked = 'reached'; return out; }
    if (s.status === 'paused') { out.blocked = s.pause_reason || 'paused'; return out; }
    const left = Math.max(0, s.max_trades_today - s.trades_taken); if (!left) { out.blocked = `the ${s.max_trades_today}-trade limit for today is used`; return out; }
    const open = [...(opts.open || [])], minC = opts.minContribution != null ? opts.minContribution : DEF.min_contribution_pct, pool = [];
    for (const p of plans || []) {
      if (!p) continue; if (p.decision !== 'TRADE') { out.skipped.push({ plan: p, why: (p.no_trade_reasons || []).join('; ') || 'NO TRADE' }); continue; }
      if (p.expires_at != null && opts.now != null && p.expires_at <= opts.now) { out.skipped.push({ plan: p, why: 'the plan has expired' }); continue; }
      pool.push(p);
    }
    pool.sort((a, b) => b.confidence - a.confidence || (b.targets[0].rr - a.targets[0].rr));
    const seen = new Set();
    for (const p of pool) {
      if (out.picks.length >= Math.min(left, opts.max || 3)) break;
      const key = p.symbol + (p.side > 0 ? 'B' : 'S'); if (seen.has(key)) continue;
      const o = (opts.perPlan && opts.perPlan(p)) || {}, q = goalContext(p, s, { ...o, open, stats: opts.stats });
      if (q.decision !== 'TRADE') { out.skipped.push({ plan: q, why: q.no_trade_reasons.join('; ') }); continue; }
      if (q.goal_context.contribution_to_goal_pct < minC) { out.skipped.push({ plan: q, why: `it would add only ${q.goal_context.contribution_to_goal_pct}% of what is left (size cut by the risk rules)` }); continue; }
      seen.add(key); out.picks.push(q); open.push({ symbol: q.symbol, risk_pct: q.risk_pct });
    }
    // best for the goal first: confidence, then how much of the remaining goal TP1 covers
    out.picks.sort((a, b) => (b.confidence + Math.min(100, b.goal_context.contribution_to_goal_pct) / 4) - (a.confidence + Math.min(100, a.goal_context.contribution_to_goal_pct) / 4));
    return out;
  }

  // ---- 5. results: the trader's own report, or paper-tracked recommendations
  function recordResult(st, res, now) {
    const s = { ...st, results: [...(st.results || [])], recs: [...(st.recs || [])] };
    let amount = num(res && res.amount);
    const lastRec = [...s.recs].reverse().find(r => r.st === 'open' || r.st === 'taken') || s.recs[s.recs.length - 1];
    const riskAmt = lastRec && lastRec.risk_amount ? lastRec.risk_amount : (ready(s) ? riskAmount(s) : null);
    if (amount == null && res && res.r != null && riskAmt) amount = r2(num(res.r) * riskAmt);
    if (amount == null && res && res.tp && lastRec) amount = r2(lastRec.profit_tp1);
    if (amount == null) return { state: s, applied: null };
    s.results.push({ t: now, amount: r2(amount), src: (res && res.src) || 'you', ...(lastRec && !(res && res.src === 'paper') ? { rec: lastRec.id } : {}), ...(res && res.r != null ? { r: num(res.r) } : {}) });
    if (lastRec && !(res && res.src === 'paper')) { const i = s.recs.indexOf(lastRec); s.recs[i] = { ...lastRec, st: 'closed' }; }
    s.trades_taken += 1;
    return { state: refreshGoal(s, now), applied: r2(amount) };
  }
  // remember what was recommended, so "hit TP1" and paper tracking know the money involved
  function noteRecs(st, picks, now) {
    const s = { ...st, recs: [...(st.recs || [])] };
    for (const q of picks || []) if (q && q.goal_context && !s.recs.some(r => r.id === q.id)) s.recs.push({ id: q.id, at: now, symbol: q.symbol, side: q.side, risk_amount: q.goal_context.risk_amount, profit_tp1: q.goal_context.potential_profit_at_targets[0], lots: q.goal_context.suggested_lot_size, st: 'open', plan: q });
    s.recs = s.recs.slice(-30); return s;
  }
  // paper tracking: resolve open recommendations on later candles; counts toward the goal only when track_paper is on
  function resolveRecs(st, barsBySym, now) {
    let s = { ...st, recs: [...(st.recs || [])] }; const done = [];
    for (let i = 0; i < s.recs.length; i++) {
      const r = s.recs[i]; if (r.st !== 'open' || !r.plan) continue;
      const o = P.planOutcome(r.plan, (barsBySym || {})[r.symbol + '|' + r.plan.tf] || (barsBySym || {})[r.symbol]); if (!o) continue;
      const amt = o.res === 'win' || o.res === 'loss' || o.res === 'timeout' ? r2(o.r * r.risk_amount) : 0;
      s.recs[i] = { ...r, st: 'paper ' + o.res, paper: { ...o, amount: amt } }; done.push({ rec: s.recs[i], outcome: o, amount: amt });
      if (s.track_paper && (o.res === 'win' || o.res === 'loss' || o.res === 'timeout')) s = recordResult(s, { amount: amt, src: 'paper' }, now).state;
    }
    return { state: s, done };
  }

  // ---- 6. text
  function goalStatusText(s, a, opts) {
    opts = opts || {}; if (!s) return 'No goal set for today. Tell me your balance and what you want to make, for example "Account is $5,000, I want $100 today".';
    const C = s.currency, L = [];
    if (!(s.account_balance > 0)) return 'What is your account balance? I need it to size the trades.';
    if (!(s.daily_target_profit > 0)) return `Balance ${money(s.account_balance, C)}. What do you want to make today, in money or as a percentage?`;
    if (s.status === 'reached') {
      L.push(`🎉 Goal reached: ${money(s.realized, C)} today against a ${money(s.daily_target_profit, C)} target.`);
      L.push('That was the job for today. I suggest stopping here, or switching to capital protection: no new trades, and move any open trade\'s stop to break-even once it allows.');
      return L.join('\n');
    }
    const head = opts.short ? [] : [`Goal: ${money(s.daily_target_profit, C)} today on ${money(s.starting_balance, C)}${s.daily_target_pct != null ? ` (${pct(s.daily_target_pct)})` : ''}.`];
    L.push(...head);
    L.push(`So far ${money(s.realized, C)} from ${plural(s.trades_taken, 'trade')}; ${money(s.remaining_to_goal, C)} still needed. Risk ${pct(s.risk_per_trade_pct)} a trade = ${money(riskAmount(s), C)}; ${plural(Math.max(0, s.max_trades_today - s.trades_taken), 'trade')} left of ${s.max_trades_today}; daily loss limit ${pct(s.max_daily_loss_pct)} (${money(s.starting_balance * s.max_daily_loss_pct / 100, C)}).`);
    if (s.status === 'paused') L.push(`Paused: ${s.pause_reason}. No new trades from me today${/loss limit/.test(s.pause_reason) ? ': protecting the account matters more than the goal' : ''}.`);
    if (a && s.status !== 'paused') {
      L.push(`What it takes: ${a.needR.toFixed(1)}R at this risk, so at least ${plural(a.winsNeeded, 'winning trade')} at ${a.stats.own ? 'your' : 'a typical'} average win of ${a.stats.avg_win_r.toFixed(1)}R. Chance of reaching it in ${plural(a.left, 'trade')} with a ${Math.round(a.stats.win_rate * 100)}% win rate${a.stats.own ? '' : ' (typical; your journal has under 10 closed trades)'}: about ${Math.round(a.chance * 100)}%.`);
      if (a.verdict === 'unrealistic') L.push(`Honest view: unrealistic, because ${a.why.join(', and ')}. ${a.fairTarget > 0 ? `${s.trades_taken ? 'About ' + money(Math.round(a.fairTarget), C) + ' more today' : 'A goal of about ' + money(Math.round(a.fairTarget), C)} has roughly even odds at this risk.` : ''}${a.riskForOne > DEF.max_risk_pct ? ` Getting it from one average winner would need ${a.riskForOne.toFixed(1)}% risk, above my ${DEF.max_risk_pct}% cap.` : ''} I will still look for trades, but only ones that pass the usual standards.`);
      else if (a.verdict === 'stretch') L.push(`Honest view: a stretch. Possible on a good day, so the standards stay the same and we stop at the trade limit either way.${a.fairTarget > 0 && a.fairTarget < s.remaining_to_goal ? ` About ${money(a.fairTarget, C)} would be an even-odds day.` : ''}`);
      else L.push('Honest view: realistic at this risk if the market gives clean setups.');
    }
    return L.join('\n');
  }
  function renderGoalPlan(q, s, opts) {
    const g = q && q.goal_context, C = s ? s.currency : '$'; if (!g) return P.renderPlanAlert(q, opts);
    const tl = q.targets.map((t, i) => `${t.rr.toFixed(1)}R about ${money(g.potential_profit_at_targets[i], C)} (${g.remaining_to_goal > 0 ? Math.round(g.potential_profit_at_targets[i] / g.remaining_to_goal * 100) : 0}% of what is left)`);
    const extra = [
      `Suggested lot size: ${g.suggested_lot_size}${g.approx_size ? ' (approximate: the quote currency is not your account currency)' : ''}`,
      `Risk: ${money(g.risk_amount, C)} (${pct(g.risk_pct_of_account)} of the account)`,
      `If it reaches TP1 at ${tl[0]}.${tl.length > 1 ? ' Further targets: ' + tl.slice(1).join('; ') + '.' : ''}`,
      g.trades_still_needed_estimate === 0 ? 'This one trade can finish today\'s goal at TP1.' : g.potential_profit_at_targets.some(x => x >= g.remaining_to_goal) ? `It finishes the goal only if it runs to ${q.targets[g.potential_profit_at_targets.findIndex(x => x >= g.remaining_to_goal)].rr.toFixed(1)}R; at TP1 we would still need about ${plural(g.trades_still_needed_estimate, 'more good trade')}.` : `We would still need roughly ${plural(g.trades_still_needed_estimate, 'more good trade')} after this.`,
    ];
    // the goal lines replace the plain risk line and sit under the levels, before the reasons and abort conditions
    const L = P.renderPlanAlert(q, opts).split('\n').filter(l => !/^Risk: .*% of equity/.test(l)), i = L.findIndex(l => /^Time stop:/.test(l));
    L.splice(i < 0 ? L.length : i, 0, ...extra); return L.join('\n');
  }
  function noTradesText(rk, s) {
    if (!rk) return '';
    if (rk.blocked === 'reached') return goalStatusText(s);
    if (rk.blocked && rk.blocked !== 'no goal yet') return `No new trades from me: ${rk.blocked}. ${/loss limit/.test(rk.blocked) ? 'Stopping here protects the account for tomorrow.' : 'Say "one more trade" if you really want to raise the limit, but more trades usually add risk, not edge.'}`;
    const L = ['No suitable trades right now that fit the goal and my quality standards.'];
    const why = {}; for (const x of rk.skipped || []) { const k = x.why.split(';')[0]; why[k] = (why[k] || 0) + 1; }
    const top = Object.entries(why).sort((a, b) => b[1] - a[1]).slice(0, 4);
    if (top.length) L.push('What I checked and why it failed: ' + top.map(([k, n]) => `${k}${n > 1 ? ` (${n} setups)` : ''}`).join('; ') + '.');
    else L.push('No early-move signal and no saved analysis passed the gates on the pairs I scanned.');
    L.push('I would rather miss the goal than force a weak trade. Ask again after the next candle closes or at the next session open.');
    return L.join('\n');
  }

  // ---- 7. one conversational turn. ctx: { now, tz, stats }. Returns { state, reply, wantTrades, symbols, currencies, handled }
  function handleGoalMessage(text, st, ctx) {
    ctx = ctx || {}; const now = ctx.now || Date.now(), x = parseGoalText(text), out = { state: st, reply: '', wantTrades: false, symbols: x.symbols, currencies: x.currencies, handled: false, parsed: x };
    let s = st && isToday(st, now, ctx.tz) ? st : null;
    if (x.intents.includes('clear')) { out.state = null; out.reply = 'Goal cleared. Tell me a new one whenever you like.'; out.handled = true; return out; }
    if (x.intents.includes('set')) {
      const fresh = !s || (x.set.balance > 0 && (x.set.target > 0 || x.set.target_pct > 0) && !s.trades_taken);
      s = fresh ? newGoal(x.set, now, ctx.tz) : applyGoalPatch(s, x.set, now);
      const a = assessGoal(s, ctx.stats); s = { ...s, unrealistic: !!(a && a.verdict === 'unrealistic') }; s = refreshGoal(s, now);
      const notes = s.notes && s.notes.length ? '\n' + s.notes.join(' ') : '';
      out.reply = (ready(s) ? `Got it. ${goalStatusText(s, a)}` : goalStatusText(s, a)) + notes + (ready(s) && !x.intents.includes('trades') ? '\nSay "find me trades" when you want me to scan.' : '');
      out.handled = true;
    }
    if (x.intents.includes('result') && s) {
      const r = recordResult(s, x.result, now); s = r.state;
      out.reply += (out.reply ? '\n\n' : '') + (r.applied == null ? 'How much was it, in money or in R?' : `${r.applied >= 0 ? 'Nice' : 'Noted'}: ${money(r.applied, s.currency)} logged.\n` + goalStatusText(s, assessGoal(s, ctx.stats), { short: true }));
      out.handled = true;
    }
    if (x.intents.includes('pause') && s) { s = { ...s, status: 'paused', pause_reason: 'you paused it' }; out.reply += (out.reply ? '\n\n' : '') + 'Paused for today. I will not suggest new trades until you say resume.'; out.handled = true; }
    if (x.intents.includes('resume') && s) { s = refreshGoal({ ...s, status: 'active', pause_reason: '' }, now); out.reply += (out.reply ? '\n\n' : '') + goalStatusText(s, assessGoal(s, ctx.stats), { short: true }); out.handled = true; }
    if (x.set.track_paper != null && s && !x.intents.includes('set')) { s = { ...s, track_paper: x.set.track_paper }; out.reply += (out.reply ? '\n\n' : '') + (s.track_paper ? 'Paper results of my recommendations will now count toward the goal.' : 'Paper results will no longer count; only results you report.'); out.handled = true; }
    if (x.intents.includes('progress')) { out.reply += (out.reply ? '\n\n' : '') + goalStatusText(s, s ? assessGoal(s, ctx.stats) : null); out.handled = true; }
    if (x.intents.includes('trades')) {
      out.handled = true;
      if (!s || !ready(s)) out.reply += (out.reply ? '\n\n' : '') + (s ? goalStatusText(s) : 'Tell me your balance and today\'s target first, for example "Account is $4,800, I want $180 today", and I will size every trade for it.');
      else out.wantTrades = true;
    }
    out.state = s;
    return out;
  }

  const api = { DEF, dayKey, money, parseGoalText, newGoal, applyGoalPatch, refreshGoal, isToday, ready, riskAmount, statsFor, reachChance, assessGoal, goalContext, rankForGoal, recordResult, noteRecs, resolveRecs, goalStatusText, renderGoalPlan, noTradesText, handleGoalMessage };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.EVGoal = api;
})(typeof window !== 'undefined' ? window : globalThis);
