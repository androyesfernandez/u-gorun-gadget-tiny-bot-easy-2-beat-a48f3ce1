// Tiny dip-buy bot for "Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana".
//
// Idea: meme coins on Solana overreact downwards and snap back. The bot waits
// for a sharp dip off the recent high, confirms the fall is fresh and already
// turning up, buys a fixed slice of equity, and gets out on the first of four
// exits: the price reclaiming the old high, a trailing stop once the trade has
// run, a 24-bar time stop, or a hard stop. Everything is integer math on bar
// closes, so two runs produce byte-identical action logs.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const BPS = 10000n;
const DIP_BPS = 150n; // dip off the 24-bar trailing high that arms a buy
const FORMATION_BPS = 25n; // fall over the last 3 bars that proves the dip is fresh
const LOOKBACK_BARS = 24; // trailing-high window, and the time stop, in bars
const SIZE_PCT = 20n; // each buy spends this share of equity
const MAX_SLIPPAGE_BPS = 100;
const RECOVERY_BPS = 25n; // exit once the close reclaims within this of the entry-time high
const TRAIL_ARM_BPS = 300n; // peak must rise this far over entry before the trail goes live
const TRAIL_BPS = 150n; // fall from the peak that triggers the trailing exit
const HARD_STOP_BPS = 500n; // hard stop below the entry close

// A buy we decided on but whose fill has not come back yet. Entry state is
// only created from a confirmed fill, never from the decision itself.
interface PendingBuy {
  symbol: string;
  decisionSeq: number;
  entryClose: bigint; // close on the decision bar
  trailingHighAtEntry: bigint;
  dipBps: bigint;
}

// Live state for a filled position: everything the exits need to know.
interface LiveEntry {
  entryBar: number; // decided_bar of the buy that filled
  entryClose: bigint;
  trailingHighAtEntry: bigint;
  dipBps: bigint;
  peak: bigint; // highest close seen since the fill
}

// One close per batch per symbol, in decision-bar order (null before a first bar).
const closes = new Map<string, (bigint | null)[]>();
// Buys awaiting their fill, keyed by client_id.
const pending = new Map<string, PendingBuy>();
// Confirmed positions, keyed by symbol.
const live = new Map<string, LiveEntry>();
// Dip of each symbol's previous filled buy; a re-entry must dip at least as deep.
const lastEntryDip = new Map<string, bigint>();

// Highest close over the last LOOKBACK_BARS bars, current bar included.
function trailingHigh(symbol: string): bigint | null {
  const history = closes.get(symbol) ?? [];
  let high: bigint | null = null;
  for (const c of history.slice(-LOOKBACK_BARS)) {
    if (c !== null && (high === null || c > high)) high = c;
  }
  return high;
}

// True when any of the four exits fires for a live entry at this close.
// The peak is refreshed here too, so the trailing stop always measures from
// the highest close seen since the fill.
function exitHit(entry: LiveEntry, close: bigint, seq: number): boolean {
  if (close > entry.peak) entry.peak = close;
  // Recovery: the close reclaims within 25 bps of the entry-time high.
  if (close * BPS >= entry.trailingHighAtEntry * (BPS - RECOVERY_BPS)) return true;
  // Trailing stop: live only once the peak is 300 bps over entry, then a
  // 150 bps fall from the peak ends the trade.
  const armed = entry.peak >= (entry.entryClose * (BPS + TRAIL_ARM_BPS)) / BPS;
  if (armed && close * BPS <= entry.peak * (BPS - TRAIL_BPS)) return true;
  // Time stop: out after 24 bars no matter what.
  if (seq - entry.entryBar >= LOOKBACK_BARS) return true;
  // Hard stop: 500 bps under the entry close.
  if (close <= (entry.entryClose * (BPS - HARD_STOP_BPS)) / BPS) return true;
  return false;
}

async function onBatch(state: BarsState, batch: Batch): Promise<OrderInput[]> {
  // 1. Record this batch's closes first, warm-up bars included, so the
  // history is complete by the time trading opens.
  for (const s of state.hello.symbols) {
    const history = closes.get(s.symbol) ?? [];
    history.push(state.close(s.symbol));
    closes.set(s.symbol, history);
  }

  // 2. Settle last bar's decisions from the fills. A filled buy opens live
  // entry state; a filled sell closes it; a rejected order just drops its
  // pending record and changes nothing.
  for (const f of batch.fills) {
    if (f.side === 'buy') {
      const p = pending.get(f.client_id);
      pending.delete(f.client_id);
      if (f.status === 'filled' && p !== undefined) {
        live.set(p.symbol, {
          entryBar: f.decided_bar,
          entryClose: p.entryClose,
          trailingHighAtEntry: p.trailingHighAtEntry,
          dipBps: p.dipBps,
          peak: p.entryClose,
        });
        lastEntryDip.set(p.symbol, p.dipBps);
      }
    } else if (f.status === 'filled') {
      live.delete(f.symbol);
    }
  }

  const orders: OrderInput[] = [];

  // 3. Exits first, in universe order. One full-position sell per symbol per
  // bar at most, whichever of the four exits fires first.
  for (const s of state.hello.symbols) {
    const symbol = s.symbol;
    const position = state.positions.get(symbol);
    const entry = live.get(symbol);
    const close = state.close(symbol);
    if (position === undefined || position.qty <= 0n || entry === undefined || close === null) continue;
    if (exitHit(entry, close, state.seq)) {
      orders.push({
        side: 'sell',
        symbol,
        qty: position.qty,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
        client_id: `s-${symbol}-${state.seq}`,
      });
    }
  }

  // 4. Buys, in universe order, sized only from cash still on hand (a sell
  // decided in this same reply never funds a buy).
  if (!state.warmingUp) {
    let cashLeft = state.cash;
    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
    for (const s of state.hello.symbols) {
      const symbol = s.symbol;
      const close = state.close(symbol);
      if (close === null) continue;
      if (state.positions.has(symbol)) continue;
      const history = closes.get(symbol) ?? [];
      if (history.length < LOOKBACK_BARS) continue;
      if (history.slice(-LOOKBACK_BARS).some((c) => c === null)) continue;
      const high = trailingHigh(symbol);
      if (high === null) continue;
      const prev = history[history.length - 2];
      const threeAgo = history[history.length - 4];
      if (prev === null || threeAgo === null) continue;
      const dipBps = ((high - close) * BPS) / high;
      // Dip of at least 150 bps off the 24-bar high.
      if (close * BPS > high * (BPS - DIP_BPS)) continue;
      // Fast formation: fell at least 25 bps over the last 3 bars.
      if (close * BPS > threeAgo * (BPS - FORMATION_BPS)) continue;
      // Uptick: already turning back up.
      if (close <= prev) continue;
      // Re-entry must dip at least as deep as the symbol's previous entry.
      const lastDip = lastEntryDip.get(symbol);
      if (lastDip !== undefined && dipBps < lastDip) continue;
      let notional = (state.equity * SIZE_PCT) / 100n;
      const room = state.weightRoom(symbol);
      if (notional > room) notional = room;
      if (notional > cashLeft) notional = cashLeft;
      if (notional < minNotional) continue;
      cashLeft -= notional;
      const clientId = `b-${symbol}-${state.seq}`;
      pending.set(clientId, {
        symbol,
        decisionSeq: state.seq,
        entryClose: close,
        trailingHighAtEntry: high,
        dipBps,
      });
      orders.push({
        side: 'buy',
        symbol,
        notional_quote_units: notional,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
        client_id: clientId,
      });
    }
  }

  return orders;
}

await runBars({ onBatch });
