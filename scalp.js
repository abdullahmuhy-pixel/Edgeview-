/* Edgeview Scalping Mode (v44). A separate system from the directional analysis robot: its own configuration, state,
   paper fills, limits and statistics. Shared by the app (window.EVScalp) and Node tests. PAPER ONLY in this version:
   there is no order-sending code here, and live mode stays locked until the paper record passes the readiness checks
   (and even then this version has no live executor).

   How it works
     step(state, cfg, input)   feed it closed 1-minute candles per pair (oldest first) and the spread per pair. For every new
                               candle, in time order across pairs: manage open trades (stop before target inside a candle,
                               break-even and trailing from the next candle, time exit), apply the daily loss circuit breaker
                               and the daily profit lock, then look for new entries with the enabled strategies.
     Strategies (modular)      meanrev: a stretched move away from EMA20 (z-score <= -2 / >= 2) in a choppy market
                               (efficiency ratio < 0.35), on the same side of the session VWAP, turning back on a closed candle.
                               breakout: a full-bodied candle closing beyond the 30-candle range in a directional market
                               (efficiency ratio > 0.4), with the EMA50.
     Filters                   allowed sessions (London 08:00-17:00 London time, New York 08:00-17:00 New York time),
                               maximum spread per pair, target at least 3x the spread, volatility inside the 15th-95th
                               percentile of the last 240 one-minute ATRs (measured just before the signal), cooldown after a loss on that pair.
     Risk                      risk per trade 0.01-0.3% (or a fixed lot that must stay under the same cap), total open risk,
                               max open trades (total and per pair), max trades per day and per hour, simulated slippage
                               with a maximum tolerance, daily loss limit (hard: closes everything and locks the day),
                               daily profit target (stops new entries, open trades are still managed to their exits).
     Statistics                stats(state, from, to): win rate, average win and loss, profit factor, drawdown, duration,
                               trades per day, spread and slippage cost, by pair, session, strategy and exit, daily and weekly
                               reports, how often the daily target was reached; liveReadiness(stats) for the locked live switch.
   Prices: candles are mid prices. Longs fill on the ask (mid + spread/2) and exit on the bid; shorts the other way.
   Money is in the account currency (USD): exact for USD-quoted pairs and gold, converted with the price for USD/JPY,
   USD/CHF and USD/CAD. */
