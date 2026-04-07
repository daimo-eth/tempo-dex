// Centralized data fetching for Tempo DEX
// All queries use a consistent block number for data coherence
import type { Address } from "viem";
import { createPublicClient, formatUnits, http, parseAbiItem } from "viem";
import { Actions as TempoActions, Tick } from "viem/tempo";
import {
  BLOCK_TIME_MS,
  chain,
  RPC_FETCH_OPTIONS,
  RPC_URL,
  ROOT_TOKEN,
  TOKEN_DECIMALS,
} from "./config";
import { getTokenState } from "./tokens";
import type { Quote } from "./types";

// Normalized root token address for consistent comparisons
const rootToken = ROOT_TOKEN;

// -----------------------------------------------------------------------------
// Client (single instance)
// -----------------------------------------------------------------------------

const client = createPublicClient({
  chain,
  transport: http(RPC_URL, {
    retryCount: 5,
    retryDelay: 150, // exponential backoff: 150ms, 300ms, 600ms, 1200ms, 2400ms
    batch: true, // batch JSON-RPC calls
    fetchOptions: RPC_FETCH_OPTIONS,
  }),
  batch: {
    multicall: false, // chain doesn't have Multicall3
  },
});

// -----------------------------------------------------------------------------
// Block number
// -----------------------------------------------------------------------------

/** Fetch the latest block number */
export async function fetchBlockNumber(): Promise<bigint> {
  return client.getBlockNumber();
}

// -----------------------------------------------------------------------------
// Path calculation (pure)
// -----------------------------------------------------------------------------

function getPathToRoot(addr: Address): Address[] {
  const { tokenMeta } = getTokenState();
  const path: Address[] = [];
  let current: Address | null = addr;
  while (current) {
    path.push(current);
    current = tokenMeta[current]?.parent ?? null;
  }
  return path;
}

/** Get full path from fromToken to toToken through the tree */
export function getSwapPath(fromToken: Address, toToken: Address): Address[] {
  if (fromToken === toToken) return [fromToken];

  const pathA = getPathToRoot(fromToken);
  const pathB = getPathToRoot(toToken);
  const pathASet = new Set(pathA);

  const lca = pathB.find((node) => pathASet.has(node)) ?? rootToken;
  const idxA = pathA.indexOf(lca);
  const idxB = pathB.indexOf(lca);

  const upPath = pathA.slice(0, idxA + 1);
  const downPath = pathB.slice(0, idxB).reverse();

  return [...upPath, ...downPath];
}

// -----------------------------------------------------------------------------
// Gas reserve estimation (for the "MAX" button + insufficient-balance check)
// -----------------------------------------------------------------------------
//
// On Tempo, batched swaps pay gas in `feeToken: fromToken`, so the user
// needs `balance ≥ amountIn + gasCost`. To let the user spend their entire
// balance we estimate the gas cost up front and reserve it from the swap
// amount. Returns a bigint in the from-token's smallest unit, with a 1.5x
// buffer over the raw estimate to cover gas-price fluctuation between
// estimation and submission, approve overhead in the batched flow, and
// any simulation under-estimation.
//
// Note on the SDK: there is no Tempo-specific "estimate gas in feeToken"
// helper. The official pattern (per viem/tempo's docstrings) is to use
// `Actions.dex.sell.call({...})` to construct the call object and pass
// it to viem's standard `estimateContractGas`. The chain's formatters
// handle Tempo-specific tx fields. We then multiply by `maxFeePerGas`
// from `estimateFeesPerGas()`. Tempo's native currency is USD (6
// decimals); for the current 6-decimal stablecoin tokenlist this equals
// the fromToken cost 1:1, so no extra decimal/price scaling is needed.
// Non-6-decimal tokens would need that scale added.

/**
 * Estimate the gas cost of a swap, in fromToken units, with a 50% buffer.
 * Throws on simulation failure (e.g. zero-balance accounts) — callers
 * should fall back to a fixed reserve.
 */
export async function estimateGasReserve(
  fromToken: Address,
  toToken: Address,
  account: Address
): Promise<bigint> {
  // Construct the swap call via the official Tempo SDK helper. This
  // gives us the canonical ABI/typing for swapExactAmountIn without
  // duplicating the args here.
  const sellCall = TempoActions.dex.sell.call({
    tokenIn: fromToken,
    tokenOut: toToken,
    // Use a representative non-zero amountIn so the simulation doesn't
    // revert on a zero-value DEX call. The exact value barely affects
    // gas units.
    amountIn: 1_000_000n,
    minAmountOut: 0n,
  });

  const [gasUnits, fees] = await Promise.all([
    client.estimateContractGas({
      ...sellCall,
      account,
    }),
    client.estimateFeesPerGas(),
  ]);

  const rawCost = gasUnits * fees.maxFeePerGas;
  // 1.5x buffer
  return (rawCost * 3n) / 2n;
}

