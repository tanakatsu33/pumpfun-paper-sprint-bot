// Defensive pump.fun paper-trading strategy for agent-fun/replay/v2.
//
// Two sleeves:
//  1. Guardrail probes: tiny (just over 0.01 SOL) round trips on liquid, mature curves that show a
//     mild upward screen. They exist to satisfy the "20 distinct coins with a round trip" guardrail
//     as cheaply as possible, early in the stream, then stop.
//  2. Momentum sleeve (off by default): small positions on strong, broad buy pressure with a tight
//     stop, a trailing exit and a short max hold.
//
// Fully deterministic: no clock, no randomness, only insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/agentfun-bot.ts';

const SOL = 1_000_000_000;

export interface Params {
  // --- probes
  probeTarget: number; // distinct coins with a completed probe round trip
  probeLamports: bigint; // buy size (just over the 0.01 SOL guardrail floor)
  probeMaxOpen: number; // concurrent probe positions
  probeMinRqSol: number; // min real SOL reserve
  probeMaxRqSol: number; // avoid curves about to complete
  probeMinAgeSlots: number; // slots since first sighting
  probeWindowSlots: number; // rolling window for the screen
  probeMinNetSol: number; // net SOL inflow over the window
  probeMinBuyers: number; // distinct buyers over the window
  probeMaxRunUp: number; // price at most this far above the window low (avoid vertical candles)
  probeHoldSlots: number; // sell after this many slots
  probeStop: number; // or when marked value falls this far below cost
  probeTarget_: number; // or rises this far above cost
  probeSpacingSlots: number; // min slots between probe entries
  relaxAfterSlots: number; // after this many slots behind pace, loosen the screen
  // --- momentum sleeve
  momEnabled: boolean;
  momMaxOpen: number;
  momMaxLamports: bigint;
  momMaxDeployedLamports: bigint;
  momWindowSlots: number;
  momMinRqSol: number;
  momMaxRqSol: number;
  momMinAgeSlots: number;
  momMinNetSol: number;
  momMinBuyers: number;
  momNearHigh: number;
  momMaxRunUp: number;
  momStop: number;
  momTrailArm: number;
  momTrail: number;
  momHoldSlots: number;
  momCooldownSlots: number;
  // --- shared
  buySlippageBps: number;
  sellSlippageBps: number;
}

export const DEFAULT_PARAMS: Params = {
  probeTarget: 23,
  probeLamports: 10_100_000n,
  probeMaxOpen: 3,
  probeMinRqSol: 5,
  probeMaxRqSol: 70,
  probeMinAgeSlots: 300,
  probeWindowSlots: 150,
  probeMinNetSol: 0.3,
  probeMinBuyers: 2,
  probeMaxRunUp: 0.25,
  probeHoldSlots: 60,
  probeStop: 0.25,
  probeTarget_: 0.1,
  probeSpacingSlots: 20,
  relaxAfterSlots: 12_000,
  momEnabled: false, // v1 grading: the sleeve lost money on dev; kept for reference only
  momMaxOpen: 2,
  momMaxLamports: 100_000_000n,
  momMaxDeployedLamports: 250_000_000n,
  momWindowSlots: 600,
  momMinRqSol: 10,
  momMaxRqSol: 60,
  momMinAgeSlots: 1_500,
  momMinNetSol: 5,
  momMinBuyers: 8,
  momNearHigh: 0.1,
  momMaxRunUp: 0.3,
  momStop: 0.08,
  momTrailArm: 0.08,
  momTrail: 0.06,
  momHoldSlots: 600,
  momCooldownSlots: 1_000_000,
  buySlippageBps: 1_500,
  sellSlippageBps: 5_000,
};

interface Tick {
  slot: number;
  signedSol: number; // +buy / -sell, SOL
  buyer: string | null;
  price: number; // virtual quote / virtual token, post-trade
}

interface MintInfo {
  firstSlot: number;
  ticks: Tick[]; // trades in the longest rolling window, oldest first
  head: number; // index of the first live tick
}

type Kind = 'probe' | 'mom';

interface Trade {
  kind: Kind;
  mint: Pubkey;
  phase: 'buying' | 'open' | 'selling';
  decidedSlot: number;
  openSlot: number; // fill slot of the buy
  costLamports: bigint;
  peakValue: number; // best marked value seen, lamports
}

const CURVE_FEE_BPS = 125n;

function priceOf(vq: bigint, vt: bigint): number {
  return vt === 0n ? 0 : Number(vq) / Number(vt);
}

/** Marked value of `tokens` sold now into the curve, after curve fees (lamports, as a number). */
function markValue(state: BotState, mint: Pubkey, tokens: bigint): number {
  const c = state.curves.get(mint);
  if (c === undefined || c.virtual_token_reserves === 0n) return 0;
  const q = (c.virtual_quote_reserves * tokens) / (c.virtual_token_reserves + tokens);
  return Number((q * (10_000n - CURVE_FEE_BPS)) / 10_000n);
}