(function (root) {
  'use strict';
  const VERSION = '1.0';
  const MAJORS = ['EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CHF', 'AUD/USD', 'NZD/USD', 'USD/CAD', 'XAU/USD'];
  const DEFAULTS = {
    on: false, paused: false, mode: 'paper',
    pairs: ['EUR/USD', 'GBP/USD', 'USD/JPY', 'XAU/USD'],
    strategies: ['meanrev'],                       // 'meanrev', 'breakout'
    balance: 10000, currency: '$',
    sizing: 'risk', riskPct: 0.1, fixedLot: 0.01,
    maxOpen: 20, maxPerPair: 4, maxOpenRiskPct: 2.0,
    dailyLossPct: 1.0, dailyTarget: null,          // money; null = no target
    maxTradesDay: 120, maxTradesHour: 20,
    tpStyle: 'pips', tpPips: 6, tpMoney: 1.5,
    slStyle: 'pips', slPips: 8, slAtr: 1.5,
    beAfterPips: 4, beLockPips: 0.5, trailPips: 0, maxHoldMin: 45,
    sessions: ['london', 'newyork'],
    maxSpreadPips: { default: 1.2, 'GBP/USD': 1.6, 'XAU/USD': 3.5 },
    spreadPips: { default: 0.8, 'GBP/USD': 1.1, 'USD/JPY': 0.9, 'XAU/USD': 2.5 },   // assumed when the app has no broker spread
    slipPips: 0.2, maxSlipPips: 1.0, minTpSpreadX: 3, volMin: 0.15, volMax: 0.95, cooldownMin: 5,
  };
  const CAPS = { riskPct: [0.01, 0.3], maxOpen: [1, 25], maxPerPair: [1, 10], maxOpenRiskPct: [0.1, 3], dailyLossPct: [0.1, 3], maxTradesDay: [1, 300], maxTradesHour: [1, 60], tpPips: [1, 50], tpMoney: [0.1, 1000], slPips: [2, 100], slAtr: [0.5, 5], fixedLot: [0.01, 100], maxHoldMin: [2, 480], slipPips: [0, 5], maxSlipPips: [0, 10] };
  const num = x => { const v = typeof x === 'number' ? x : parseFloat(x); return isFinite(v) ? v : null; };
  const r2 = x => Math.round(x * 100) / 100;
  const clamp = (v, [a, b]) => Math.min(b, Math.max(a, v));

  // ---- instruments
  const key = s => String(s || '').toUpperCase().replace(/[^A-Z]/g, '');
  const pipOf = s => { const k = key(s); return /JPY$/.test(k) ? 0.01 : /^XAU/.test(k) ? 0.1 : /^XAG/.test(k) ? 0.01 : 0.0001; };
  const csOf = s => /^XAU/.test(key(s)) ? 100 : /^XAG/.test(key(s)) ? 5000 : 100000;
  const q2a = (s, px) => { const k = key(s); return /USD$/.test(k) ? 1 : /^USD/.test(k) && px > 0 ? 1 / px : null; };
  const perPip = (s, lots, px) => { const q = q2a(s, px); return q == null ? null : pipOf(s) * csOf(s) * lots * q; };   // money per pip for `lots`
  const pairCfg = (m, s) => m && m[s] != null ? m[s] : m ? m.default : null;

  // ---- configuration: clamp everything to the hard caps and force paper
  function normConfig(c) {
    const o = { ...DEFAULTS, ...(c || {}) }, notes = [];
    o.maxSpreadPips = { ...DEFAULTS.maxSpreadPips, ...((c && c.maxSpreadPips) || {}) }; o.spreadPips = { ...DEFAULTS.spreadPips, ...((c && c.spreadPips) || {}) };
    for (const [k, cap] of Object.entries(CAPS)) { const v = num(o[k]); const w = v == null ? DEFAULTS[k] : clamp(v, cap); if (v != null && w !== v) notes.push(`${k} ${v} is outside ${cap[0]}-${cap[1]}; using ${w}`); o[k] = w; }
    o.pairs = (Array.isArray(o.pairs) ? o.pairs : []).map(s => String(s).toUpperCase()).filter(s => MAJORS.includes(s));
    o.strategies = (Array.isArray(o.strategies) ? o.strategies : []).filter(s => STRATS[s]); if (!o.strategies.length) o.strategies = ['meanrev'];
    o.sessions = (Array.isArray(o.sessions) ? o.sessions : []).filter(s => SESS[s]);
    o.dailyTarget = num(o.dailyTarget) > 0 ? num(o.dailyTarget) : null; o.balance = num(o.balance) > 0 ? num(o.balance) : DEFAULTS.balance;
    o.sizing = o.sizing === 'fixed' ? 'fixed' : 'risk'; o.tpStyle = o.tpStyle === 'money' ? 'money' : 'pips'; o.slStyle = o.slStyle === 'atr' ? 'atr' : 'pips';
    if (o.mode !== 'paper') { notes.push('Live mode is locked in this version; running on paper.'); o.mode = 'paper'; }
    o.on = !!o.on; o.paused = !!o.paused;
    return { cfg: o, notes };
  }

  // ---- sessions (Intl handles daylight saving)
  const SESS = { asia: ['Asia/Tokyo', 9, 17], london: ['Europe/London', 8, 17], newyork: ['America/New_York', 8, 17] };
  function localHour(t, tz) { try { const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(new Date(t)); return { h: +p.find(x => x.type === 'hour').value, wd: p.find(x => x.type === 'weekday').value }; } catch (e) { const d = new Date(t); return { h: d.getUTCHours(), wd: 'Mon' }; } }
  function sessionsAt(t) { const out = []; for (const [k, [tz, a, b]] of Object.entries(SESS)) { const L = localHour(t, tz); if (L.wd !== 'Sat' && L.wd !== 'Sun' && L.h >= a && L.h < b) out.push(k); } return out; }
  const sessionLabel = t => { const s = sessionsAt(t); return s.includes('london') && s.includes('newyork') ? 'london+newyork' : s[0] || 'off-hours'; };
  function dayKey(t, tz) { try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t)); } catch (e) { return new Date(t).toISOString().slice(0, 10); } }
  const weekKey = (t, tz) => { const d = new Date(dayKey(t, tz) + 'T00:00:00Z'), w = (d.getUTCDay() + 6) % 7; return new Date(d.getTime() - w * 864e5).toISOString().slice(0, 10); };

  // ---- indicators on closes (oldest first), evaluated at index i
  function ema(b, i, n) { const k = 2 / (n + 1), s = Math.max(0, i - n * 4); let e = b[s].c; for (let j = s + 1; j <= i; j++) e = b[j].c * k + e * (1 - k); return e; }
  function sd(b, i, n) { if (i + 1 < n) return null; let m = 0; for (let j = i - n + 1; j <= i; j++) m += b[j].c; m /= n; let v = 0; for (let j = i - n + 1; j <= i; j++) v += (b[j].c - m) ** 2; return Math.sqrt(v / n); }
  function atrAt(b, i, n) { n = n || 14; if (i < n) return null; let s = 0; for (let j = i - n + 1; j <= i; j++) s += Math.max(b[j].h - b[j].l, Math.abs(b[j].h - b[j - 1].c), Math.abs(b[j].l - b[j - 1].c)); return s / n; }
  function er(b, i, n) { n = n || 20; if (i < n) return null; let p = 0; for (let j = i - n + 1; j <= i; j++) p += Math.abs(b[j].c - b[j - 1].c); return p > 0 ? Math.abs(b[i].c - b[i - n].c) / p : 0; }
  // session VWAP from 00:00 UTC, time-weighted (forex candles have no real volume)
  function twap(b, i) { const d0 = Math.floor(b[i].t / 864e5) * 864e5; let s = 0, n = 0; for (let j = i; j >= 0 && b[j].t >= d0; j--) { s += (b[j].h + b[j].l + b[j].c) / 3; n++; } return n ? s / n : null; }
  // where the current 1-minute ATR sits among the last 240 (0-1)
  // measured 3 candles before the trigger (the regime, not the trigger candle itself); ties count half (mid-rank)
  function atrPct(b, i) { const k = i - 3, a = k >= 15 ? atrAt(b, k) : null; if (a == null || i < 60) return null; const H = []; for (let j = Math.max(15, k - 240); j < k; j += 4) { const x = atrAt(b, j); if (x != null) H.push(x); }
    return H.length ? (H.filter(x => x < a - 1e-12).length + 0.5 * H.filter(x => Math.abs(x - a) <= 1e-12).length) / H.length : null; }

  // ---- strategies: (bars, i) -> { side, why, strength } | null. Bars are closed 1-minute candles.
  const STRATS = {
    meanrev(b, i) {
      if (i < 60) return null; const n = 20, e = ema(b, i, n), e1 = ema(b, i - 1, n), s = sd(b, i, n), s1 = sd(b, i - 1, n), x = b[i], E = er(b, i, 20), v = twap(b, i);
      if (!(s > 0) || !(s1 > 0) || E == null || E >= 0.35) return null;
      const z = (x.c - e) / s, z1 = (b[i - 1].c - e1) / s1;
      if (z1 <= -2 && z > z1 && x.c > x.o && x.c > b[i - 1].c && (v == null || x.c < v)) return { side: 1, why: `stretched ${z1.toFixed(1)} SD below EMA20 in a choppy market, closed back up, below the session VWAP`, strength: Math.min(1, -z1 / 3) };
      if (z1 >= 2 && z < z1 && x.c < x.o && x.c < b[i - 1].c && (v == null || x.c > v)) return { side: -1, why: `stretched ${z1.toFixed(1)} SD above EMA20 in a choppy market, closed back down, above the session VWAP`, strength: Math.min(1, z1 / 3) };
      return null;
    },
    breakout(b, i) {
      if (i < 60) return null; const x = b[i], a = atrAt(b, i), E = er(b, i, 20), e50 = ema(b, i, 50), w = b.slice(i - 30, i), hi = Math.max(...w.map(y => y.h)), lo = Math.min(...w.map(y => y.l)), rng = x.h - x.l;
      if (!(a > 0) || E == null || E <= 0.4 || rng < 1.2 * a || Math.abs(x.c - x.o) < 0.6 * rng) return null;
      if (x.c > hi + 0.1 * a && x.c > e50) return { side: 1, why: `closed ${((x.c - hi) / a).toFixed(1)} ATR above the 30-minute high in a directional market, above EMA50`, strength: Math.min(1, E) };
      if (x.c < lo - 0.1 * a && x.c < e50) return { side: -1, why: `closed ${((lo - x.c) / a).toFixed(1)} ATR below the 30-minute low in a directional market, below EMA50`, strength: Math.min(1, E) };
      return null;
    },
  };

  // ---- state
  function newState(now) { return { v: 1, open: [], closed: [], last: {}, lock: null, days: {}, events: [], seed: 12345, created: now || 0 }; }
  const rand = st => { st.seed = (st.seed * 16807) % 2147483647; return st.seed / 2147483647; };
  const evt = (st, t, msg) => { st.events.unshift({ t, msg }); if (st.events.length > 300) st.events.length = 300; };
  const dayRec = (st, d) => st.days[d] || (st.days[d] = { target: null, lock: null, n: 0, net: 0, peak: 0, dd: 0 });
  const balanceOf = (st, cfg) => r2(cfg.balance + st.closed.reduce((a, t) => a + t.pnl, 0));
  // money value of an open trade at a mid price
  function floatPnl(t, mid) { const q = q2a(t.sym, mid) || 1, exit = mid - t.side * t.spread / 2; return t.side * (exit - t.entry) * t.lots * csOf(t.sym) * q; }

  // close one trade at an exit price (on the exit side of the spread)
  function closeTrade(st, t, exitPx, at, reason, cfg, tz) {
    const q = q2a(t.sym, exitPx) || 1, units = t.lots * csOf(t.sym), pnl = r2(t.side * (exitPx - t.entry) * units * q);
    const out = { ...t, exitT: at, exit: exitPx, pnl, pips: r2(t.side * (exitPx - t.entry) / pipOf(t.sym)), reason, durMin: Math.max(1, Math.round((at - t.openT) / 60000)),
      spreadCost: r2(t.spread * units * q), slipCost: r2((t.slipIn + (reason === 'sl' || reason === 'breaker' ? t.slip : 0)) * units * q) };
    st.open = st.open.filter(x => x.id !== t.id); st.closed.push(out); if (st.closed.length > 6000) st.closed.splice(0, st.closed.length - 6000);
    const D = dayRec(st, dayKey(at, tz)); D.n++; D.net = r2(D.net + pnl); D.peak = Math.max(D.peak, D.net); D.dd = r2(Math.max(D.dd, D.peak - D.net));
    evt(st, at, `${t.sym} ${t.side > 0 ? 'BUY' : 'SELL'} closed (${reason}) ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`);
    return out;
  }
  // manage one open trade on one candle (mid prices). Stop before target inside a candle; BE / trail take effect from the next candle.
  function manage(st, t, b, cfg, tz) {
    if (b.t < t.openT) return null;                        // the candle that opens at the fill time is the first one managed
    const s = t.spread, side = t.side, P = pipOf(t.sym), lo = b.l - (side > 0 ? s / 2 : -s / 2), hi = b.h - (side > 0 ? s / 2 : -s / 2), op = b.o - (side > 0 ? s / 2 : -s / 2);   // exit-side prices
    const worst = side > 0 ? lo : hi, best = side > 0 ? hi : lo;
    if (side * (worst - t.sl) <= 0) { const gap = side * (op - t.sl) < 0, px = (gap ? op : t.sl) - side * t.slip; return closeTrade(st, t, px, b.t + 60000, t.be ? (t.trail ? 'trail' : 'be') : 'sl', cfg, tz); }
    if (side * (best - t.tp) >= 0) return closeTrade(st, t, t.tp, b.t + 60000, 'tp', cfg, tz);
    const c = b.c - (side > 0 ? s / 2 : -s / 2);
    if (b.t + 60000 - t.openT >= cfg.maxHoldMin * 60000) return closeTrade(st, t, c, b.t + 60000, 'time', cfg, tz);
    // after the candle: break-even and trailing for the next candle
    const fav = side * (best - t.entry);
    if (cfg.beAfterPips > 0 && !t.be && fav >= cfg.beAfterPips * P) { t.sl = t.entry + side * cfg.beLockPips * P; t.be = true; }
    if (cfg.trailPips > 0 && t.be) { const tr = best - side * cfg.trailPips * P; if (side * (tr - t.sl) > 0) { t.sl = tr; t.trail = true; } }
    t.mfe = Math.max(t.mfe || 0, r2(fav / P)); t.mae = Math.max(t.mae || 0, r2(-side * (worst - t.entry) / P));
    return null;
  }

  // why a new entry is not allowed now (null = allowed). openRiskPct is the current total.
  function entryBlock(st, cfg, sym, t, tz) {
    if (!cfg.on) return 'Scalping Mode is off';
    if (cfg.paused) return 'paused: no new entries';
    if (st.lock && st.lock.day === dayKey(t, tz)) return st.lock.reason;
    if (cfg.mode !== 'paper') return 'live is locked';
    if (!cfg.pairs.includes(sym)) return `${sym} is not enabled`;
    const ss = sessionsAt(t); if (!ss.some(x => cfg.sessions.includes(x))) return 'outside the allowed sessions';
    if (st.open.length >= cfg.maxOpen) return `max ${cfg.maxOpen} open trades`;
    if (st.open.filter(x => x.sym === sym).length >= cfg.maxPerPair) return `max ${cfg.maxPerPair} open trades on ${sym}`;
    if ((dayRec(st, dayKey(t, tz)).opened || 0) >= cfg.maxTradesDay) return `max ${cfg.maxTradesDay} trades today`;
    // closed trades are stored in exit order, so walking back stops at the first one that left before the window
    let hr = st.open.filter(x => t - x.openT < 36e5).length, cool = false;
    for (let j = st.closed.length - 1; j >= 0; j--) { const x = st.closed[j]; if (t - x.exitT >= 36e5) break; if (t - x.openT < 36e5) hr++; if (x.sym === sym && x.pnl < 0 && t - x.exitT < cfg.cooldownMin * 60000) cool = true; }
    if (hr >= cfg.maxTradesHour) return `max ${cfg.maxTradesHour} trades in the last hour`;
    if (cool) return `cooldown after a loss on ${sym}`;
    return null;
  }

  // try to open a trade on candle i of sym
  function tryEntry(st, cfg, sym, b, i, spread, tz, skip) {
    const x = b[i], t = x.t + 60000, blk = entryBlock(st, cfg, sym, t, tz); if (blk) return null;
    if (st.open.some(o => o.sym === sym && o.openT === t)) return null;
    let sig = null, strat = null; for (const k of cfg.strategies) { const s = STRATS[k](b, i); if (s && (!sig || s.strength > sig.strength)) { sig = s; strat = k; } }
    if (!sig) return null;
    const P = pipOf(sym), sprPips = spread / P, maxSp = pairCfg(cfg.maxSpreadPips, sym);
    const no = why => { skip[why] = (skip[why] || 0) + 1; const D = dayRec(st, dayKey(t, tz)); D.skips = D.skips || {}; D.skips[why] = (D.skips[why] || 0) + 1; return null; };
    if (sprPips > maxSp + 1e-9) return no(`spread ${sprPips.toFixed(1)} pips above the ${maxSp} limit`);
    const vp = atrPct(b, i); if (vp == null || vp < cfg.volMin || vp > cfg.volMax) return no(vp != null && vp > cfg.volMax ? 'volatility too high' : 'volatility too low');
    const a = atrAt(b, i), slDist = cfg.slStyle === 'atr' ? cfg.slAtr * a : cfg.slPips * P; if (!(slDist > 0)) return null;
    const slip = Math.min(cfg.slipPips * 2 * rand(st), 99) * P; if (slip > cfg.maxSlipPips * P + 1e-12) return no('slippage above tolerance');
    const entry = x.c + sig.side * (spread / 2 + slip), q = q2a(sym, x.c); if (q == null) return no('no USD conversion');
    const bal = balanceOf(st, cfg), money1 = csOf(sym) * q;            // money per 1 price unit per lot
    let lots = cfg.sizing === 'fixed' ? cfg.fixedLot : Math.floor((bal * cfg.riskPct / 100) / (slDist * money1) / 0.01 + 1e-9) * 0.01; lots = +lots.toFixed(2);
    if (!(lots >= 0.01)) return no('risk per trade too small for 0.01 lots');
    const riskAmt = r2(lots * slDist * money1), riskPct = riskAmt / bal * 100;
    if (riskPct > CAPS.riskPct[1] + 1e-9) return no(`a ${lots} lot trade risks ${riskPct.toFixed(2)}%, above the ${CAPS.riskPct[1]}% cap`);
    const openRisk = st.open.reduce((s2, o) => s2 + o.riskPct, 0);
    if (openRisk + riskPct > cfg.maxOpenRiskPct + 1e-9) return no('total open risk limit');
    const tpDist = cfg.tpStyle === 'money' ? cfg.tpMoney / (lots * money1) : cfg.tpPips * P;
    if (tpDist < cfg.minTpSpreadX * spread - 1e-12) return no(`target under ${cfg.minTpSpreadX}x the spread`);
    const tr = { id: `${sym}|${t}|${sig.side}`, sym, side: sig.side, strat, why: sig.why, session: sessionLabel(t), openT: t, mid: x.c, entry, spread, slipIn: slip, slip: cfg.slipPips * P,
      sl: entry - sig.side * slDist, tp: entry + sig.side * tpDist, lots, riskAmt, riskPct: r2(riskPct), be: false, mfe: 0, mae: 0 };
    st.open.push(tr); const DD = dayRec(st, dayKey(t, tz)); DD.opened = (DD.opened || 0) + 1; evt(st, t, `${sym} ${sig.side > 0 ? 'BUY' : 'SELL'} ${lots} (${strat}): ${sig.why}`);
    return tr;
  }

  // ---- the engine step. input: { now, bars: {sym: [closed 1M candles]}, spreads: {sym: price units}, tz }
  function step(state, cfgIn, input) {
    const { cfg } = normConfig(cfgIn), st = JSON.parse(JSON.stringify(state || newState(input && input.now))), tz = (input && input.tz) || 'UTC', now = (input && input.now) || Date.now();
    const B = (input && input.bars) || {}, out = { opened: [], closed: [], skipped: {} };
    // the day lock ends with the day (or with a manual reset)
    if (st.lock && st.lock.day !== dayKey(now, tz)) { evt(st, now, 'New day: the scalping lock is cleared'); st.lock = null; }
    const queue = [];
    for (const [sym, bars] of Object.entries(B)) {
      if (!Array.isArray(bars) || !bars.length) continue;
      const last = st.last[sym]; if (last == null) { st.last[sym] = bars[bars.length - 1].t; continue; }   // first sight of a pair: start from the next candle
      bars.forEach((b, i) => { if (b.t > last && b.t + 60000 <= now) queue.push({ sym, b, i, bars }); });
    }
    queue.sort((p, q) => p.b.t - q.b.t || (p.sym < q.sym ? -1 : 1));
    const lastMid = {};
    for (const { sym, b, i, bars } of queue) {
      st.last[sym] = Math.max(st.last[sym] || 0, b.t); lastMid[sym] = b.c;
      const spread = num(input.spreads && input.spreads[sym]) > 0 ? num(input.spreads[sym]) : pairCfg(cfg.spreadPips, sym) * pipOf(sym), at = b.t + 60000, d = dayKey(at, tz), D = dayRec(st, d);
      if (cfg.dailyTarget && D.target == null) D.target = cfg.dailyTarget;
      for (const t of st.open.filter(x => x.sym === sym)) { const c = manage(st, t, b, cfg, tz); if (c) out.closed.push(c); }
      // daily loss circuit breaker: realized today + open trades at the latest prices
      const lossLim = cfg.balance * cfg.dailyLossPct / 100, floating = st.open.reduce((a, t) => a + floatPnl(t, lastMid[t.sym] != null ? lastMid[t.sym] : t.mid), 0);
      if (D.net + floating <= -lossLim + 1e-9 && st.open.length) {
        for (const t of [...st.open]) { const m = lastMid[t.sym] != null ? lastMid[t.sym] : t.mid; out.closed.push(closeTrade(st, t, m - t.side * (t.spread / 2 + t.slip), at, 'breaker', cfg, tz)); }
      }
      if (D.net <= -lossLim + 1e-9 && !(st.lock && st.lock.day === d)) { st.lock = { day: d, reason: `daily loss limit ${cfg.dailyLossPct}% hit (${D.net.toFixed(2)})`, at, kind: 'loss' }; D.lock = st.lock; evt(st, at, 'Circuit breaker: ' + st.lock.reason + '. No new trades today.'); }
      if (cfg.dailyTarget && D.net >= cfg.dailyTarget - 1e-9 && !(st.lock && st.lock.day === d)) { st.lock = { day: d, reason: `daily profit target ${cfg.dailyTarget} reached (${D.net.toFixed(2)})`, at, kind: 'target' }; D.lock = st.lock; evt(st, at, 'Target reached: ' + st.lock.reason + '. Open trades are managed to their exits.'); }
      const o = tryEntry(st, cfg, sym, bars, i, spread, tz, out.skipped); if (o) out.opened.push(o);
    }
    return { state: st, ...out };
  }

  function resetLock(state, now) { const st = JSON.parse(JSON.stringify(state)); if (st.lock) evt(st, now || Date.now(), 'Lock reset by you'); st.lock = null; return st; }
  function resetStats(state, now) { const st = JSON.parse(JSON.stringify(state)); st.closed = []; st.days = {}; evt(st, now || Date.now(), 'Paper statistics reset (open trades kept)'); return st; }
  // money view of the live state: today's realized, floating, progress to target
  function today(state, cfg0, mids, now, tz) {
    const { cfg } = normConfig(cfg0), d = dayKey(now, tz), D = state.days[d] || { net: 0, n: 0, dd: 0 }, fl = state.open.reduce((a, t) => a + floatPnl(t, mids && mids[t.sym] != null ? mids[t.sym] : t.mid), 0);
    const lossLim = cfg.balance * cfg.dailyLossPct / 100;
    return { day: d, realized: r2(D.net), floating: r2(fl), closedN: D.n, open: state.open.length, target: cfg.dailyTarget, remaining: cfg.dailyTarget ? r2(Math.max(0, cfg.dailyTarget - D.net)) : null, progressPct: cfg.dailyTarget ? Math.max(0, Math.min(100, r2(D.net / cfg.dailyTarget * 100))) : null,
      skips: D.skips || {}, lossLimit: r2(lossLim), lossUsedPct: D.net < 0 ? r2(-D.net / lossLim * 100) : 0, lock: state.lock && state.lock.day === d ? state.lock : null, openRiskPct: r2(state.open.reduce((a, t) => a + t.riskPct, 0)) };
  }

  // ---- statistics over closed trades (optionally from..to, ms)
  function stats(state, from, to, tz) {
    const T = (state.closed || []).filter(t => (from == null || t.exitT >= from) && (to == null || t.exitT < to));
    const sum = a => a.reduce((s, x) => s + x, 0), W = T.filter(t => t.pnl > 0), L = T.filter(t => t.pnl <= 0);
    const grp = f => { const g = {}; for (const t of T) { const k = f(t); const o = g[k] || (g[k] = { n: 0, w: 0, net: 0 }); o.n++; if (t.pnl > 0) o.w++; o.net = r2(o.net + t.pnl); } return g; };
    let cum = 0, peak = 0, dd = 0; for (const t of [...T].sort((a, b) => a.exitT - b.exitT)) { cum += t.pnl; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
    const days = {}; for (const t of T) { const d = dayKey(t.exitT, tz); (days[d] = days[d] || []).push(t); }
    const dayRows = Object.keys(days).sort().map(d => { const a = days[d], rec = (state.days || {})[d] || {}; return { day: d, n: a.length, wins: a.filter(t => t.pnl > 0).length, net: r2(sum(a.map(t => t.pnl))), dd: rec.dd != null ? rec.dd : null, target: rec.target, hitTarget: !!(rec.lock && rec.lock.kind === 'target'), hitLoss: !!(rec.lock && rec.lock.kind === 'loss') }; });
    const wk = {}; for (const r of dayRows) { const k = weekKey(Date.parse(r.day + 'T12:00:00Z'), 'UTC'); const o = wk[k] || (wk[k] = { week: k, days: 0, n: 0, wins: 0, net: 0, targetDays: 0, lossDays: 0 }); o.days++; o.n += r.n; o.wins += r.wins; o.net = r2(o.net + r.net); if (r.hitTarget) o.targetDays++; if (r.hitLoss) o.lossDays++; }
    const tDays = dayRows.filter(r => r.target);
    return {
      n: T.length, wins: W.length, losses: L.length, winRate: T.length ? W.length / T.length : null,
      avgWin: W.length ? r2(sum(W.map(t => t.pnl)) / W.length) : null, avgLoss: L.length ? r2(sum(L.map(t => t.pnl)) / L.length) : null,
      net: r2(sum(T.map(t => t.pnl))), pf: L.length && sum(L.map(t => t.pnl)) < 0 ? r2(sum(W.map(t => t.pnl)) / -sum(L.map(t => t.pnl))) : null,
      avgPerTrade: T.length ? r2(sum(T.map(t => t.pnl)) / T.length) : null, maxDD: r2(dd), avgDurMin: T.length ? r2(sum(T.map(t => t.durMin)) / T.length) : null,
      tradesPerDay: dayRows.length ? r2(T.length / dayRows.length) : null, spreadCost: r2(sum(T.map(t => t.spreadCost))), slipCost: r2(sum(T.map(t => t.slipCost))),
      netBeforeCosts: r2(sum(T.map(t => t.pnl + t.spreadCost + t.slipCost))),
      byPair: grp(t => t.sym), bySession: grp(t => t.session), byStrategy: grp(t => t.strat), byExit: grp(t => t.reason),
      days: dayRows, weeks: Object.values(wk).sort((a, b) => a.week < b.week ? -1 : 1), tradingDays: dayRows.length,
      targetDays: tDays.length, targetHit: tDays.filter(r => r.hitTarget).length, lossDays: dayRows.filter(r => r.hitLoss).length,
    };
  }
  // the live switch stays locked; these are the bars a paper record must clear before live could even be discussed
  function liveReadiness(S) {
    const c = [
      { name: 'Paper trading days', have: S.tradingDays, need: 20, ok: S.tradingDays >= 20 },
      { name: 'Closed paper trades', have: S.n, need: 500, ok: S.n >= 500 },
      { name: 'Profit factor after spread and slippage', have: S.pf, need: 1.2, ok: S.pf != null && S.pf >= 1.2 },
      { name: 'Net profit after costs', have: S.net, need: '> 0', ok: S.net > 0 },
      { name: 'Days that hit the loss limit', have: S.lossDays, need: 'at most 10% of days', ok: S.tradingDays > 0 && S.lossDays <= 0.1 * S.tradingDays },
    ];
    return { ok: false, checks: c, passed: c.filter(x => x.ok).length, note: 'Live execution is not built into this version of Scalping Mode. Passing every check only means the paper record is worth reviewing.' };
  }

  const api = { VERSION, MAJORS, DEFAULTS, CAPS, STRATS, SESS, pipOf, csOf, q2a, perPip, normConfig, sessionsAt, sessionLabel, dayKey, weekKey, ema, sd, atrAt, er, twap, atrPct, newState, step, resetLock, resetStats, today, stats, liveReadiness, entryBlock, floatPnl };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.EVScalp = api;
})(typeof window !== 'undefined' ? window : globalThis);