// -----------------------------------------------------------------------------
// Quote fetching
// -----------------------------------------------------------------------------

interface QuoteResult {
  quote: Quote;
}

interface QuoteError {
  error: string;
}

/** Fetch quote from Tempo DEX at a specific block */
export async function fetchQuote(
  fromToken: Address,
  toToken: Address,
  amountIn: bigint,
  blockNumber: bigint
): Promise<QuoteResult | QuoteError> {
  if (amountIn === 0n) {
    return { error: "amount must be > 0" };
  }

  if (fromToken === toToken) {
    return { error: "same token (no-op)" };
  }

  try {
    const path = getSwapPath(fromToken, toToken);
    const amounts: bigint[] = [amountIn];
    let currentAmount = amountIn;

    for (let i = 0; i < path.length - 1; i++) {
      const hopAmount = await TempoActions.dex.getSellQuote(client, {
        tokenIn: path[i],
        tokenOut: path[i + 1],
        amountIn: currentAmount,
        blockNumber,
      });
      amounts.push(hopAmount);
      currentAmount = hopAmount;
    }

    const amountOut = amounts[amounts.length - 1];
    const rate =
      Number(formatUnits(amountOut, TOKEN_DECIMALS)) /
      Number(formatUnits(amountIn, TOKEN_DECIMALS));

    return {
      quote: {
        fromToken,
        toToken,
        amountIn,
        path,
        amounts,
        amountOut,
        rate,
        block: blockNumber,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    if (message.includes("InsufficientLiquidity")) {
      return { error: "insufficient liquidity" };
    }
    return { error: message };
  }
}

// -----------------------------------------------------------------------------
// Orderbook / Pair liquidity
// -----------------------------------------------------------------------------

export interface TickRow {
  tick: number;
  price: number;
  bidLiquidity: bigint; // Total bid liquidity at this tick
  askLiquidity: bigint; // Total ask liquidity at this tick
}

export interface PairLiquidity {
  childToken: Address;
  parentToken: Address;
  bestBidTick: number;
  bestAskTick: number;
  midPrice: number;
  spreadBps: number;
  totalLiquidityUsd: number;
  tickRows: TickRow[]; // All ticks from highest (best ask) to lowest (best bid)
}

// -----------------------------------------------------------------------------
// Orderbook constants
// -----------------------------------------------------------------------------

// int16 sentinel values the contract uses for empty sides
const INT16_MAX = 32767;
const INT16_MIN = -32768;

// Always show this many ticks beyond each side of the spread
const DISP_MIN_TICKS = 4;

// Tempo DEX tick grid: 1 bp per tick, see ox/tempo Tick docs.
const TICK_SPACING = 10;

// Pure tick→price helper (no RPC). `Tick.toPrice` returns a string like
// "1.001"; we coerce to number for the rest of the orderbook math.
const tickPrice = (tick: number) => Number(Tick.toPrice(tick));

/** Fetch orderbook liquidity for a child/parent pair at a specific block */
export async function fetchPairLiquidity(
  childToken: Address,
  blockNumber: bigint
): Promise<PairLiquidity | { error: string }> {
  const { tokenMeta } = getTokenState();
  const parent = tokenMeta[childToken]?.parent;
  if (!parent) {
    return { error: "token has no parent" };
  }

  try {
    const book = await TempoActions.dex.getOrderbook(client, {
      base: childToken,
      quote: parent,
      blockNumber,
    });

    // Detect int16 sentinel values ("no liquidity on this side")
    const bidEmpty = book.bestBidTick <= INT16_MIN;
    const askEmpty = book.bestAskTick >= INT16_MAX;

    if (bidEmpty && askEmpty) {
      return computePairLiquidity(childToken, parent, []);
    }

    // Collapse sentinels to the live side
    const effectiveBid = bidEmpty ? book.bestAskTick : book.bestBidTick;
    const effectiveAsk = askEmpty ? book.bestBidTick : book.bestAskTick;

    // Window: DISP_MIN_TICKS beyond each side of the spread
    const pad = DISP_MIN_TICKS * TICK_SPACING;
    const minTick = Math.min(effectiveBid, effectiveAsk) - pad;
    const maxTick = Math.max(effectiveBid, effectiveAsk) + pad;
    const ticks: number[] = [];
    for (let t = minTick; t <= maxTick; t += TICK_SPACING) {
      ticks.push(t);
    }

    // Fetch bid + ask liquidity per tick in parallel. JSON-RPC batching
    // in the http transport collapses these into a single request.
    const tickRows = await Promise.all(
      ticks.map(async (tick) => {
        const [bidLevel, askLevel] = await Promise.all([
          TempoActions.dex.getTickLevel(client, {
            base: childToken,
            tick,
            isBid: true,
            blockNumber,
          }),
          TempoActions.dex.getTickLevel(client, {
            base: childToken,
            tick,
            isBid: false,
            blockNumber,
          }),
        ]);
        return {
          tick,
          price: tickPrice(tick),
          bidLiquidity: bidLevel.totalLiquidity,
          askLiquidity: askLevel.totalLiquidity,
        };
      })
    );

    return computePairLiquidity(childToken, parent, tickRows);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return { error: message };
  }
}

/**
 * Compute pair liquidity stats from tick rows (pure function).
 * Best bid = highest price with nonzero bid liquidity.
 * Best ask = lowest price with nonzero ask liquidity.
 */
export function computePairLiquidity(
  childToken: Address,
  parentToken: Address,
  tickRows: TickRow[]
): PairLiquidity {
  // Find best bid (highest price with bid liquidity)
  let bestBidPrice = 0;
  let bestBidTick = 0;
  for (const row of tickRows) {
    if (row.bidLiquidity > 0n && row.price > bestBidPrice) {
      bestBidPrice = row.price;
      bestBidTick = row.tick;
    }
  }

  // Find best ask (lowest price with ask liquidity)
  let bestAskPrice = Infinity;
  let bestAskTick = 0;
  for (const row of tickRows) {
    if (row.askLiquidity > 0n && row.price < bestAskPrice) {
      bestAskPrice = row.price;
      bestAskTick = row.tick;
    }
  }

  // Handle no liquidity cases
  if (bestBidPrice === 0 && bestAskPrice === Infinity) {
    bestAskPrice = 0;
  } else if (bestAskPrice === Infinity) {
    bestAskPrice = bestBidPrice;
  } else if (bestBidPrice === 0) {
    bestBidPrice = bestAskPrice;
  }

  // Mid price and spread
  const midPrice = (bestBidPrice + bestAskPrice) / 2;
  const spreadBps =
    midPrice > 0 ? ((bestAskPrice - bestBidPrice) / midPrice) * 10000 : 0;

  // Total liquidity in USD terms
  let totalBidUsd = 0;
  let totalAskUsd = 0;
  for (const row of tickRows) {
    totalBidUsd +=
      (Number(row.bidLiquidity) / 10 ** TOKEN_DECIMALS) * row.price;
    totalAskUsd += Number(row.askLiquidity) / 10 ** TOKEN_DECIMALS;
  }

  return {
    childToken,
    parentToken,
    bestBidTick,
    bestAskTick,
    midPrice,
    spreadBps,
    totalLiquidityUsd: totalBidUsd + totalAskUsd,
    tickRows,
  };
}

// -----------------------------------------------------------------------------
// Swap history (via eth_getLogs over the last 24h)
// -----------------------------------------------------------------------------
//
// Two parallel `eth_getLogs` calls — one with the user at the `from` topic,
// one at the `to` topic — pull every ERC-20 Transfer in the last 24h that
// involves the user. We then dedupe (a self-transfer would otherwise show
// twice), group by tx hash, classify each transfer as in/out, roll up the
// net flows, and emit a SwapSummary for any tx with both a tokenIn and a
// tokenOut.
//
// Replaces an earlier path through Index Supply's SQL API. Faster
// (~210ms vs ~336ms in benchmarks against an active address), no API
// key, no rate limits.

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)"
);

