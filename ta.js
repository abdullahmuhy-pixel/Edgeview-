/* Edgeview technical toolkit (v35). Shared by the app (window.EVTA) and Node tests.
   Every number an experienced trader would mark on the chart is worked out here in code, so the analyst
   never has to guess a level from an image:
     session and liquidity levels   Asia range, London and New York opening ranges, New York midnight open,
                                    previous day / week / month highs and lows, untouched equal highs and lows
     divergence                     regular and hidden RSI divergence on the last two swings
     order blocks                   the last opposite candle before a displacement that broke structure, still unmitigated
     Fibonacci extensions           1.272 / 1.618 / 2.0 of the last leg, for targets
     premium / discount             where price sits inside the current dealing range
     trend strength                 ADX with +DI/-DI and the Kaufman efficiency ratio, classified as trending / ranging / transition
     VWAP                           session VWAP from 00:00 UTC and VWAP anchored at the last major swing high and low
                                    (time-weighted when the market has no real volume, and labelled so)
     volume profile                 point of control and the 70% value area (only where real volume exists)
     currency strength              each currency's average move against the others, from the majors
   Bars are oldest first: {t (ms, bar open UTC), o, h, l, c, v}. */
(function (root) {
  'use strict';
  const fromVals = vals => [...(vals || [])].reverse().map(x => {
    const d = String(x.datetime || ''); const t = Date.parse(d.length <= 10 ? d + 'T00:00:00Z' : d.replace(' ', 'T') + (/[zZ]$|[+-]\d\d:?\d\d$/.test(d.slice(10)) ? '' : 'Z'));
    return { t, o: +x.open, h: +x.high, l: +x.low, c: +x.close, v: x.volume != null && x.volume !== '' ? +x.volume : null };
  }).filter(b => isFinite(b.t) && isFinite(b.c));
  const closed = (b, ms, now) => (b || []).filter(x => x.t + ms <= now);
  const dec = x => { const a = Math.abs(+x); return a >= 1000 ? 2 : a >= 20 ? 3 : a >= 0.1 ? 5 : a >= 0.001 ? 6 : 8; };
  const fx = x => x == null || !isFinite(x) ? 'n/a' : (+x).toFixed(dec(x));

  function atr(b, n) {
    n = n || 14; if (!b || b.length < n + 1) return null;
    const tr = []; for (let i = 1; i < b.length; i++) tr.push(Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c)));
    let a = 0; for (let i = 0; i < n; i++) a += tr[i]; a /= n; for (let i = n; i < tr.length; i++) a = (a * (n - 1) + tr[i]) / n; return a;
  }
  function rsiSeries(c, n) {
    n = n || 14; const out = new Array(c.length).fill(null); if (c.length < n + 1) return out;
    let g = 0, l = 0; for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; d >= 0 ? g += d : l -= d; } g /= n; l /= n;
    out[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    for (let i = n + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
    return out;
  }
  function pivots(b, k, from) {
    const P = []; for (let i = Math.max(k, from || 0); i < b.length - k; i++) {
      let hi = true, lo = true;
      for (let j = i - k; j <= i + k; j++) { if (j === i) continue; if (j < i ? b[j].h >= b[i].h : b[j].h > b[i].h) hi = false; if (j < i ? b[j].l <= b[i].l : b[j].l < b[i].l) lo = false; }
      if (hi) P.push({ i, t: b[i].t, p: b[i].h, k: 'H' }); if (lo) P.push({ i, t: b[i].t, p: b[i].l, k: 'L' });
    }
    return P;
  }

  // ---- trend strength
  function adx(b, n) {
    n = n || 14; if (!b || b.length < 2 * n + 2) return null;
    let tr = 0, pd = 0, md = 0; const dx = [];
    for (let i = 1; i < b.length; i++) {
      const up = b[i].h - b[i - 1].h, dn = b[i - 1].l - b[i].l, t = Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
      const p = up > dn && up > 0 ? up : 0, m = dn > up && dn > 0 ? dn : 0;
      if (i <= n) { tr += t; pd += p; md += m; if (i < n) continue; } else { tr = tr - tr / n + t; pd = pd - pd / n + p; md = md - md / n + m; }
      const pdi = tr ? 100 * pd / tr : 0, mdi = tr ? 100 * md / tr : 0; dx.push({ dx: pdi + mdi ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0, pdi, mdi });
    }
    if (dx.length < n) return null;
    let a = 0; for (let i = 0; i < n; i++) a += dx[i].dx; a /= n; for (let i = n; i < dx.length; i++) a = (a * (n - 1) + dx[i].dx) / n;
    const last = dx[dx.length - 1]; return { adx: a, pdi: last.pdi, mdi: last.mdi };
  }
  function effRatio(c, n) { n = n || 20; if (c.length <= n) return null; const k = c.length - 1; let s = 0; for (let i = k - n + 1; i <= k; i++) s += Math.abs(c[i] - c[i - 1]); return s ? Math.abs(c[k] - c[k - n]) / s : 0; }
  function regimeOf(b) {
    const a = adx(b, 14), er = effRatio(b.map(x => x.c), 20); if (!a || er == null) return null;
    const dir = a.pdi > a.mdi ? 1 : -1;
    const kind = a.adx >= 25 && er >= 0.3 ? 'trending' : a.adx < 20 && er < 0.25 ? 'ranging' : 'transition';
    return { kind, dir: kind === 'ranging' ? 0 : dir, adx: a.adx, pdi: a.pdi, mdi: a.mdi, er };
  }

  // ---- divergence between price and RSI on the last two swings (the later swing must be recent)
  function divergence(b, k, recent) {
    k = k || 3; recent = recent || 12; if (!b || b.length < 60) return [];
    const c = b.map(x => x.c), r = rsiSeries(c, 14), n = b.length, P = pivots(b, k, Math.max(0, n - 80)), out = [];
    const two = kind => P.filter(p => p.k === kind).slice(-2);
    const [l1, l2] = two('L'), [h1, h2] = two('H');
    if (l1 && l2 && n - 1 - l2.i <= recent && r[l1.i] != null && r[l2.i] != null) {
      if (l2.p < l1.p && r[l2.i] > r[l1.i] + 2) out.push({ kind: 'regular bullish', dir: 1, a: l1, b: l2, ra: r[l1.i], rb: r[l2.i] });
      if (l2.p > l1.p && r[l2.i] < r[l1.i] - 2) out.push({ kind: 'hidden bullish', dir: 1, a: l1, b: l2, ra: r[l1.i], rb: r[l2.i] });
    }
    if (h1 && h2 && n - 1 - h2.i <= recent && r[h1.i] != null && r[h2.i] != null) {
      if (h2.p > h1.p && r[h2.i] < r[h1.i] - 2) out.push({ kind: 'regular bearish', dir: -1, a: h1, b: h2, ra: r[h1.i], rb: r[h2.i] });
      if (h2.p < h1.p && r[h2.i] > r[h1.i] + 2) out.push({ kind: 'hidden bearish', dir: -1, a: h1, b: h2, ra: r[h1.i], rb: r[h2.i] });
    }
    return out;
  }

  // ---- order blocks: the last opposite-colour candle before a displacement (>= 1.5 ATR within 3 candles) that
  // closed beyond the high (low) of the previous 10 candles. Still valid while price has not traded back into it.
  function orderBlocks(b, a, look) {
    look = look || 120; if (!b || b.length < 40 || !a) return [];
    const n = b.length, out = [];
    for (let i = Math.max(11, n - look); i < n - 3; i++) {
      const x = b[i], prevHi = Math.max(...b.slice(i - 10, i).map(y => y.h)), prevLo = Math.min(...b.slice(i - 10, i).map(y => y.l));
      const nxt = b.slice(i + 1, i + 4), maxC = Math.max(...nxt.map(y => y.c)), minC = Math.min(...nxt.map(y => y.c));
      if (x.c < x.o && maxC - x.h >= 1.5 * a && maxC > prevHi) {
        let ok = true; for (let j = i + 4; j < n; j++) if (b[j].l <= x.h) { ok = false; break; }
        if (ok) out.push({ dir: 1, lo: x.l, hi: x.h, t: x.t, i });
      }
      if (x.c > x.o && x.l - minC >= 1.5 * a && minC < prevLo) {
        let ok = true; for (let j = i + 4; j < n; j++) if (b[j].h >= x.l) { ok = false; break; }
        if (ok) out.push({ dir: -1, lo: x.l, hi: x.h, t: x.t, i });
      }
    }
    return out;
  }

  // ---- last leg, Fibonacci extensions and premium / discount
  function lastLeg(b, k) {
    const P = pivots(b, k || 3, Math.max(0, b.length - 200)), H = P.filter(p => p.k === 'H').pop(), L = P.filter(p => p.k === 'L').pop();
    if (!H || !L) return null; const up = L.i < H.i; return { up, from: up ? L.p : H.p, to: up ? H.p : L.p, hi: H.p, lo: L.p };
  }
  function fibExt(leg) {
    if (!leg) return null; const d = leg.to - leg.from;
    return { r1272: leg.from + d * 1.272, r1618: leg.from + d * 1.618, r2: leg.from + d * 2, up: leg.up };
  }
  // dealing range: the last swing high and low; if price has left it, the high and low of the last 100 candles
  function dealingRange(b, k, px) {
    const leg = b && b.length > 30 ? lastLeg(b, k) : null; if (leg && px >= leg.lo && px <= leg.hi) return leg;
    if (!b || b.length < 30) return leg; const s = b.slice(-100); return { hi: Math.max(...s.map(x => x.h)), lo: Math.min(...s.map(x => x.l)), wide: true };
  }
  function premiumDiscount(leg, px) {
    if (!leg || !(leg.hi > leg.lo)) return null; const pos = (px - leg.lo) / (leg.hi - leg.lo);
    return { pos, zone: pos > 1 ? 'above the range' : pos < 0 ? 'below the range' : pos >= 0.55 ? 'premium' : pos <= 0.45 ? 'discount' : 'equilibrium', eq: (leg.hi + leg.lo) / 2 };
  }

  // ---- time zones (daylight saving handled by Intl)
  function zonedUtc(tz, y, mo, d, hh, mm) {
    let t = Date.UTC(y, mo, d, hh, mm || 0);
    for (let k = 0; k < 3; k++) {
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t));
      const g = n => +parts.find(p => p.type === n).value;
      t += Date.UTC(y, mo, d, hh, mm || 0) - Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'));
    }
    return t;
  }
  function localDate(tz, t) { const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t)).split('-').map(Number); return { y: p[0], mo: p[1] - 1, d: p[2] }; }
  const rangeOf = (b, a, z) => { const s = b.filter(x => x.t >= a && x.t < z); if (!s.length) return null; return { hi: Math.max(...s.map(x => x.h)), lo: Math.min(...s.map(x => x.l)), n: s.length }; };

  // ---- session and liquidity levels. m15: 15-minute bars (or 1H), d1: daily bars, h1: hourly bars, all closed.
  function sessionLevels(m15, d1, h1, now, px) {
    const out = { lines: [], levels: [] }, add = (name, p, note) => { if (p != null && isFinite(p)) { out.levels.push({ name, p }); out.lines.push(`${name} ${fx(p)}${note ? ' (' + note + ')' : ''}`); } };
    const day0 = Math.floor(now / 864e5) * 864e5, last = m15 && m15.length ? m15[m15.length - 1] : null;
    const status = (hi, lo, a) => { const after = (m15 || []).filter(x => x.t >= a); if (!after.length) return ''; const tH = after.some(x => x.h > hi), tL = after.some(x => x.l < lo); return tH && tL ? 'both sides taken since' : tH ? 'high taken since' : tL ? 'low taken since' : 'untouched since'; };
    if (m15 && m15.length) {
      const as = rangeOf(m15, day0, day0 + 7 * 36e5);
      if (as) { const done = now >= day0 + 7 * 36e5; out.lines.push(`Asia range today (00:00-07:00 UTC${done ? '' : ', still forming'}): high ${fx(as.hi)}, low ${fx(as.lo)}${done ? ', ' + status(as.hi, as.lo, day0 + 7 * 36e5) : ''}`); out.levels.push({ name: 'Asia high', p: as.hi }, { name: 'Asia low', p: as.lo }); }
      for (const [nm, tz, hh, mm] of [['London', 'Europe/London', 8, 0], ['New York', 'America/New_York', 9, 30]]) {
        const ld = localDate(tz, now), a = zonedUtc(tz, ld.y, ld.mo, ld.d, hh, mm);
        if (now >= a + 36e5) { const r = rangeOf(m15, a, a + 36e5); if (r) { out.lines.push(`${nm} opening range (first hour from ${new Date(a).toISOString().slice(11, 16)} UTC): high ${fx(r.hi)}, low ${fx(r.lo)}, ${status(r.hi, r.lo, a + 36e5)}`); out.levels.push({ name: nm + ' OR high', p: r.hi }, { name: nm + ' OR low', p: r.lo }); } }
      }
      const nd = localDate('America/New_York', now), mo = zonedUtc('America/New_York', nd.y, nd.mo, nd.d, 0, 0), mb = m15.find(x => x.t >= mo);
      if (mb && px != null) add('New York midnight open', mb.o, px > mb.o ? 'price above it' : 'price below it');
    }
    if (d1 && d1.length > 2) {
      const prev = d1.filter(x => x.t < day0).pop(); if (prev) { add('Previous day high', prev.h, last ? (m15.filter(x => x.t >= day0).some(x => x.h > prev.h) ? 'taken today' : 'not taken today') : ''); add('Previous day low', prev.l, last ? (m15.filter(x => x.t >= day0).some(x => x.l < prev.l) ? 'taken today' : 'not taken today') : ''); }
      const dw = (new Date(now).getUTCDay() + 6) % 7, wk0 = day0 - dw * 864e5, pw = d1.filter(x => x.t >= wk0 - 7 * 864e5 && x.t < wk0);
      if (pw.length) { add('Previous week high', Math.max(...pw.map(x => x.h))); add('Previous week low', Math.min(...pw.map(x => x.l))); }
      const cw = d1.filter(x => x.t >= wk0); if (cw.length) add('This week open', cw[0].o);
      const dt = new Date(now), m0 = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), 1), pm0 = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() - 1, 1), pm = d1.filter(x => x.t >= pm0 && x.t < m0);
      if (pm.length > 10) { add('Previous month high', Math.max(...pm.map(x => x.h))); add('Previous month low', Math.min(...pm.map(x => x.l))); }
    }
    // untouched equal highs / lows on 1H: two swings within 0.1 ATR, not traded through since the second
    if (h1 && h1.length > 60) {
      const a = atr(h1, 14), P = pivots(h1, 3, Math.max(0, h1.length - 200)), pools = [];
      for (const kind of ['H', 'L']) {
        const S = P.filter(p => p.k === kind);
        for (let i = 0; i < S.length; i++) for (let j = i + 1; j < S.length; j++) {
          if (Math.abs(S[i].p - S[j].p) > 0.1 * a) continue; const lvl = kind === 'H' ? Math.max(S[i].p, S[j].p) : Math.min(S[i].p, S[j].p);
          const later = h1.slice(S[j].i + 1); if (later.some(x => kind === 'H' ? x.h > lvl : x.l < lvl)) continue;
          if (!pools.some(q => q.kind === kind && Math.abs(q.p - lvl) <= 0.1 * a)) pools.push({ kind, p: lvl });
        }
      }
      const ab = pools.filter(q => q.kind === 'H' && q.p > px).sort((x, y) => x.p - y.p).slice(0, 2), bl = pools.filter(q => q.kind === 'L' && q.p < px).sort((x, y) => y.p - x.p).slice(0, 2);
      if (ab.length || bl.length) out.lines.push(`Untouched equal highs/lows on 1H (resting stops, likely targets for a sweep): above ${ab.map(q => fx(q.p)).join(', ') || 'none'}; below ${bl.map(q => fx(q.p)).join(', ') || 'none'}`);
      ab.forEach(q => out.levels.push({ name: 'Equal highs', p: q.p })); bl.forEach(q => out.levels.push({ name: 'Equal lows', p: q.p }));
    }
    return out;
  }

  // ---- VWAP. Real volume when present, otherwise every bar counts the same (TWAP) and it is labelled so.
  function vwapFrom(b, fromT) {
    const s = b.filter(x => x.t >= fromT); if (s.length < 3) return null; const hasV = s.every(x => x.v > 0);
    let pv = 0, vv = 0, p2 = 0; for (const x of s) { const tp = (x.h + x.l + x.c) / 3, w = hasV ? x.v : 1; pv += tp * w; vv += w; p2 += tp * tp * w; }
    const m = pv / vv, sd = Math.sqrt(Math.max(0, p2 / vv - m * m)); return { v: m, sd, hasV, n: s.length };
  }
  function vwapBlock(m15, h1, now, px) {
    const out = []; if (!m15 || m15.length < 10) return '';
    const day0 = Math.floor(now / 864e5) * 864e5, s = vwapFrom(m15, day0);
    const lab = w => w.hasV ? 'VWAP' : 'TWAP (no real volume for this market, so time-weighted)';
    if (s) out.push(`Session ${lab(s)} since 00:00 UTC ${fx(s.v)}, ±1σ ${fx(s.v - s.sd)} / ${fx(s.v + s.sd)}; price ${px > s.v ? 'above' : 'below'} it`);
    if (h1 && h1.length > 60) {
      const P = pivots(h1, 5, Math.max(0, h1.length - 240)), H = P.filter(p => p.k === 'H').pop(), L = P.filter(p => p.k === 'L').pop();
      for (const [nm, p] of [['last major swing high', H], ['last major swing low', L]]) { if (!p) continue; const w = vwapFrom(h1, p.t); if (w) out.push(`Anchored ${w.hasV ? 'VWAP' : 'TWAP'} from the ${nm} ${fx(p.p)} (${new Date(p.t).toISOString().slice(5, 16).replace('T', ' ')} UTC): ${fx(w.v)}, price ${px > w.v ? 'above' : 'below'} it`); }
    }
    return out.join('\n');
  }
  // ---- volume profile with point of control and the 70% value area
  function volumeProfile(b, bins) {
    bins = bins || 40; if (!b || b.length < 20 || !b.every(x => x.v > 0)) return null;
    const lo = Math.min(...b.map(x => x.l)), hi = Math.max(...b.map(x => x.h)); if (!(hi > lo)) return null;
    const w = (hi - lo) / bins, vol = new Array(bins).fill(0);
    for (const x of b) { const a = Math.max(0, Math.floor((x.l - lo) / w)), z = Math.min(bins - 1, Math.floor((x.h - lo) / w)); const each = x.v / (z - a + 1); for (let i = a; i <= z; i++) vol[i] += each; }
    let poc = 0; for (let i = 1; i < bins; i++) if (vol[i] > vol[poc]) poc = i;
    const tot = vol.reduce((s, v) => s + v, 0); let a = poc, z = poc, acc = vol[poc];
    while (acc < 0.7 * tot && (a > 0 || z < bins - 1)) { const dn = a > 0 ? vol[a - 1] : -1, up = z < bins - 1 ? vol[z + 1] : -1; if (up >= dn) { z++; acc += vol[z]; } else { a--; acc += vol[a]; } }
    return { poc: lo + (poc + 0.5) * w, val: lo + a * w, vah: lo + (z + 1) * w, lo, hi };
  }

  // ---- currency strength. series: {'EUR/USD': closes oldest first, ...}; returns % move per currency over the last k bars, averaged over its pairs.
  function strength(series, k) {
    const acc = {};
    for (const [sym, c] of Object.entries(series || {})) {
      if (!c || c.length <= k) continue; const m = String(sym).toUpperCase().match(/^([A-Z]{3})\/?([A-Z]{3})$/); if (!m) continue;
      const ch = (c[c.length - 1] / c[c.length - 1 - k] - 1) * 100;
      (acc[m[1]] = acc[m[1]] || []).push(ch); (acc[m[2]] = acc[m[2]] || []).push(-ch);
    }
    return Object.entries(acc).map(([ccy, a]) => ({ ccy, v: a.reduce((s, x) => s + x, 0) / a.length, n: a.length })).sort((a, b) => b.v - a.v);
  }

  // ---- the block of tools for one timeframe
  function tfTools(label, b, px, k) {
    if (!b || b.length < 60) return '';
    const a = atr(b, 14), rg = regimeOf(b), dv = divergence(b, k, label === '15M' ? 16 : 12), ob = orderBlocks(b, a), leg = lastLeg(b, k), ex = fibExt(leg), dr = dealingRange(b, k, px), pd = premiumDiscount(dr, px);
    const parts = [];
    if (rg) parts.push(`trend strength: ADX ${rg.adx.toFixed(0)} (+DI ${rg.pdi.toFixed(0)} / -DI ${rg.mdi.toFixed(0)}), efficiency ratio ${rg.er.toFixed(2)}: ${rg.kind.toUpperCase()}${rg.kind === 'ranging' ? '' : rg.dir > 0 ? ' up' : ' down'}`);
    parts.push(dv.length ? 'RSI divergence: ' + dv.map(d => `${d.kind} (price ${fx(d.a.p)} → ${fx(d.b.p)}, RSI ${d.ra.toFixed(0)} → ${d.rb.toFixed(0)})`).join('; ') : 'no RSI divergence on the last two swings');
    const near = (d, side) => ob.filter(o => o.dir === d && (side > 0 ? o.lo > px : o.hi < px)).sort((x, y) => side > 0 ? x.lo - y.lo : y.hi - x.hi).slice(0, 2);
    const bo = near(1, -1), so = near(-1, 1), inn = ob.filter(o => o.lo <= px && o.hi >= px);
    parts.push(`unmitigated order blocks: bullish below ${bo.map(o => fx(o.lo) + '-' + fx(o.hi)).join(', ') || 'none'}; bearish above ${so.map(o => fx(o.lo) + '-' + fx(o.hi)).join(', ') || 'none'}${inn.length ? '; price is inside a ' + (inn[0].dir > 0 ? 'bullish' : 'bearish') + ' block ' + fx(inn[0].lo) + '-' + fx(inn[0].hi) : ''}`);
    if (ex) parts.push(`Fibonacci extensions of the last ${ex.up ? 'up' : 'down'} leg ${fx(leg.from)} → ${fx(leg.to)}: 1.272 ${fx(ex.r1272)}, 1.618 ${fx(ex.r1618)}, 2.0 ${fx(ex.r2)}`);
    if (pd) parts.push(`dealing range ${fx(dr.lo)}-${fx(dr.hi)}${dr.wide ? ' (last 100 candles: price has left the last swing range)' : ''}: price at ${(pd.pos * 100).toFixed(0)}% (${pd.zone}; equilibrium ${fx(pd.eq)})`);
    return `${label} tools: ` + parts.join('; ');
  }
  // compact numbers for the setup fingerprint (side: +1 buy, -1 sell)
  function fingerprint(b1, b4, px, side) {
    const out = {};
    const rg = b1 && b1.length > 60 ? regimeOf(b1) : null; if (rg) out.trd = rg.kind;
    const leg = b4 && b4.length > 60 ? dealingRange(b4, 3, px) : null, pd = premiumDiscount(leg, px);
    if (pd && side) out.pd = pd.zone === 'equilibrium' ? 'equilibrium' : (side > 0) === (pd.pos < 0.5) ? 'favourable' : 'unfavourable';   // buy in discount / sell in premium = favourable
    if (side && b1) { const d = [...divergence(b1, 3, 12), ...(b4 ? divergence(b4, 3, 8) : [])]; out.div = d.some(x => x.dir === side) ? 'with' : d.some(x => x.dir === -side) ? 'against' : 'none'; }
    return out;
  }
  const api = { fromVals, closed, atr, rsiSeries, pivots, adx, effRatio, regimeOf, divergence, orderBlocks, lastLeg, fibExt, dealingRange, premiumDiscount, zonedUtc, sessionLevels, vwapFrom, vwapBlock, volumeProfile, strength, tfTools, fingerprint, fx };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.EVTA = api;
})(typeof window !== 'undefined' ? window : globalThis);