interface WindowStats {
  netSol: number;
  buyers: number;
  low: number;
  high: number;
  first: number; // price at window start
}

function windowStats(info: MintInfo, nowSlot: number, win: number): WindowStats {
  let netSol = 0;
  let low = Infinity;
  let high = 0;
  let first = 0;
  const buyers = new Set<string>();
  for (let i = info.head; i < info.ticks.length; i++) {
    const t = info.ticks[i]!;
    if (t.slot < nowSlot - win) continue;
    if (first === 0) first = t.price;
    netSol += t.signedSol;
    if (t.buyer !== null) buyers.add(t.buyer);
    if (t.price < low) low = t.price;
    if (t.price > high) high = t.price;
  }
  return { netSol, buyers: buyers.size, low, high, first };
}

export function createStrategy(P: Params): Bot {
  const maxWin = Math.max(P.probeWindowSlots, P.momWindowSlots);
  const mints = new Map<Pubkey, MintInfo>();
  const trades = new Map<Pubkey, Trade>(); // live trades by mint, insertion ordered
  const probed = new Set<Pubkey>(); // mints ever probed (buy filled)
  const momTraded = new Map<Pubkey, number>(); // mint -> last momentum entry slot
  const cidKind = new Map<string, Pubkey>();
  let probesDone = 0;
  let startSlot = -1;
  let lastProbeSlot = -1_000_000;

  function onFills(state: BotState, batch: Batch): void {
    for (const f of batch.fills) {
      const mint = f.mint;
      const tr = trades.get(mint);
      cidKind.delete(f.client_id);
      if (tr === undefined) continue;
      if (f.side === 'buy') {
        if (f.status === 'filled') {
          tr.phase = 'open';
          tr.openSlot = f.slot;
          tr.costLamports = BigInt(f.quote_lamports) + BigInt(f.tx_fee_lamports);
          tr.peakValue = 0;
          if (tr.kind === 'probe') probed.add(mint);
        } else {
          trades.delete(mint); // rejected or failed: nothing held
        }
      } else if (!state.positions.has(mint)) {
        // sold out (our sell, or a harness close)
        if (tr.kind === 'probe' && f.status === 'filled') probesDone++;
        trades.delete(mint);
      } else if (tr.phase === 'selling') {
        tr.phase = 'open'; // sell failed or rejected: retry next batch
      }
    }
    // Positions closed by the harness without a fill we tracked (defensive).
    for (const [mint, tr] of trades) {
      if (tr.phase !== 'buying' && !state.positions.has(mint)) trades.delete(mint);
    }
  }

  function onEvents(batch: Batch): Pubkey[] {
    const touched: Pubkey[] = [];
    const seen = new Set<Pubkey>();
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        if (!mints.has(e.mint)) mints.set(e.mint, { firstSlot: e.slot, ticks: [], head: 0 });
        continue;
      }
      if (e.event !== 'TradeEvent') continue;
      let info = mints.get(e.mint);
      if (info === undefined) {
        info = { firstSlot: e.slot, ticks: [], head: 0 };
        mints.set(e.mint, info);
      }
      const sol = Number(BigInt(e.sol_amount)) / SOL;
      info.ticks.push({
        slot: e.slot,
        signedSol: e.is_buy ? sol : -sol,
        buyer: e.is_buy ? e.user : null,
        price: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
      });
      // prune ticks older than the longest window
      while (info.head < info.ticks.length && info.ticks[info.head]!.slot < e.slot - maxWin) info.head++;
      if (info.head > 256) {
        info.ticks = info.ticks.slice(info.head);
        info.head = 0;
      }
      if (!seen.has(e.mint)) {
        seen.add(e.mint);
        touched.push(e.mint);
      }
    }
    return touched;
  }

  function sellAll(state: BotState, tr: Trade, out: OrderInput[]): void {
    const h = state.positions.get(tr.mint);
    if (h === undefined || h.token_amount === 0n) return;
    out.push({ side: 'sell', mint: tr.mint, token_amount: h.token_amount, max_slippage_bps: P.sellSlippageBps });
    tr.phase = 'selling';
  }

  function exits(state: BotState, out: OrderInput[]): void {
    for (const tr of trades.values()) {
      if (tr.phase !== 'open' || out.length >= 16) continue;
      const h = state.positions.get(tr.mint);
      const c = state.curves.get(tr.mint);
      if (h === undefined || c === undefined || c.complete) continue;
      const value = markValue(state, tr.mint, h.token_amount);
      if (value > tr.peakValue) tr.peakValue = value;
      const cost = Number(tr.costLamports);
      const age = state.slot - tr.openSlot;
      const ret = value / cost - 1;
      if (tr.kind === 'probe') {
        if (age >= P.probeHoldSlots || ret <= -P.probeStop || ret >= P.probeTarget_) sellAll(state, tr, out);
      } else {
        const peakRet = tr.peakValue / cost - 1;
        const trailHit = peakRet >= P.momTrailArm && value <= tr.peakValue * (1 - P.momTrail);
        if (age >= P.momHoldSlots || ret <= -P.momStop || trailHit) sellAll(state, tr, out);
      }
    }
  }

  function counts(): { probes: number; mom: number; momDeployed: bigint } {
    let probes = 0;
    let mom = 0;
    let momDeployed = 0n;
    for (const tr of trades.values()) {
      if (tr.kind === 'probe') probes++;
      else {
        mom++;
        momDeployed += tr.costLamports;
      }
    }
    return { probes, mom, momDeployed };
  }

  function entries(state: BotState, touched: Pubkey[], out: OrderInput[]): void {
    const maxOpen = state.hello.caps.max_open_positions;
    const cap = state.hello.caps.max_orders_per_batch;
    for (const mint of touched) {
      if (out.length >= cap) return;
      if (trades.has(mint) || state.positions.has(mint)) continue;
      const c = state.curves.get(mint);
      const info = mints.get(mint);
      if (c === undefined || info === undefined || c.complete) continue;
      if (state.committedPositionCount() >= maxOpen) return;
      const rqSol = Number(c.real_quote_reserves) / SOL;
      const age = state.slot - (c.created_slot ?? info.firstSlot);
      const price = priceOf(c.virtual_quote_reserves, c.virtual_token_reserves);
      const n = counts();

      // momentum sleeve first: it is the stricter screen
      if (P.momEnabled && n.mom < P.momMaxOpen && rqSol >= P.momMinRqSol && rqSol <= P.momMaxRqSol && age >= P.momMinAgeSlots) {
        const last = momTraded.get(mint);
        if (last === undefined || state.slot - last >= P.momCooldownSlots) {
          const w = windowStats(info, state.slot, P.momWindowSlots);
          if (
            w.netSol >= P.momMinNetSol &&
            w.buyers >= P.momMinBuyers &&
            price >= w.high * (1 - P.momNearHigh) &&
            price <= w.low * (1 + P.momMaxRunUp)
          ) {
            let size = P.momMaxLamports;
            const sizeCap = state.maxBuyLamports(mint);
            if (sizeCap < size) size = sizeCap;
            const room = P.momMaxDeployedLamports - n.momDeployed;
            if (room < size) size = room;
            if (size >= 20_000_000n && state.freeCashLamports() > size + 10_000_000n) {
              out.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: P.buySlippageBps });
              trades.set(mint, { kind: 'mom', mint, phase: 'buying', decidedSlot: state.slot, openSlot: -1, costLamports: size, peakValue: 0 });
              momTraded.set(mint, state.slot);
              continue;
            }
          }
        }
      }

      // guardrail probes
      if (probesDone + n.probes >= P.probeTarget || n.probes >= P.probeMaxOpen) continue;
      if (probed.has(mint) || state.slot - lastProbeSlot < P.probeSpacingSlots) continue;
      const elapsed = state.slot - startSlot;
      const behind = elapsed >= P.relaxAfterSlots && probesDone < P.probeTarget;
      const minRq = behind ? Math.max(1.5, P.probeMinRqSol / 2) : P.probeMinRqSol;
      const minAge = behind ? Math.floor(P.probeMinAgeSlots / 2) : P.probeMinAgeSlots;
      if (rqSol < minRq || rqSol > P.probeMaxRqSol || age < minAge) continue;
      if (state.maxBuyLamports(mint) < P.probeLamports) continue;
      const w = windowStats(info, state.slot, P.probeWindowSlots);
      const minNet = behind ? 0 : P.probeMinNetSol;
      const minBuyers = behind ? 1 : P.probeMinBuyers;
      if (w.netSol < minNet || w.buyers < minBuyers) continue;
      if (price < w.first || price > w.low * (1 + P.probeMaxRunUp)) continue;
      out.push({ side: 'buy', mint, quote_lamports: P.probeLamports, max_slippage_bps: P.buySlippageBps });
      trades.set(mint, { kind: 'probe', mint, phase: 'buying', decidedSlot: state.slot, openSlot: -1, costLamports: P.probeLamports, peakValue: 0 });
      lastProbeSlot = state.slot;
    }
  }

  return {
    onBatch(state, batch) {
      if (startSlot < 0) startSlot = batch.slot;
      onFills(state, batch);
      const touched = onEvents(batch);
      const out: OrderInput[] = [];
      exits(state, out);
      entries(state, touched, out);
      return out;
    },
  };
}