// 24h converted to blocks via the empirical Tempo block time. At
// ~491ms/block this is ~175,968 blocks; the constant lives in config.ts
// because the same correction is needed by the formatBlockAge display.
const HISTORY_WINDOW_BLOCKS = BigInt(
  Math.ceil((24 * 60 * 60 * 1000) / BLOCK_TIME_MS)
);

// rpc.presto.tempo.xyz caps eth_getLogs at 100,000 blocks per query
// (a 175K-block 24h window comes back with `query exceeds max block
// range 100000`). MAX_LOGS_RANGE is the max `toBlock - fromBlock`, so
// each chunk covers up to 100,000 blocks inclusive of both endpoints.
const MAX_LOGS_RANGE = 99_999n;

/**
 * Issue eth_getLogs split into ≤100K-block chunks in parallel, then
 * flatten the results. Used by fetchSwapHistory because the 24h window
 * exceeds the RPC's per-query block-range cap.
 */
async function getTransferLogsChunked(
  filter: { from?: Address; to?: Address },
  fromBlock: bigint,
  toBlock: bigint
) {
  const chunks: Promise<
    Awaited<ReturnType<typeof client.getLogs<typeof TRANSFER_EVENT>>>
  >[] = [];
  let cursor = fromBlock;
  while (cursor <= toBlock) {
    const end =
      cursor + MAX_LOGS_RANGE > toBlock ? toBlock : cursor + MAX_LOGS_RANGE;
    chunks.push(
      client.getLogs({
        event: TRANSFER_EVENT,
        args: filter,
        fromBlock: cursor,
        toBlock: end,
      })
    );
    cursor = end + 1n;
  }
  const results = await Promise.all(chunks);
  return results.flat();
}

