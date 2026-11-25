// Offline event study over the kit's dev dataset (not used by the bot at runtime).
// Usage: node tools/study.mjs <kit dir> [json params]
// For every TradeEvent that passes an entry screen, simulate entering 2 slots later and exiting by
// stop / trailing / max-hold rules, then report net returns after curve fees and tx fees.
import { createReadStream, readdirSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const kit = process.argv[2];
const P = Object.assign(
  {
    win: 150, // rolling window in slots
    minRq: 3, // SOL real reserve at decision
    maxRq: 70,
    minAge: 300, // slots since first sighting
    minNet: 2, // net SOL inflow over window
    minBuyers: 5,
    maxRun: 0.6, // price up at most this over window low
    nearHigh: 0.03, // price within this of window high
    size: 0.1, // SOL
    stop: 0.08,
    trailArm: 0.08,
    trail: 0.06,
    hold: 600,
    cooldown: 3000,
  },
  process.argv[3] ? JSON.parse(process.argv[3]) : {},
);
const FEE = 0.0125;
const TX = 0.000105;

const files = readdirSync(join(kit, 'dataset/events')).filter((f) => f.endsWith('.gz')).sort();
const mints = new Map(); // mint -> {first, trades: [{slot, p, vq, vt, rq, buy, sol, user}], complete}
let slotMin = Infinity, slotMax = 0;
for (const f of files) {
  const rl = createInterface({ input: createReadStream(join(kit, 'dataset/events', f)).pipe(createGunzip()) });
  for await (const line of rl) {
    if (!line) continue;
    const e = JSON.parse(line);
    slotMin = Math.min(slotMin, e.slot); slotMax = Math.max(slotMax, e.slot);
    let m = mints.get(e.mint);
    if (!m) { m = { first: e.slot, created: e.event === 'CreateEvent', trades: [], complete: null }; mints.set(e.mint, m); }
    if (e.event === 'TradeEvent') {
      const vq = Number(e.virtual_quote_reserves) / 1e9, vt = Number(e.virtual_token_reserves);
      m.trades.push({ slot: e.slot, p: vq / vt, vq, vt, rq: Number(e.real_quote_reserves) / 1e9, buy: e.is_buy, sol: Number(e.sol_amount) / 1e9, user: e.user });
    } else if (e.event === 'CompleteEvent') m.complete = e.slot;
  }
}

const results = [];
for (const [mint, m] of mints) {
  const T = m.trades;
  let lastEntry = -Infinity;
  let lo = 0; // window start index
  for (let i = 0; i < T.length; i++) {
    const t = T[i];
    while (T[lo].slot < t.slot - P.win) lo++;
    if (t.slot - m.first < P.minAge || t.rq < P.minRq || t.rq > P.maxRq) continue;
    if (t.slot - lastEntry < P.cooldown) continue;
    if (i + 1 < T.length && T[i + 1].slot === t.slot) continue; // decide at slot end
    let net = 0, hi = 0, low = Infinity;
    const buyers = new Set();
    for (let j = lo; j <= i; j++) {
      const u = T[j];
      net += u.buy ? u.sol : -u.sol;
      if (u.buy) buyers.add(u.user);
      hi = Math.max(hi, u.p); low = Math.min(low, u.p);
    }
    if (net < P.minNet || buyers.size < P.minBuyers) continue;
    if (t.p > low * (1 + P.maxRun) || t.p < hi * (1 - P.nearHigh)) continue;
    // entry: reserves as of slot t.slot+2 (last trade at or before it)
    let k = i;
    while (k + 1 < T.length && T[k + 1].slot <= t.slot + 2) k++;
    if (m.complete !== null && m.complete <= t.slot + 2) continue;
    const e0 = T[k];
    const spend = P.size * (1 - FEE);
    const tokens = (e0.vt * spend) / (e0.vq + spend);
    lastEntry = t.slot;
    // walk forward; decisions at each trade, exit fills 2 slots later
    let peak = e0.p, exitIdx = -1, reason = 'end';
    for (let j = k + 1; j < T.length; j++) {
      const u = T[j];
      const r = u.p / e0.p - 1;
      peak = Math.max(peak, u.p);
      if (r <= -P.stop) { reason = 'stop'; exitIdx = j; break; }
      if (peak / e0.p - 1 >= P.trailArm && u.p <= peak * (1 - P.trail)) { reason = 'trail'; exitIdx = j; break; }
      if (u.slot - e0.slot >= P.hold) { reason = 'hold'; exitIdx = j; break; }
    }
    let x;
    if (exitIdx < 0) x = T[T.length - 1];
    else {
      let q = exitIdx;
      while (q + 1 < T.length && T[q + 1].slot <= T[exitIdx].slot + 2) q++;
      x = T[q];
    }
    const gross = (x.vq * tokens) / (x.vt + tokens);
    const pnl = gross * (1 - FEE) - P.size - 2 * TX;
    results.push({ mint, slot: t.slot, pnl, reason, ret: pnl / P.size });
  }
}
results.sort((a, b) => a.slot - b.slot);
const n = results.length;
const sum = results.reduce((s, r) => s + r.pnl, 0);
const wins = results.filter((r) => r.pnl > 0).length;
const rets = results.map((r) => r.ret).sort((a, b) => a - b);
const byReason = {};
for (const r of results) { byReason[r.reason] ??= [0, 0]; byReason[r.reason][0]++; byReason[r.reason][1] += r.pnl; }
// halves to check stability
const half = (slotMin + slotMax) / 2;
const h1 = results.filter((r) => r.slot < half).reduce((s, r) => s + r.pnl, 0);
const quarters = [0, 1, 2, 3].map((q) => results.filter((r) => r.slot >= slotMin + (q * (slotMax - slotMin)) / 4 && r.slot < slotMin + ((q + 1) * (slotMax - slotMin)) / 4 + 1).reduce((s, r) => s + r.pnl, 0).toFixed(3));
console.log(JSON.stringify(P));
console.log(`mints ${mints.size} slots ${slotMax - slotMin} trades ${n} pnl ${sum.toFixed(4)} SOL win ${(wins / Math.max(1, n)).toFixed(2)} median ${(rets[n >> 1] ?? 0).toFixed(4)} h1 ${h1.toFixed(3)} h2 ${(sum - h1).toFixed(3)} quarters ${quarters.join(' ')}`);
console.log('by reason', JSON.stringify(Object.fromEntries(Object.entries(byReason).map(([k, v]) => [k, [v[0], +v[1].toFixed(4)]]))));
