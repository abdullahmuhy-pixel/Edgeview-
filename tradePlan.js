/* Edgeview trade-plan layer (v44). Shared by the app (window.EVPlan), the hourly scanner and the live robot (Node).
   Turns every high-score EVDetect signal, and every model "final trade plan", into one strict, measurable object:
   either a TRADE with an entry zone, a hard invalidation, targets in R, a time stop and kill conditions, or a
   NO TRADE with the reasons. The TRADE / NO TRADE gate is made here in code, never by a model.
     buildPlanFromDetect(signal, ctx)   signal -> plan (pure)
     planFromModel(g, ctx)              parsed model plan -> plan, through the same gates (pure)
     sizePlan(plan, account, opts)      risk engine: regime, late run, track record, heat, correlation groups (pure)
     applySize(plan, sized)             plan with risk filled, or turned into NO TRADE with the reasons (pure)
     validatePlan(plan)                 [] when the plan honours the contract, otherwise the errors
     renderPlanAlert(plan, opts)        plain text for Telegram and the in-app alert list
   Bars are oldest first: {t (ms, bar open UTC), o, h, l, c, v}. Nothing here touches the DOM or the network. */
(function (root) {
  'use strict';
  const TA = typeof module !== 'undefined' && module.exports ? require('./ta.js') : root.EVTA;
  const dec = x => { const a = Math.abs(+x); return a >= 1000 ? 2 : a >= 20 ? 3 : a >= 0.1 ? 5 : a >= 0.001 ? 6 : 8; };
  const fx = TA && TA.fx ? TA.fx : (x => x == null || !isFinite(x) ? 'n/a' : (+x).toFixed(dec(x)));
  const num = x => { const v = typeof x === 'number' ? x : parseFloat(String(x == null ? '' : x).replace(/,/g, '')); return isFinite(v) ? v : null; };
  const rnd = (x, ref) => +(+x).toFixed(Math.min(8, dec(ref == null ? x : ref) + 1));      // one digit more than display precision
  const r2 = x => Math.round(x * 100) / 100;
  const fr = (x, ref) => x == null || !isFinite(x) ? 'n/a' : (+x).toFixed(dec(ref == null ? x : ref));   // a distance shown with the price's decimals

  // ---- schema constants
  const VERSION = '1.0';
  const TFS = ['15M', '1H', '4H'];
  const TF_MS = { '15M': 9e5, '1H': 36e5, '4H': 144e5 };
  const TIME_STOP_BARS = { '15M': 16, '1H': 12, '4H': 8 };
  const PATTERNS = ['sweep', 'choch', 'squeeze', 'ignition'];
  const ENTRY_TYPES = ['limit', 'stop', 'market'];
  const SOURCES = ['detect', 'coach', 'scanner', 'live'];
  const FP = { trd: ['trending', 'ranging', 'transition'], pd: ['favourable', 'unfavourable', 'equilibrium'], div: ['with', 'against', 'none'] };
  const DEFAULTS = {
    minScore: 60, maxSlippageR: 0.15, minTargetRR: 1.3,
    baseRiskPct: 0.5, maxRiskPct: 1.0, maxHeatPct: 2.5, maxGroupPct: 1.0, minRR: 1.4, lateRunATR: 2.0, floorRiskPct: 0.15,
    regimeMult: { trending: 1.0, transition: 0.7, ranging: 0.4 }, lotStep: 0.01, minLot: 0.01,
  };
  // simple correlation groups: a symbol joins every group one of its legs belongs to
  const GROUPS = {
    metals: ['XAU', 'XAG', 'XPT', 'XPD'], euro: ['EUR'], sterling: ['GBP'], yen: ['JPY'], franc: ['CHF'],
    commodity: ['AUD', 'NZD', 'CAD', 'ZAR', 'MXN', 'NOK'], dollar: ['USD'], crypto: ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'ADA', 'DOGE'],
    indices: ['US500', 'SPX', 'NAS100', 'NDX', 'US30', 'DJI', 'GER40', 'DAX', 'UK100', 'JP225'],
  };

  const tfNorm = tf => { const s = String(tf || '').toUpperCase().replace(/\s/g, ''); return s === '15' || s === 'M15' || s === '15MIN' ? '15M' : s === 'H1' || s === '60' || s === '1HOUR' ? '1H' : s === 'H4' || s === '240' ? '4H' : s; };
  const legs = sym => { const k = String(sym || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/USDT$|USDC$/, 'USD'); return /^[A-Z]{6}$/.test(k) ? [k.slice(0, 3), k.slice(3)] : [k]; };
  function groupsOf(sym) {
    const L = legs(sym), out = [];
    for (const [g, ms] of Object.entries(GROUPS)) if (L.some(l => ms.includes(l))) out.push(g);
    // the dollar leg is shared by most pairs: count it only when it is the only group (e.g. a USD index)
    return out.length > 1 ? out.filter(g => g !== 'dollar') : out;
  }
  // contract size per 1.0 lot for the common MetaTrader specs; pass opts.contractSize for anything else
  function contractSizeOf(sym) {
    const L = legs(sym); if (L[0] === 'XAU') return 100; if (L[0] === 'XAG') return 5000; if (L[0] === 'XPT' || L[0] === 'XPD') return 100;
    if (L.length === 2 && GROUPS.crypto.includes(L[0])) return 1; if (L.length === 2) return 100000; return 1;
  }
  const fpNorm = f => { const o = { trd: null, pd: null, div: null }; if (f) for (const k of Object.keys(o)) o[k] = FP[k].includes(f[k]) ? f[k] : null; return o; };
  const obList = ob => Array.isArray(ob) ? ob : ob && typeof ob === 'object' ? Object.values(ob).filter(Array.isArray).flat() : [];
  const trackOf = tr => tr && typeof tr === 'object' ? { rate: num(tr.rate), n: num(tr.n) || 0, weak: !!tr.weak, strong: !!tr.strong } : null;
  // track-record thresholds shared by the plan gate and the risk engine
  function trackGate(tr) {
    const t = trackOf(tr); if (!t) return { level: 'none' };
    const pct = t.rate != null ? Math.round(t.rate * 100) : null, txt = pct != null ? `${pct}% of ${t.n} followed through` : `weak over ${t.n}`;
    if (t.weak || (t.n >= 20 && t.rate != null && t.rate < 0.40)) return { level: 'block', txt };
    if (t.n >= 15 && t.rate != null && t.rate < 0.48) return { level: 'marginal', txt };
    return { level: 'ok', txt };
  }

  // ---- targets: 1.5R and 2.5R always, plus one useful Fibonacci extension (beyond ~1.3R in the trade direction)
  function makeTargets(side, mid, d, fib) {
    const T = [{ price: mid + side * 1.5 * d, rr: 1.5, label: '1.5R' }, { price: mid + side * 2.5 * d, rr: 2.5, label: '2.5R' }];
    if (fib && (fib.up == null || (fib.up ? 1 : -1) === side)) {
      const F = [['r1272', 'Fib 1.272'], ['r1618', 'Fib 1.618'], ['r2', 'Fib 2.0']].map(([k, lab]) => ({ price: num(fib[k]), label: lab }))
        .filter(x => x.price != null).map(x => ({ ...x, rr: side * (x.price - mid) / d })).filter(x => x.rr >= 1.3).sort((a, b) => a.rr - b.rr);
      for (const f of F) { if (T.length >= 3) break; if (T.every(t => Math.abs(t.rr - f.rr) >= 0.2)) T.push(f); }
    }
    return T.sort((a, b) => a.rr - b.rr).slice(0, 3).map(t => ({ price: rnd(t.price, mid), rr: r2(t.rr), label: t.label }));
  }

  // ---- the gate both builders share: returns { decision, confidence, kill, reasons }
  function gate(P, ctx, extra) {
    const side = P.side, a = P.atr, mid = (P.entry_zone[0] + P.entry_zone[1]) / 2, d = P.stop_distance, kill = [], reasons = [];
    let conf = extra.conf;
    const minScore = num(ctx.minScore) != null ? num(ctx.minScore) : DEFAULTS.minScore;
    // 1. score
    if (extra.useScore && P.score < minScore) reasons.push(`score ${P.score} is below the minimum ${minScore}`);
    // 2. late: how far price already is from the origin, in ATRs
    const run = extra.price != null ? side * (extra.price - P.origin) / a : 0;
    if (run > 2.5) reasons.push(`price is already ${run.toFixed(1)} ATR from the origin ${fx(P.origin)} (the move has gone)`);
    else if (run >= 1.8) { conf -= 8; kill.push(`Late entry (${run.toFixed(1)} ATR from the origin): abort if price is not 0.5R in profit within ${Math.ceil(P.time_stop_bars / 2)} bars`); }
    // 3. counter-trend start
    if ((extra.why || []).some(w => /against the higher-timeframe trend/i.test(w))) { conf -= 10; kill.push(`Counter-trend: abort if a ${P.tf} candle closes back beyond the origin ${fx(P.origin)} before 1R`); }
    // 4-5. fingerprint
    if (P.fingerprint.trd === 'ranging') { conf -= 12; kill.push(`Ranging market (ADX and efficiency low): abort if 1R is not reached within ${Math.ceil(P.time_stop_bars / 2)} bars; do not hold for the last target`); }
    if (P.fingerprint.pd === 'unfavourable') { conf -= 8; kill.push(`${side > 0 ? 'Buying in the premium' : 'Selling in the discount'} of the 4H dealing range: abort if the first push stalls before 1R and price closes back inside the entry zone`); }
    // 6. track record of this signal type
    const tg = trackGate(ctx.trackRecord);
    if (tg.level === 'block') reasons.push(`this signal type has a weak track record (${tg.txt})`);
    else if (tg.level === 'marginal') { conf -= 10; kill.push(`Half size: this signal type is marginal (${tg.txt}); abort at the time stop if TP1 is not reached`); }
    // 7. opposing order block ahead within 1.2 ATR
    for (const ob of obList(ctx.orderBlocks)) {
      const lo = num(ob.lo), hi = num(ob.hi); if (ob.dir !== -side || lo == null || hi == null) continue;
      const dist = side > 0 ? lo - mid : mid - hi, ahead = side > 0 ? hi > mid : lo < mid;
      if (ahead && dist <= 1.2 * a) kill.push(`Opposing order block ${fx(lo)}-${fx(hi)} ${dist > 0 ? (dist / a).toFixed(1) + ' ATR ahead' : 'around the entry'}: abort if a candle wicks into it and closes back ${side > 0 ? 'below' : 'above'} ${fx(side > 0 ? lo : hi)} before TP1`);
    }
    // 8. session or liquidity level ahead within 0.8 ATR
    const lv = ctx.session && Array.isArray(ctx.session.levels) ? ctx.session.levels : [];
    for (const l of lv) {
      const p = num(l.p); if (p == null) continue; const dist = side * (p - mid);
      if (dist > 0 && dist <= 0.8 * a) kill.push(`${l.name} ${fx(p)} is ${(dist / a).toFixed(1)} ATR ahead: abort if price is rejected there (closes back through ${fx(mid)}) before TP1`);
    }
    // targets
    if (!P.targets.some(t => t.rr >= DEFAULTS.minTargetRR)) reasons.push(`no target reaches ${DEFAULTS.minTargetRR}R`);
    // standing kill conditions of every plan
    if (P.entry_type !== 'market') kill.push(`Cancel the ${P.entry_type} order if price trades through ${fx(P.invalidation)} before it fills, or if it has not filled by the time stop`);
    kill.push(`Close at the time stop (${P.time_stop_bars} x ${P.tf} bars) if TP1 has not been reached`);
    kill.push(`Skip the fill if slippage would exceed ${P.max_slippage_r}R (${fr(P.max_slippage_r * d, mid)})`);
    return { decision: reasons.length ? 'NO TRADE' : 'TRADE', confidence: Math.max(0, Math.min(100, Math.round(conf))), kill, reasons };
  }

  function skeleton(o) {
    return {
      version: VERSION, id: `${o.symbol}|${o.tf}|${o.at}`, symbol: o.symbol, tf: o.tf, side: o.side, decision: 'NO TRADE',
      entry_zone: null, entry_type: null, invalidation: null, stop_distance: null, targets: [], time_stop_bars: TIME_STOP_BARS[o.tf] || null, time_stop_ms: null,
      origin: o.origin, atr: o.atr, score: o.score, patterns: o.patterns, fingerprint: fpNorm(o.fingerprint),
      risk_pct: null, size_units: null, max_slippage_r: DEFAULTS.maxSlippageR, kill_conditions: [], no_trade_reasons: [],
      thesis: o.thesis, confidence: 0, created_at: o.now, expires_at: null, source: SOURCES.includes(o.source) ? o.source : 'detect',
    };
  }
  const thesisOf = (why, fallback) => { const w = (why || []).filter(Boolean).slice(0, 3).map(x => String(x).replace(/\.$/, '')); return w.length ? w.map(x => x[0].toUpperCase() + x.slice(1)).join('. ') + '.' : fallback; };

  // ---- 2. buildPlanFromDetect(signal, ctx): pure
  function buildPlanFromDetect(signal, ctx) {
    ctx = ctx || {}; const s = signal || {};
    const tf = tfNorm(s.tf), side = s.dir === 1 || s.dir === -1 ? s.dir : s.side === 'BUY' ? 1 : s.side === 'SELL' ? -1 : 0;
    const a = num(s.atr), px = num(s.price), origin = num(s.origin), score = Math.max(0, Math.min(100, Math.round(num(s.score) || 0)));
    const at = num(s.at) != null ? num(s.at) : num(ctx.now) || 0, now = num(ctx.now) != null ? num(ctx.now) : at + (TF_MS[tf] || 0);
    const patterns = (s.patterns || []).filter(p => PATTERNS.includes(p));
    const P = skeleton({ symbol: String(ctx.symbol || s.sym || s.symbol || '?'), tf, side, at, origin, atr: a, score, patterns, fingerprint: ctx.fingerprint, now, source: ctx.source || 'detect',
      thesis: thesisOf(s.why, `${patterns.join(' + ') || 'signal'} ${side > 0 ? 'BUY' : 'SELL'} on ${tf}.`) });
    const bad = [];
    if (!TFS.includes(tf)) bad.push(`unknown timeframe ${s.tf}`); if (!side) bad.push('signal has no side');
    if (!(a > 0)) bad.push('ATR is missing or zero'); if (px == null || origin == null) bad.push('signal has no price or origin');
    if (bad.length) { P.side = side || 1; P.no_trade_reasons = bad; return P; }
    // entry zone
    let z;
    if (patterns.includes('sweep') || patterns.includes('choch')) { z = [origin, origin + side * 0.15 * a]; P.entry_type = 'limit'; }
    else { z = [px, px + side * 0.10 * a]; P.entry_type = 'stop'; }
    z = z.map(v => rnd(v, px)).sort((x, y) => x - y); P.entry_zone = z;
    const mid = (z[0] + z[1]) / 2, near = side > 0 ? z[0] : z[1];
    // invalidation: stopIdea, else origin -/+ 0.35 ATR; always beyond the whole entry zone
    let inv = num(s.stopIdea); if (inv == null) inv = origin - side * 0.35 * a;
    if (side * (near - inv) <= 0.05 * a) inv = near - side * 0.35 * a;
    P.invalidation = rnd(inv, px); P.stop_distance = rnd(Math.abs(mid - P.invalidation), px);
    if (side * (px - P.invalidation) <= 0) { P.no_trade_reasons = [`price ${fx(px)} is already through the invalidation ${fx(P.invalidation)}`]; return P; }
    P.targets = makeTargets(side, mid, P.stop_distance, ctx.fib);
    P.time_stop_ms = at + P.time_stop_bars * TF_MS[tf]; P.expires_at = P.time_stop_ms;
    const g = gate(P, ctx, { conf: score, useScore: true, price: px, why: s.why });
    P.decision = g.decision; P.confidence = g.confidence; P.kill_conditions = g.kill; P.no_trade_reasons = g.reasons;
    return P;
  }

  // ---- coach / live path: a parsed model plan (decision, order, entry, stop loss, tp1..tp3, valid until) through the same gates.
  // g keys are lower case as parseFinal returns them; side/levels may also come as {side:'BUY', entry, sl, tp:[..]} from the live robot.
  function planFromModel(g, ctx) {
    ctx = ctx || {}; g = g || {};
    const dtxt = String(g.decision || g.side || '').toUpperCase(), side = /NO\s*TRADE/.test(dtxt) ? 0 : /BUY/.test(dtxt) || g.side === 'BUY' ? 1 : /SELL/.test(dtxt) || g.side === 'SELL' ? -1 : 0;
    const tf = TFS.includes(tfNorm(ctx.tf)) ? tfNorm(ctx.tf) : '1H', a = num(ctx.atr), px = num(ctx.price), now = num(ctx.now) || 0;
    const ord = String(g.order || '').toUpperCase(), et = /LIMIT/.test(ord) ? 'limit' : /STOP/.test(ord) ? 'stop' : 'market';
    const en = et === 'market' && px != null ? px : num(g.entry), sl = num(g['stop loss'] != null ? g['stop loss'] : g.sl);
    const tps = (Array.isArray(g.tp) ? g.tp : [g.tp1, g.tp2, g.tp3]).map(x => num(String(x == null ? '' : x).split('|')[0])).filter(x => x != null);
    const score = Math.max(0, Math.min(100, Math.round(num(ctx.score != null ? ctx.score : g.probability) || 0)));
    const patterns = (ctx.patterns || []).filter(p => PATTERNS.includes(p));
    const P = skeleton({ symbol: String(ctx.symbol || '?'), tf, side: side || 1, at: now, origin: num(ctx.origin) != null ? num(ctx.origin) : en, atr: a, score, patterns, fingerprint: ctx.fingerprint, now, source: ctx.source || 'coach',
      thesis: String(g.reason || g.why || '').split(/(?<=\.)\s+/).slice(0, 3).join(' ').slice(0, 280) || 'Model plan.' });
    const bad = [];
    if (!side) bad.push('the model chose NO TRADE');
    if (!(a > 0)) bad.push('ATR is missing'); if (en == null || sl == null) bad.push('the plan has no entry or stop'); if (!tps.length) bad.push('the plan has no target');
    if (bad.length) { P.no_trade_reasons = bad; return P; }
    if (side * (en - sl) <= 0) { P.no_trade_reasons = ['the stop is on the wrong side of the entry']; return P; }
    if (px != null && et === 'limit' && side * (en - px) > 0) bad.push('the limit price is not better than the market');
    if (px != null && et === 'stop' && side * (en - px) < 0) bad.push('the stop-entry price is not beyond the market');
    P.entry_type = et; P.entry_zone = [en, en]; P.invalidation = sl; P.stop_distance = rnd(Math.abs(en - sl), en);
    P.targets = tps.filter(t => side * (t - en) > 0).map(t => ({ price: t, rr: r2(side * (t - en) / P.stop_distance), label: 'Model' })).sort((x, y) => x.rr - y.rr).slice(0, 3);
    if (!P.targets.length) bad.push('no target is on the right side of the entry');
    const vu = num(ctx.validUntil); P.time_stop_ms = now + P.time_stop_bars * TF_MS[tf]; P.expires_at = vu && vu > now ? Math.min(vu, now + 4 * P.time_stop_bars * TF_MS[tf]) : P.time_stop_ms;
    if (P.stop_distance < 0.2 * a || P.stop_distance > 4 * a) bad.push(`stop distance ${fx(P.stop_distance)} is unrealistic against the ATR ${fx(a)}`);
    const G = gate(P, ctx, { conf: score || 50, useScore: ctx.score != null, price: ctx.origin != null ? px : null, why: ctx.why });
    P.decision = bad.length || G.reasons.length ? 'NO TRADE' : 'TRADE'; P.confidence = G.confidence; P.kill_conditions = G.kill; P.no_trade_reasons = bad.concat(G.reasons);
    return P;
  }

  // ---- 3. sizePlan(plan, account, opts): pure risk engine
  // account: { equity, open: [{ symbol, risk_pct }] }  (open = live positions and pending orders that carry risk)
  function sizePlan(plan, account, opts) {
    const O = { ...DEFAULTS, ...(opts || {}), regimeMult: { ...DEFAULTS.regimeMult, ...((opts && opts.regimeMult) || {}) } }, reasons = [];
    const open = (account && Array.isArray(account.open) ? account.open : []).filter(x => x && num(x.risk_pct) > 0);
    const heat = open.reduce((s, x) => s + num(x.risk_pct), 0), grp = plan ? groupsOf(plan.symbol) : [];
    const groupRisk = grp.length ? Math.max(0, ...grp.map(g => open.filter(x => groupsOf(x.symbol).includes(g)).reduce((s, x) => s + num(x.risk_pct), 0))) : 0;
    const res = (ok, risk, units) => ({ ok, risk_pct: ok ? r2(risk) : null, size_units: ok ? units : null, stop_distance: plan ? plan.stop_distance : null, reasons, heat: r2(heat + (ok ? risk : 0)), groupRisk: r2(groupRisk) });
    // 1. a tradeable plan with a real stop
    if (!plan || plan.decision !== 'TRADE') { reasons.push('the plan is not a TRADE'); return res(false); }
    const d = num(plan.stop_distance), a = num(plan.atr), eq = num(account && account.equity);
    if (!(d > 0) || !(a > 0)) { reasons.push('stop distance or ATR is invalid'); return res(false); }
    if (!(eq > 0)) { reasons.push('account equity is unknown'); return res(false); }
    // 2. reward to risk of the first target
    const rr1 = plan.targets && plan.targets[0] ? num(plan.targets[0].rr) : null;
    if (!(rr1 >= O.minRR)) { reasons.push(`first target is ${rr1 == null ? 'missing' : rr1.toFixed(2) + 'R'}, below the minimum ${O.minRR}R`); return res(false); }
    // 3. regime
    let risk = O.baseRiskPct; const trd = plan.fingerprint && plan.fingerprint.trd;
    if (trd && O.regimeMult[trd] != null) risk *= O.regimeMult[trd];
    // 4. late run, measured from the planned entry (or the price now for stop and market entries)
    const mid = (plan.entry_zone[0] + plan.entry_zone[1]) / 2, run = plan.side * (num(O.price) != null && plan.entry_type !== 'limit' ? num(O.price) - plan.origin : mid - plan.origin) / a;
    if (run > O.lateRunATR) { risk *= 0.5; reasons.push(`half size: entry is ${run.toFixed(1)} ATR from the origin`); }
    else if (run > 1.2) { risk *= 0.75; reasons.push(`0.75x size: entry is ${run.toFixed(1)} ATR from the origin`); }
    // 5. track record
    const tg = trackGate(O.trackRecord);
    if (tg.level === 'block') { reasons.push(`weak track record (${tg.txt})`); return res(false); }
    if (tg.level === 'marginal') { risk *= 0.5; reasons.push(`half size: marginal track record (${tg.txt})`); }
    risk = Math.min(risk, O.maxRiskPct);
    // 6. portfolio heat and correlation groups
    if (heat + risk > O.maxHeatPct + 1e-9) { reasons.push(`portfolio heat would be ${(heat + risk).toFixed(2)}%, above ${O.maxHeatPct}%`); return res(false); }
    if (groupRisk + risk > O.maxGroupPct + 1e-9) { const cut = Math.max(0, O.maxGroupPct - groupRisk); reasons.push(`cut to ${cut.toFixed(2)}%: ${grp.join('/')} group already carries ${groupRisk.toFixed(2)}%`); risk = cut; }
    // 7. floor
    if (risk < O.floorRiskPct - 1e-9) { reasons.push(`risk ${risk.toFixed(2)}% is under the ${O.floorRiskPct}% floor`); return res(false); }
    // 8. units: risk money / (stop distance x contract size x quote-to-account rate), rounded down to the lot step
    const cs = num(O.contractSize) || contractSizeOf(plan.symbol), q2a = num(O.quoteToAccount) || 1, step = num(O.lotStep) || 0.01;
    const raw = (eq * risk / 100) / (d * cs * q2a), units = Math.floor(raw / step + 1e-9) * step, u = +units.toFixed(Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)));
    if (!(u >= (num(O.minLot) || step))) { reasons.push(`size ${raw.toFixed(4)} is below the minimum lot ${num(O.minLot) || step}`); return res(false); }
    const actual = u * d * cs * q2a / eq * 100;                                   // risk after rounding down
    if (actual < O.floorRiskPct - 1e-9) { reasons.push(`after rounding to the lot step the risk is ${actual.toFixed(2)}%, under the ${O.floorRiskPct}% floor`); return res(false); }
    return res(true, actual, u);
  }
  // the caller's half of the contract: a failed sizing turns the plan into NO TRADE with the reasons
  function applySize(plan, sz) {
    const P = { ...plan, kill_conditions: [...(plan.kill_conditions || [])], no_trade_reasons: [...(plan.no_trade_reasons || [])] };
    if (sz && sz.ok) { P.risk_pct = sz.risk_pct; P.size_units = sz.size_units; return P; }
    if (P.decision === 'TRADE') { P.decision = 'NO TRADE'; P.no_trade_reasons.push(...((sz && sz.reasons) || ['not sized'])); }
    P.risk_pct = null; P.size_units = null; return P;
  }

  // ---- validatePlan(plan): [] when valid
  function validatePlan(p) {
    const E = [], fin = x => typeof x === 'number' && isFinite(x), err = m => E.push(m);
    if (!p || typeof p !== 'object') return ['plan is not an object'];
    if (p.version !== VERSION) err(`version must be "${VERSION}"`);
    if (typeof p.symbol !== 'string' || !p.symbol) err('symbol is missing');
    if (!TFS.includes(p.tf)) err(`tf must be one of ${TFS.join(', ')}`);
    if (typeof p.id !== 'string' || p.id.indexOf(`${p.symbol}|${p.tf}|`) !== 0) err('id must be symbol|tf|at');
    if (p.side !== 1 && p.side !== -1) err('side must be 1 or -1');
    if (p.decision !== 'TRADE' && p.decision !== 'NO TRADE') err('decision must be TRADE or NO TRADE');
    if (!Array.isArray(p.patterns) || p.patterns.some(x => !PATTERNS.includes(x))) err('patterns must be a subset of ' + PATTERNS.join('|'));
    if (!p.fingerprint || typeof p.fingerprint !== 'object') err('fingerprint is missing');
    else for (const k of Object.keys(FP)) if (p.fingerprint[k] !== null && !FP[k].includes(p.fingerprint[k])) err(`fingerprint.${k} is not allowed`);
    if (!fin(p.score) || p.score < 0 || p.score > 100) err('score must be 0-100');
    if (!fin(p.confidence) || p.confidence < 0 || p.confidence > 100) err('confidence must be 0-100');
    if (!fin(p.max_slippage_r) || p.max_slippage_r < 0) err('max_slippage_r must be a number');
    if (!Array.isArray(p.kill_conditions) || p.kill_conditions.some(x => typeof x !== 'string')) err('kill_conditions must be strings');
    if (!Array.isArray(p.no_trade_reasons) || p.no_trade_reasons.some(x => typeof x !== 'string')) err('no_trade_reasons must be strings');
    if (typeof p.thesis !== 'string' || !p.thesis || p.thesis.length > 400) err('thesis must be 1-3 short sentences');
    if (!fin(p.created_at)) err('created_at is missing');
    if (!SOURCES.includes(p.source)) err('source must be one of ' + SOURCES.join(', '));
    if (p.risk_pct !== null && !(fin(p.risk_pct) && p.risk_pct > 0 && p.risk_pct <= DEFAULTS.maxRiskPct * 2)) err('risk_pct must be null or a positive percentage');
    if (p.size_units !== null && !(fin(p.size_units) && p.size_units > 0)) err('size_units must be null or positive');
    if (p.decision === 'NO TRADE') {
      if (!Array.isArray(p.no_trade_reasons) || !p.no_trade_reasons.length) err('a NO TRADE needs at least one reason');
      if (p.size_units !== null) err('a NO TRADE cannot carry a size');
      return E;
    }
    // TRADE: every core field present and consistent
    if (Array.isArray(p.no_trade_reasons) && p.no_trade_reasons.length) err('a TRADE cannot carry no_trade_reasons');
    if (!fin(p.atr) || p.atr <= 0) err('atr must be positive'); if (!fin(p.origin)) err('origin is missing');
    if (!ENTRY_TYPES.includes(p.entry_type)) err('entry_type must be limit, stop or market');
    const z = p.entry_zone;
    if (!Array.isArray(z) || z.length !== 2 || !fin(z[0]) || !fin(z[1])) { err('entry_zone must be [low, high]'); return E; }
    if (z[0] > z[1]) err('entry_zone must be ordered low, high');
    const mid = (z[0] + z[1]) / 2, tol = Math.max(1e-9, Math.abs(mid) * 1e-7);
    if (!fin(p.invalidation)) err('invalidation is missing');
    else {
      if (p.side * (mid - p.invalidation) <= 0) err('invalidation is on the wrong side of the entry');
      if (p.side * ((p.side > 0 ? z[0] : z[1]) - p.invalidation) <= 0) err('invalidation is inside the entry zone');
      if (!fin(p.stop_distance) || Math.abs(p.stop_distance - Math.abs(mid - p.invalidation)) > Math.max(tol, p.stop_distance * 0.002)) err('stop_distance must equal |entry mid - invalidation|');
    }
    if (!Array.isArray(p.targets) || !p.targets.length || p.targets.length > 3) err('targets must hold 1 to 3 levels');
    else {
      p.targets.forEach((t, i) => {
        if (!t || !fin(t.price) || !fin(t.rr)) { err(`target ${i + 1} needs price and rr`); return; }
        if (p.side * (t.price - mid) <= 0) err(`target ${i + 1} is on the wrong side of the entry`);
        if (fin(p.stop_distance) && p.stop_distance > 0 && Math.abs(p.side * (t.price - mid) / p.stop_distance - t.rr) > 0.02) err(`target ${i + 1} rr does not match its price`);
        if (i && t.rr < p.targets[i - 1].rr) err('targets must be sorted by increasing rr');
      });
      if (!p.targets.some(t => t && t.rr >= DEFAULTS.minTargetRR)) err(`no target reaches ${DEFAULTS.minTargetRR}R`);
    }
    if (p.time_stop_bars !== TIME_STOP_BARS[p.tf]) err(`time_stop_bars must be ${TIME_STOP_BARS[p.tf]} for ${p.tf}`);
    if (!fin(p.time_stop_ms)) err('time_stop_ms is missing'); if (!fin(p.expires_at)) err('expires_at is missing');
    if (!p.kill_conditions || !p.kill_conditions.length) err('a TRADE needs kill conditions');
    return E;
  }

  // ---- renderPlanAlert(plan, opts): plain text. opts.time(ms) formats times (default UTC); opts.verdict adds a track-record line
  function renderPlanAlert(p, opts) {
    opts = opts || {}; if (!p) return '';
    const T = opts.time || (t => new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'), S = p.side > 0 ? 'BUY' : 'SELL', ok = p.decision === 'TRADE';
    const L = [`${ok ? '✅' : '⛔'} ${p.symbol} ${S}: ${p.decision} (${p.tf}${p.score != null ? `, score ${p.score}` : ''}${ok ? `, confidence ${p.confidence}` : ''})`];
    const lv = () => {
      if (!p.entry_zone) return;
      const z = p.entry_zone[0] === p.entry_zone[1] ? fx(p.entry_zone[0]) : `${fx(p.entry_zone[0])}-${fx(p.entry_zone[1])}`;
      L.push(`Entry: ${p.entry_type || ''} ${z}`.replace('  ', ' '));
      if (p.invalidation != null) L.push(`Stop: ${fx(p.invalidation)} (${fr(p.stop_distance, p.invalidation)}${p.atr ? `, ${(p.stop_distance / p.atr).toFixed(2)} ATR` : ''})`);
      if (p.targets && p.targets.length) L.push('Targets: ' + p.targets.map(t => `${fx(t.price)} (${t.label && !/R$/.test(t.label) ? t.label + ', ' : ''}${t.rr.toFixed(1)}R)`).join(', '));
    };
    if (ok) {
      lv();
      L.push(p.risk_pct != null ? `Risk: ${p.risk_pct}% of equity, ${p.size_units} ${opts.unit || 'lots'}` : 'Risk: not sized yet');
      L.push(`Time stop: ${p.time_stop_bars} bars, until ${T(p.expires_at)}`);
      L.push(`Why: ${p.thesis}`);
      if (opts.verdict) L.push(opts.verdict);
      const k = p.kill_conditions || [];
      if (k.length) L.push('Abort if:', ...k.slice(0, opts.maxKill || 6).map(x => '- ' + x));
    } else {
      L.push('Reasons: ' + (p.no_trade_reasons || []).join('; ') + '.');
      if (p.patterns && p.patterns.length) L.push(`Signal: ${p.patterns.join(' + ')}${p.origin != null ? ` from ${fx(p.origin)}` : ''}. ${p.thesis}`);
      if (p.entry_zone) { L.push('Levels it would have used:'); lv(); }
    }
    if (opts.extra) L.push(...[].concat(opts.extra).filter(Boolean));
    return L.join('\n');
  }

  // ---- context helper: everything buildPlanFromDetect wants, computed with the existing toolkit (EVTA)
  // bars: { m15, h1, h4, d1 } closed, oldest first. Returns only the pieces it can compute.
  function planContext(signal, bars, extra) {
    const B = bars || {}, tf = tfNorm(signal && signal.tf), side = signal && (signal.dir || (signal.side === 'BUY' ? 1 : -1)), px = signal && num(signal.price), out = { ...(extra || {}) };
    if (!TA) return out;
    try { out.fingerprint = TA.fingerprint(B.h1, B.h4, px, side); } catch (e) { }
    try { out.session = TA.sessionLevels(B.m15, B.d1, B.h1, num(out.now) || Date.now(), px); } catch (e) { }
    const tb = tf === '15M' ? B.m15 : tf === '4H' ? B.h4 : B.h1;
    try { out.orderBlocks = [...TA.orderBlocks(tb, TA.atr(tb, 14)), ...(B.h4 && tf !== '4H' ? TA.orderBlocks(B.h4, TA.atr(B.h4, 14)) : [])]; } catch (e) { }
    try { out.fib = TA.fibExt(TA.lastLeg(tb, 3)); } catch (e) { }
    try { out.dealing = TA.dealingRange(B.h4, 3, px); } catch (e) { }
    return out;
  }
  // one call for the scanner / robot: build, size, apply, validate
  function planSignal(signal, ctx, account, sizeOpts) {
    const P0 = buildPlanFromDetect(signal, ctx), sz = P0.decision === 'TRADE' && account ? sizePlan(P0, account, { trackRecord: ctx && ctx.trackRecord, price: signal && signal.price, ...(sizeOpts || {}) }) : null;
    const P = sz ? applySize(P0, sz) : P0, errs = validatePlan(P);
    if (errs.length && P.decision === 'TRADE') return { plan: applySize(P, { ok: false, reasons: ['plan failed validation: ' + errs.join('; ')] }), sized: sz, errors: errs };
    return { plan: P, sized: sz, errors: errs };
  }

  // ---- outcome of a plan on later candles of its timeframe (oldest first), for the journal, the scanner and paper goals.
  // Fill at the entry mid (limit: price trades back to it; stop: price trades through it; market: next bar).
  // After the fill the stop is checked before the target inside a candle (cautious). Full exit at TP1, or at the close
  // of the bar where the time stop passes. Returns null while unresolved.
  function planOutcome(p, bars) {
    if (!p || p.decision !== 'TRADE' || !p.entry_zone || !(p.stop_distance > 0)) return null;
    const side = p.side, mid = (p.entry_zone[0] + p.entry_zone[1]) / 2, inv = p.invalidation, d = p.stop_distance, tp = p.targets[0].price, ms = TF_MS[p.tf] || 36e5;
    const B = (bars || []).filter(b => b.t >= p.created_at - ms + 1 && isFinite(b.h) && isFinite(b.l)); let fill = null;
    for (const b of B) {
      if (fill == null) {
        if (b.t >= p.expires_at) return { res: 'unfilled', r: 0, at: b.t };
        if (side * ((side > 0 ? b.l : b.h) - inv) <= 0 && !(p.entry_type === 'market')) return { res: 'cancelled', r: 0, at: b.t };   // through the stop before filling
        const hit = p.entry_type === 'market' || (p.entry_type === 'limit' ? side * ((side > 0 ? b.l : b.h) - mid) <= 0 : side * ((side > 0 ? b.h : b.l) - mid) >= 0);
        if (!hit) continue; fill = b.t;
      }
      if (side * ((side > 0 ? b.l : b.h) - inv) <= 0) return { res: 'loss', r: -1, fillAt: fill, at: b.t };
      if (side * ((side > 0 ? b.h : b.l) - tp) >= 0) return { res: 'win', r: p.targets[0].rr, fillAt: fill, at: b.t };
      if (b.t + ms >= p.expires_at) return { res: 'timeout', r: r2(side * (b.c - mid) / d), fillAt: fill, at: b.t };
    }
    return null;
  }

  const api = { VERSION, TFS, TF_MS, TIME_STOP_BARS, PATTERNS, DEFAULTS, GROUPS, groupsOf, contractSizeOf, trackGate, buildPlanFromDetect, planFromModel, sizePlan, applySize, validatePlan, renderPlanAlert, planContext, planSignal, planOutcome };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.EVPlan = api;
})(typeof window !== 'undefined' ? window : globalThis);