export interface SwapSummary {
  txHash: string;
  blockNumber: bigint;
  tokenIn: Address | null;
  tokenOut: Address | null;
  amountIn: bigint;
  amountOut: bigint;
}

interface DirectedTransfer {
  token: Address;
  amount: bigint;
  direction: "in" | "out";
}

/**
 * Roll up multiple transfers within a single tx into net token flows.
 * Picks the largest negative net as `tokenIn` (what the user spent) and
 * the largest positive net as `tokenOut` (what they received). Multi-hop
 * routes through intermediate tokens cancel out and don't show up.
 */
function rollupTransfers(transfers: DirectedTransfer[]): {
  tokenIn: Address | null;
  tokenOut: Address | null;
  amountIn: bigint;
  amountOut: bigint;
} {
  const netByToken = new Map<Address, bigint>();
  for (const t of transfers) {
    const current = netByToken.get(t.token) ?? 0n;
    netByToken.set(t.token, current + (t.direction === "in" ? t.amount : -t.amount));
  }

  let tokenIn: Address | null = null;
  let tokenOut: Address | null = null;
  let amountIn = 0n;
  let amountOut = 0n;
  for (const [token, net] of netByToken) {
    if (net < 0n && -net > amountIn) {
      tokenIn = token;
      amountIn = -net;
    }
    if (net > 0n && net > amountOut) {
      tokenOut = token;
      amountOut = net;
    }
  }
  return { tokenIn, tokenOut, amountIn, amountOut };
}

/**
 * Fetch swap history for `address` over the last 24h via two parallel
 * `eth_getLogs` calls (user as sender + user as receiver). The result
 * is sorted by block number descending; there's no row cap beyond the
 * 24h window itself.
 *
 * @param address     User wallet address
 * @param blockNumber Current chain head (upper bound + window anchor)
 */
export async function fetchSwapHistory(
  address: Address,
  blockNumber: bigint
): Promise<SwapSummary[]> {
  const fromBlock =
    blockNumber > HISTORY_WINDOW_BLOCKS
      ? blockNumber - HISTORY_WINDOW_BLOCKS
      : 0n;

  const [sentLogs, receivedLogs] = await Promise.all([
    getTransferLogsChunked({ from: address }, fromBlock, blockNumber),
    getTransferLogsChunked({ to: address }, fromBlock, blockNumber),
  ]);

  // Dedupe by (txHash, logIndex). A transfer where the user is BOTH sender
  // and receiver (e.g. a self-transfer) would otherwise appear in both lists.
  const seen = new Set<string>();
  const merged: typeof sentLogs = [];
  for (const log of [...sentLogs, ...receivedLogs]) {
    const key = `${log.transactionHash}:${log.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(log);
  }

  // Group by tx hash so we can roll up the in/out flows per transaction.
  const byTx = new Map<string, typeof merged>();
  for (const log of merged) {
    if (!log.transactionHash) continue;
    const arr = byTx.get(log.transactionHash) ?? [];
    arr.push(log);
    byTx.set(log.transactionHash, arr);
  }

  const userLower = address.toLowerCase();
  const summaries: SwapSummary[] = [];
  for (const [txHash, txLogs] of byTx) {
    const directed: DirectedTransfer[] = [];
    for (const log of txLogs) {
      const from = log.args.from;
      const to = log.args.to;
      const value = log.args.value;
      if (value === undefined) continue;
      if (from?.toLowerCase() === userLower) {
        directed.push({ token: log.address, amount: value, direction: "out" });
      } else if (to?.toLowerCase() === userLower) {
        directed.push({ token: log.address, amount: value, direction: "in" });
      }
    }

    const { tokenIn, tokenOut, amountIn, amountOut } = rollupTransfers(directed);
    if (tokenIn && tokenOut && amountIn > 0n && amountOut > 0n) {
      summaries.push({
        txHash,
        blockNumber: txLogs[0].blockNumber ?? 0n,
        tokenIn,
        tokenOut,
        amountIn,
        amountOut,
      });
    }
  }

  // Most recent first. No row cap — the 24h window is the only filter.
  summaries.sort((a, b) => Number(b.blockNumber - a.blockNumber));
  return summaries;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Get all non-root tokens (tokens that have pairs) */
export function getNonRootTokens(): Address[] {
  const { tokens, tokenMeta } = getTokenState();
  return tokens.filter((addr) => addr !== rootToken && tokenMeta[addr]?.parent);
}
