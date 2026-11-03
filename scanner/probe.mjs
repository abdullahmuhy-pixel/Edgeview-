const URLS = ['wss://api.derivws.com/trading/v1/options/ws/public', 'wss://ws.derivws.com/websockets/v3?app_id=1089'];
const ask = (url, req) => new Promise(res => { const ws = new WebSocket(url), t = setTimeout(() => { res({ error: { message: 'timeout' } }); try { ws.close(); } catch (e) { } }, 20000);
  ws.onopen = () => ws.send(JSON.stringify({ ...req, req_id: 1 })); ws.onmessage = e => { const j = JSON.parse(e.data); if (j.req_id !== 1) return; clearTimeout(t); ws.close(); res(j); }; ws.onerror = () => { clearTimeout(t); res({ error: { message: 'connect error' } }); }; });
for (const url of URLS) {
  console.log('=== ' + url);
  const a = await ask(url, { active_symbols: 'brief' });
  if (a.error) console.log('active_symbols ERR', a.error.message); else {
    const L = a.active_symbols || []; console.log('active_symbols', L.length, 'markets', [...new Set(L.map(x => x.market))].join(','));
    for (const m of ['forex', 'commodities', 'cryptocurrency', 'indices']) console.log(m, L.filter(x => x.market === m).map(x => x.symbol + '=' + x.display_name + (x.exchange_is_open ? '' : '(closed)')).join(' | ').slice(0, 1500));
    console.log('keys', Object.keys(L[0] || {}).join(','));
  }
  for (const s of ['frxXAUUSD', 'frxEURUSD', 'frxUSDZAR', 'cryBTCUSD']) { const c = await ask(url, { ticks_history: s, style: 'candles', granularity: 3600, count: 3, end: 'latest' }); console.log(s, c.error ? 'ERR ' + c.error.message : JSON.stringify(c.candles && c.candles.slice(-1))); }
  const ec = await ask(url, { economic_calendar: 1, start_date: Math.floor(Date.now() / 1000), end_date: Math.floor(Date.now() / 1000) + 86400 * 2 });
  console.log('economic_calendar', ec.error ? 'ERR ' + ec.error.message : JSON.stringify((ec.economic_calendar && ec.economic_calendar.events || []).slice(0, 3)));
  const tt = await ask(url, { trading_times: 'today' }); console.log('trading_times', tt.error ? 'ERR ' + tt.error.message : 'ok ' + JSON.stringify(tt.trading_times).slice(0, 300));
  const tk = await ask(url, { ticks_history: 'BOOM1000', style: 'ticks', count: 5000, end: 'latest' }); console.log('ticks BOOM1000', tk.error ? 'ERR ' + tk.error.message : (tk.history.prices.length + ' ticks, span s ' + (tk.history.times.at(-1) - tk.history.times[0])));
}
