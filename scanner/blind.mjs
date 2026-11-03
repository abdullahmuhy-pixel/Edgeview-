// Blind second opinion and mirror test (v43.6), shared by the scanner and the live robots.
// A cheap model sees only the candles of an unnamed instrument (no name, news, notes or account state)
// and gives its own direction. It also sees the same chart turned upside down: a neutral analyst must then
// give the opposite answer. The robots skip a trade the blind view disagrees with and halve the risk when
// the direction is unclear; the scanner drops alerts the blind view disagrees with.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const D = require('../detect.js');

export const BLIND_SYS = `You are an independent price-action analyst. You get only candle data and a structure summary for an unnamed instrument: no name, no news, no opinions. Judge direction from the data alone.
Score the bull case and the bear case separately from 0 to 10 with the same checklist: 4H and 1H trend structure (higher highs and lows or lower ones), price against the swing levels, EMAs, momentum, and where the latest candles closed.
bias is BUY if bull is at least 3 points above bear, SELL if bear is at least 3 points above bull, otherwise NONE.
Answer with JSON only, no other text:
{"bull":0,"bear":0,"bias":"BUY|SELL|NONE","confidence":0,"invalidation":0,"reason":"one short line"}`;

const r10 = x => +(+x).toPrecision(10);
// Mirror candles around K: an up-trend becomes a down-trend with the same shape; highs and lows swap.
export function mirrorBars(b, K) { return (b || []).map(x => ({ ...x, o: r10(K - x.o), h: r10(K - x.l), l: r10(K - x.h), c: r10(K - x.c) })); }
export const sideOfBias = x => x && /BUY/i.test(x.bias || '') ? 1 : x && /SELL/i.test(x.bias || '') ? -1 : 0;

async function ask(o, user) {
  const body = { model: o.model || 'claude-haiku-5-5', max_tokens: 1500, system: BLIND_SYS, messages: [{ role: 'user', content: user }], output_config: { effort: 'low' } };
  const send = b => fetch((o.base || 'https://api.anthropic.com') + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': o.ak, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(b) });
  let r = await send(body); if (!r.ok && r.status === 400) { delete body.output_config; r = await send(body); }
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error('Anthropic: ' + ((j.error && j.error.message) || r.status));
  const t = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join(''), m = t.match(/\{[\s\S]*\}/);
  try { return m ? JSON.parse(m[0]) : null; } catch (e) { return null; }
}
// o: {ak, base, model, m15, h1, h4, px}; bars are oldest first {t,o,h,l,c}
export async function blindCheck(o) {
  if (!o.ak) return null;
  const K = 2 * o.px, txt = (m15, h1, h4) => `Instrument: unnamed. Current price ${r10(o.px)}.\n` + D.brief('UNNAMED INSTRUMENT', m15, h1, h4);
  const [r, m] = await Promise.all([ask(o, txt(o.m15, o.h1, o.h4)), ask(o, txt(mirrorBars(o.m15, K), mirrorBars(o.h1, K), mirrorBars(o.h4, K))).catch(() => null)]);
  if (!r) return null;
  return { r, m, side: sideOfBias(r), mside: m ? -sideOfBias(m) : null };
}
// side: the plan's direction, +1 buy, -1 sell, 0 none. v: agree | disagree | unclear (mirror test failed) | neutral (no direction) | info
export function verdict(b, side) {
  if (!b || !b.r) return null;
  const mirrorOk = b.mside == null ? null : b.mside === b.side;
  const v = mirrorOk === false ? 'unclear' : !b.side ? 'neutral' : !side ? 'info' : b.side === side ? 'agree' : 'disagree';
  return { v, mirrorOk, side: b.side, bull: +b.r.bull, bear: +b.r.bear, reason: String(b.r.reason || '').slice(0, 200) };
}
export function verdictLine(V) {
  if (!V) return '';
  const nm = x => x > 0 ? 'BUY' : x < 0 ? 'SELL' : 'no clear direction';
  return `Blind check: ${{ agree: 'agrees', disagree: 'disagrees', unclear: 'unclear (mirror test failed)', neutral: 'no clear direction', info: 'info' }[V.v]} (sees ${nm(V.side)}, bull ${V.bull}/10, bear ${V.bear}/10)`;
}
