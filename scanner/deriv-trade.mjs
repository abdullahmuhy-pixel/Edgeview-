// Edgeview live robot on Deriv (v41): trades Multiplier contracts on your Deriv options account through Deriv's own API.
// Secrets: DERIV_TOKEN (a Personal Access Token with the trade scope) and DERIV_APP_ID (a PAT-type app registered at developers.deriv.com),
// optional DERIV_ACCOUNT_ID. Multipliers are market orders: the robot only takes setups that are ready now.
// A plan's stop and targets are prices; Deriv wants them as money, so they are converted:
//   P/L = stake x multiplier x (exit - entry) / entry (reversed for MULTDOWN)
// The multiplier is the largest Deriv allows with stake >= 1.1 x the planned loss, so the stop-out level (losing the whole stake)
// always sits beyond the stop: the worst case is the stake, even on a gap or a Boom/Crash spike.
const API = process.env.DERIV_API || 'https://api.derivws.com';

export function sizeMult(riskMoney, entry, sl, mults, minStake) {
  const d = Math.abs(entry - sl) / entry; if (!(d > 0) || !(riskMoney > 0)) return null;
  const ok = (mults || []).map(Number).filter(m => m > 0 && d * m <= 0.9).sort((a, b) => b - a);
  if (!ok.length) return null;                                   // stop too wide for the smallest multiplier
  const m = ok[0], stake = +(riskMoney / (d * m)).toFixed(2);
  if (stake < (minStake || 1)) return null;
  return { mult: m, stake, slMoney: +(stake * m * d).toFixed(2) };
}
export const tpMoney = (stake, mult, entry, tp) => +(stake * mult * Math.abs(tp - entry) / entry).toFixed(2);

class DerivWS {
  constructor(url) { this.url = url; this.seq = 1; this.wait = new Map(); }
  open() {
    return new Promise((res, rej) => {
      const ws = new WebSocket(this.url), to = setTimeout(() => rej(new Error('Deriv: connection timeout')), 20000);
      ws.onopen = () => { clearTimeout(to); this.ws = ws; res(this); };
      ws.onerror = () => { clearTimeout(to); rej(new Error('Deriv: cannot connect')); };
      ws.onmessage = e => { let j; try { j = JSON.parse(e.data); } catch (_) { return; } const w = this.wait.get(j.req_id); if (!w) return; this.wait.delete(j.req_id); j.error ? w.rej(new Error('Deriv: ' + (j.error.message || j.error.code))) : w.res(j); };
      ws.onclose = () => { for (const [k, w] of this.wait) { w.rej(new Error('Deriv: connection closed')); this.wait.delete(k); } };
    });
  }
  send(req) { const id = this.seq++; return new Promise((res, rej) => { this.wait.set(id, { res, rej }); this.ws.send(JSON.stringify({ ...req, req_id: id })); setTimeout(() => { if (this.wait.has(id)) { this.wait.delete(id); rej(new Error('Deriv: no answer to ' + Object.keys(req)[0])); } }, 25000); }); }
  close() { try { this.ws.close(); } catch (e) { } }
}
async function rest(path, method, tok, app) {
  const r = await fetch(API + path, { method, headers: { Authorization: 'Bearer ' + tok, 'Deriv-App-ID': app, 'content-type': 'application/json' } });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`Deriv ${path.split('/').slice(-1)[0]}: ${r.status} ${(j.errors && j.errors[0] && j.errors[0].message) || j.message || ''}`); return j;
}

// connects, describes the account, and returns the tools the shared robot loop needs
export async function derivBroker(M, env) {
  const tok = env.DERIV_TOKEN, app = env.DERIV_APP_ID;
  if (!tok || !app) throw new Error('Deriv is not set up: add the Deriv token and app ID in the app (Robot > Live account > Connect)');
  const accs = (await rest('/trading/v1/options/accounts', 'GET', tok, app)).data || [];
  const want = M.derivAcct === 'real' ? 'real' : 'demo';
  const acc = accs.find(a => env.DERIV_ACCOUNT_ID ? a.account_id === env.DERIV_ACCOUNT_ID : a.account_type === want && a.status !== 'inactive') || null;
  if (!acc) throw new Error(`no active ${want} options account found on this Deriv login`);
  const otp = await rest(`/trading/v1/options/accounts/${acc.account_id}/otp`, 'POST', tok, app), url = otp.data && (otp.data.url || otp.data.websocket_url);
  if (!url) throw new Error('Deriv did not return a WebSocket address');
  const ws = await new DerivWS(url).open();
  const bal = (await ws.send({ balance: 1 })).balance || {};
  const port = ((await ws.send({ portfolio: 1 })).portfolio || {}).contracts || [];
  const open = [];
  for (const c of port.filter(c => /^MULT/.test(c.contract_type || ''))) {
    const p = (await ws.send({ proposal_open_contract: 1, contract_id: c.contract_id }).catch(() => ({}))).proposal_open_contract || {};
    open.push({ id: c.contract_id, code: c.underlying || c.symbol || p.underlying, type: c.contract_type, stake: +(c.buy_price || p.buy_price || 0), value: +(p.bid_price || 0), pl: +(p.profit || 0), entry: +(p.entry_spot || 0), spot: +(p.current_spot || 0), mult: p.multiplier });
  }
  const equity = (+bal.balance || 0) + open.reduce((s, o) => s + o.value, 0), cur = bal.currency || acc.currency;
  const multCache = {};
  return {
    real: acc.account_type === 'real', acct: { balance: +bal.balance || 0, equity: +equity.toFixed(2), currency: cur, type: acc.account_type, broker: 'Deriv', server: acc.account_id },
    open,
    async spot(code) { const j = await ws.send({ ticks_history: code, style: 'ticks', count: 1, end: 'latest' }); const p = j.history && j.history.prices; return p && p.length ? +p[p.length - 1] : null; },
    async mults(code) {
      if (multCache[code]) return multCache[code];
      const j = await ws.send({ contracts_for: code, currency: cur }), av = ((j.contracts_for || {}).available || []).filter(x => x.contract_type === 'MULTUP');
      const ms = [...new Set(av.flatMap(x => x.multiplier_range || []))], minStake = Math.max(1, ...av.map(x => +x.min_stake || 0));
      return (multCache[code] = { ms, minStake });
    },
    async buy({ code, side, stake, mult, sl, tp }) {
      const pr = await ws.send({ proposal: 1, contract_type: side > 0 ? 'MULTUP' : 'MULTDOWN', symbol: code, amount: stake, basis: 'stake', currency: cur, multiplier: mult, limit_order: { stop_loss: sl, take_profit: tp } });
      const P = pr.proposal; if (!P || !P.id) throw new Error('Deriv gave no price');
      const b = (await ws.send({ buy: P.id, price: P.ask_price })).buy || {};
      return { contractId: b.contract_id, entry: +(P.spot || 0), paid: +(b.buy_price || P.ask_price) };
    },
    async sell(id) { return ws.send({ sell: id, price: 0 }); },
    async result(id) { const p = (await ws.send({ proposal_open_contract: 1, contract_id: id })).proposal_open_contract || {}; return { sold: !!(p.is_sold || p.status === 'sold' || p.status === 'won' || p.status === 'lost'), pl: +(p.profit || 0) }; },
    close() { ws.close(); },
  };
}
