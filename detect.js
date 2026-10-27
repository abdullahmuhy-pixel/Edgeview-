/* Edgeview early-move detection (v33). Shared by the app (window.EVDetect) and the background scanner (Node).
   Works on closed candles: arrays of {t (ms, bar open time UTC), o, h, l, c}, oldest first.
   It looks for the first signs that a move is starting, so an entry can be planned near the origin
   instead of after the move has run:
     sweep    - price runs the stops beyond a recent swing high or low, then closes back inside (a trap / reversal start)
     choch    - after a run of lower highs (or higher lows), a close through the last swing: the trend changes character
     squeeze  - volatility compressed to the bottom of its range, then a close outside the bands with a wide candle
     ignition - one wide, full-bodied candle closing beyond the recent range (momentum arriving)
   Each signal is scored 0-100 with context: the higher-timeframe trend, a nearby key level, agreement between
   signals, and how far price has already travelled from the origin (late signals lose points).
   This is a screen, not a trade: a high score means "look at this now", and the full analysis decides. */
(function (root) {
  'use strict';

  function ema(vals, n) {
    const out = new Array(vals.length).fill(null); if (vals.length < n) return out;
    const k = 2 / (n + 1); let e = 0; for (let i = 0; i < n; i++) e += vals[i]; e /= n; out[n - 1] = e;
    for (let i = n; i < vals.length; i++) { e = vals[i] * k + e * (1 - k); out[i] = e; }
    return out;
  }
  function atr(b, n) {
    n = n || 14; if (b.length < n + 1) return null;
    const tr = []; for (let i = 1; i < b.length; i++) tr.push(Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c)));
    let a = 0; for (let i = 0; i < n; i++) a += tr[i]; a /= n;
    for (let i = n; i < tr.length; i++) a = (a * (n - 1) + tr[i]) / n;
    return a;
  }
  // Bollinger bandwidth (upper-lower)/mid for each bar with a full window
  function bandwidths(b, n) {
    n = n || 20; const out = new Array(b.length).fill(null);
    for (let i = n - 1; i < b.length; i++) {
      let s = 0; for (let j = i - n + 1; j <= i; j++) s += b[j].c; const m = s / n;
      let v = 0; for (let j = i - n + 1; j <= i; j++) v += (b[j].c - m) ** 2; const sd = Math.sqrt(v / n);
      out[i] = { mid: m, up: m + 2 * sd, lo: m - 2 * sd, bw: m ? (4 * sd) / m : 0 };
    }
    return out;
  }
  // swing points: a high (low) higher (lower) than k bars on each side
  function pivots(b, k, from) {
    const P = []; for (let i = Math.max(k, from || 0); i < b.length - k; i++) {
      let hi = true, lo = true;
      for (let j = i - k; j <= i + k; j++) { if (j === i) continue; if (b[j].h >= b[i].h) hi = false; if (b[j].l <= b[i].l) lo = false; }
      if (hi) P.push({ i, t: b[i].t, p: b[i].h, k: 'H' }); if (lo) P.push({ i, t: b[i].t, p: b[i].l, k: 'L' });
    }
    return P;
  }
  // trend of a series of bars from EMA 50 and its slope, plus where price sits: +1 up, -1 down, 0 mixed
  function trendOf(b) {
    if (!b || b.length < 60) return 0;
    const c = b.map(x => x.c), e50 = ema(c, 50), e20 = ema(c, 20), n = b.length - 1;
    const slope = e50[n] - e50[n - 10], px = c[n];
    if (px > e50[n] && e20[n] > e50[n] && slope > 0) return 1;
    if (px < e50[n] && e20[n] < e50[n] && slope < 0) return -1;
    return 0;
  }
  // 4H bars from 1H bars, aligned to 00/04/08/12/16/20 UTC
  function to4h(h1) {
    const out = []; let cur = null;
    for (const x of h1) {
      const k = Math.floor(x.t / 144e5) * 144e5;
      if (!cur || cur.t !== k) { if (cur) out.push(cur); cur = { t: k, o: x.o, h: x.h, l: x.l, c: x.c }; }
      else { cur.h = Math.max(cur.h, x.h); cur.l = Math.min(cur.l, x.l); cur.c = x.c; }
    }
    if (cur) out.push(cur); return out;
  }

  function sweep(b, a) {
    const n = b.length - 1, x = b[n], rng = x.h - x.l; if (rng <= 0) return null;
    const win = b.slice(Math.max(0, n - 24), n - 1);
    if (win.length < 10) return null;
    const hi = Math.max(...win.map(y => y.h)), lo = Math.min(...win.map(y => y.l));
    const upW = x.h - Math.max(x.o, x.c), dnW = Math.min(x.o, x.c) - x.l;
    if (x.h > hi && x.c < hi && upW >= 0.45 * rng && x.c < x.l + 0.5 * rng && rng >= 0.8 * a)
      return { k: 'sweep', dir: -1, origin: x.h, level: hi, why: `swept the ${win.length}-bar high ${hi} and closed back below it with a long upper wick` };
    if (x.l < lo && x.c > lo && dnW >= 0.45 * rng && x.c > x.h - 0.5 * rng && rng >= 0.8 * a)
      return { k: 'sweep', dir: 1, origin: x.l, level: lo, why: `swept the ${win.length}-bar low ${lo} and closed back above it with a long lower wick` };
    return null;
  }
  function choch(b) {
    const n = b.length - 1, P = pivots(b, 2, Math.max(0, n - 80)).filter(p => p.i < n - 1);
    const H = P.filter(p => p.k === 'H').slice(-3), L = P.filter(p => p.k === 'L').slice(-3);
    if (H.length < 2 || L.length < 2) return null;
    const x = b[n], prev = b[n - 1];
    // was falling (lower highs and lower lows), now closes above the last swing high for the first time
    if (H[H.length - 1].p < H[H.length - 2].p && L[L.length - 1].p < L[L.length - 2].p && x.c > H[H.length - 1].p && prev.c <= H[H.length - 1].p)
      return { k: 'choch', dir: 1, origin: L[L.length - 1].p, level: H[H.length - 1].p, why: `after lower highs and lower lows, closed above the last swing high ${H[H.length - 1].p}` };
    if (H[H.length - 1].p > H[H.length - 2].p && L[L.length - 1].p > L[L.length - 2].p && x.c < L[L.length - 1].p && prev.c >= L[L.length - 1].p)
      return { k: 'choch', dir: -1, origin: H[H.length - 1].p, level: L[L.length - 1].p, why: `after higher highs and higher lows, closed below the last swing low ${L[L.length - 1].p}` };
    return null;
  }
  function squeeze(b, a) {
    const n = b.length - 1, B = bandwidths(b, 20); if (!B[n] || !B[n - 1] || n < 140) return null;
    const hist = B.slice(n - 120, n - 1).map(z => z && z.bw).filter(v => v != null).sort((p, q) => p - q);
    const pct = v => hist.filter(h => h <= v).length / hist.length;
    const x = b[n], rng = x.h - x.l, was = Math.min(pct(B[n - 1].bw), pct(B[n - 2] ? B[n - 2].bw : 1));
    if (was > 0.2 || rng < 1.2 * a) return null;
    if (x.c > B[n - 1].up) return { k: 'squeeze', dir: 1, origin: Math.min(...b.slice(n - 6, n).map(y => y.l)), level: B[n - 1].up, why: `volatility was in its lowest ${Math.round(was * 100) || 1}% of the last 120 bars and price closed above the upper band` };
    if (x.c < B[n - 1].lo) return { k: 'squeeze', dir: -1, origin: Math.max(...b.slice(n - 6, n).map(y => y.h)), level: B[n - 1].lo, why: `volatility was in its lowest ${Math.round(was * 100) || 1}% of the last 120 bars and price closed below the lower band` };
    return null;
  }
  function ignition(b, a) {
    const n = b.length - 1, x = b[n], rng = x.h - x.l, body = Math.abs(x.c - x.o); if (rng <= 0) return null;
    const win = b.slice(Math.max(0, n - 20), n); if (win.length < 15) return null;
    const hi = Math.max(...win.map(y => y.h)), lo = Math.min(...win.map(y => y.l));
    if (rng >= 1.8 * a && body >= 0.7 * rng) {
      if (x.c > hi) return { k: 'ignition', dir: 1, origin: x.o, level: hi, why: `a ${(rng / a).toFixed(1)}× ATR candle closed above the 20-bar high ${hi}` };
      if (x.c < lo) return { k: 'ignition', dir: -1, origin: x.o, level: lo, why: `a ${(rng / a).toFixed(1)}× ATR candle closed below the 20-bar low ${lo}` };
    }
    return null;
  }

  const BASE = { sweep: 35, choch: 32, squeeze: 30, ignition: 25 };
  // b = closed bars of the signal timeframe; htf = closed bars of the next higher timeframe (for trend and levels)
  function detect(b, htf, opt) {
    opt = opt || {};
    if (!b || b.length < 60) return [];
    const a = atr(b, 14); if (!a) return [];
    const found = [sweep(b, a), choch(b), squeeze(b, a), ignition(b, a)].filter(Boolean);
    if (!found.length) return [];
    const ht = trendOf(htf), px = b[b.length - 1].c;
    const levels = htf && htf.length > 10 ? pivots(htf, 2, Math.max(0, htf.length - 120)).map(p => p.p) : [];
    const out = [];
    for (const dir of [1, -1]) {
      const sig = found.filter(f => f.dir === dir); if (!sig.length) continue;
      let score = Math.max(...sig.map(s => BASE[s.k])) + (sig.length - 1) * 12;
      const notes = [];
      if (ht === dir) { score += 15; notes.push('with the higher-timeframe trend'); }
      else if (ht === -dir) { score -= 8; notes.push('against the higher-timeframe trend (counter-trend start)'); }
      const origin = dir > 0 ? Math.min(...sig.map(s => s.origin)) : Math.max(...sig.map(s => s.origin));
      const nearLvl = levels.find(l => Math.abs(l - origin) <= 0.6 * a);
      if (nearLvl != null) { score += 10; notes.push(`started at a higher-timeframe level (${nearLvl})`); }
      const run = dir * (px - origin) / a;           // how far it has already gone, in ATRs
      if (run > 3) { score -= 25; notes.push(`already ${run.toFixed(1)} ATR from the origin (late)`); }
      else if (run > 2) { score -= 10; notes.push(`${run.toFixed(1)} ATR from the origin`); }
      else notes.push(`only ${Math.max(0, run).toFixed(1)} ATR from the origin (early)`);
      score = Math.max(0, Math.min(100, Math.round(score)));
      out.push({
        tf: opt.tf || '', dir, side: dir > 0 ? 'BUY' : 'SELL', score, price: px, atr: a, origin,
        stopIdea: dir > 0 ? origin - 0.3 * a : origin + 0.3 * a,
        patterns: sig.map(s => s.k), why: sig.map(s => s.why).concat(notes), at: b[b.length - 1].t,
      });
    }
    return out.sort((p, q) => q.score - p.score);
  }

  // a compact text picture of a pair for a fast screening model
  function brief(sym, m15, h1, h4) {
    const f = (b, label) => {
      if (!b || b.length < 30) return `${label}: not enough candles`;
      const a = atr(b, 14), n = b.length - 1, c = b.map(x => x.c), e20 = ema(c, 20)[n], e50 = ema(c, 50)[n];
      const P = pivots(b, 2, Math.max(0, n - 60)), H = P.filter(p => p.k === 'H').slice(-3).map(p => p.p), L = P.filter(p => p.k === 'L').slice(-3).map(p => p.p);
      const last = b.slice(-6).map(x => `${new Date(x.t).toISOString().slice(5, 16).replace('T', ' ')} O${x.o} H${x.h} L${x.l} C${x.c}`).join('; ');
      const tr = trendOf(b);
      return `${label}: close ${b[n].c}, ATR14 ${a && +a.toPrecision(4)}, EMA20 ${e20 && +e20.toPrecision(6)}, EMA50 ${e50 && +e50.toPrecision(6)}, trend ${tr > 0 ? 'up' : tr < 0 ? 'down' : 'mixed'}, last swing highs ${H.join(', ') || 'n/a'}, last swing lows ${L.join(', ') || 'n/a'}, 20-bar range ${Math.min(...b.slice(-20).map(x => x.l))}-${Math.max(...b.slice(-20).map(x => x.h))}. Last 6 candles: ${last}`;
    };
    return `${sym}\n${f(h4, '4H')}\n${f(h1, '1H')}\n${f(m15, '15M')}`;
  }

  // when each session opens today (UTC ms), from local opening times, so daylight saving is handled
  const SESS = [['Sydney', 'Australia/Sydney', 8], ['Tokyo', 'Asia/Tokyo', 9], ['London', 'Europe/London', 8], ['New York', 'America/New_York', 8]];
  function zonedUtc(tz, y, mo, d, hh) {
    let t = Date.UTC(y, mo, d, hh);
    for (let k = 0; k < 3; k++) {   // adjust until the local time in tz is hh:00 on that date
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t));
      const g = n => +parts.find(p => p.type === n).value;
      const local = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'));
      t += Date.UTC(y, mo, d, hh) - local;
    }
    return t;
  }
  function sessionOpens(now) {
    const out = [], d0 = new Date(now);
    for (const off of [-1, 0, 1]) {
      const d = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate() + off));
      for (const [name, tz, hh] of SESS) {
        // the local date in tz that corresponds to this UTC day
        const t = zonedUtc(tz, d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh);
        const wd = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short' }).format(new Date(t));
        if (wd === 'Sat' || wd === 'Sun') continue;      // no weekend sessions
        out.push({ name, t });
      }
    }
    const seen = new Set();
    return out.filter(x => { const k = x.name + x.t; if (seen.has(k)) return false; seen.add(k); return true; }).sort((p, q) => p.t - q.t);
  }
  // the session that opened in the last `withinMin` minutes, if any
  function justOpened(now, withinMin) {
    return sessionOpens(now).filter(s => s.t <= now && now - s.t <= (withinMin || 65) * 60000).pop() || null;
  }

  // ---- signal follow-through (v34): did price travel 1 ATR in the signal's direction before 1 ATR against it?
  // bars: candles of the signal's timeframe, oldest first. Returns null while the signal is still inside its window.
  // A candle that touches both counts as a miss (cautious). "flat" = neither within the window (16 x 15M, 12 x 1H).
  function scoreSignal(s, bars) {
    const side = s.side === 'BUY' ? 1 : -1, a = +s.atr, p = +s.price, ms = s.tf === '15M' ? 9e5 : 36e5, H = s.tf === '15M' ? 16 : 12;
    if (!(a > 0) || !isFinite(p) || !bars || !bars.length) return null;
    let n = 0, mfe = 0, mae = 0;
    for (const b of bars) {
      if (b.t < s.at + ms) continue; n++;
      const fav = side > 0 ? b.h - p : p - b.l, adv = side > 0 ? p - b.l : b.h - p;
      mfe = Math.max(mfe, fav); mae = Math.max(mae, adv);
      const r = x => +(x / a).toFixed(2);
      if (adv >= a) return { res: 'miss', mfe: r(Math.min(mfe, a)), mae: 1, bars: n };
      if (fav >= a) return { res: 'hit', mfe: 1, mae: r(mae), bars: n };
      if (n >= H) return { res: 'flat', mfe: r(mfe), mae: r(mae), bars: n };
    }
    return null;
  }
  const sigKey = s => s.tf + ' ' + [...(s.patterns || [])].sort().join('+');
  const withTrend = s => (s.why || []).some(w => /with the higher-timeframe trend/.test(w)) ? 'with trend' : (s.why || []).some(w => /against the higher-timeframe/.test(w)) ? 'counter-trend' : 'no clear trend';
  // follow-through rates of resolved signals, grouped. hit rate = hits / (hits + misses); flats are counted apart.
  function sigStats(list) {
    const done = (list || []).filter(s => s.res && s.res !== 'pending'), groups = {};
    const add = (k, s) => { const g = groups[k] || (groups[k] = { k, n: 0, hit: 0, miss: 0, flat: 0 }); g.n++; g[s.res]++; };
    for (const s of done) { add('type: ' + sigKey(s), s); add('score: ' + (s.score >= 70 ? '70+' : s.score >= 50 ? '50-69' : 'under 50'), s); add('trend: ' + withTrend(s), s); add('all', s); }
    for (const g of Object.values(groups)) { const d = g.hit + g.miss; g.rate = d ? g.hit / d : null; g.shrunk = d ? (g.hit + 5) / (d + 10) : 0.5; }
    return groups;
  }
  // a line for an alert, and whether this kind of signal has proved itself unreliable (20+ resolved, under 40% after shrinking)
  function sigVerdict(s, list) {
    const G = sigStats(list), g = G['type: ' + sigKey(s)];
    if (!g || g.hit + g.miss < 5) return { line: '', weak: false, n: g ? g.hit + g.miss : 0 };
    const d = g.hit + g.miss;
    return { line: `Track record of ${sigKey(s)} signals: ${g.hit} of ${d} followed through 1 ATR before reversing 1 ATR (${Math.round(g.rate * 100)}%)${g.flat ? `, ${g.flat} went nowhere` : ''}.`, weak: d >= 20 && g.shrunk < 0.4, strong: d >= 20 && g.shrunk > 0.6, n: d, rate: g.rate };
  }

  const api = { ema, atr, bandwidths, pivots, trendOf, to4h, sweep, choch, squeeze, ignition, detect, brief, sessionOpens, justOpened, scoreSignal, sigKey, sigStats, sigVerdict };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.EVDetect = api;
})(typeof window !== 'undefined' ? window : globalThis);
