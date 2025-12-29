// Centralized data fetching for Tempo DEX
// All queries use a consistent block number for data coherence
import type { Address } from "viem";
import { createPublicClient, formatUnits, http, keccak256, encodePacked } from "viem";
import { DEX_ABI, DEX_ADDRESS, ROOT_TOKEN, TOKEN_DECIMALS, tokenMeta } from "./config";
import type { Quote } from "./types";
import { tempoTestnet } from "./wagmi";

// -----------------------------------------------------------------------------
// Client (single instance)
// -----------------------------------------------------------------------------

const client = createPublicClient({
  chain: tempoTestnet,
  transport: http(),
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

  const lca = pathB.find((node) => pathASet.has(node)) ?? ROOT_TOKEN;
  const idxA = pathA.indexOf(lca);
  const idxB = pathB.indexOf(lca);

  const upPath = pathA.slice(0, idxA + 1);
  const downPath = pathB.slice(0, idxB).reverse();

  return [...upPath, ...downPath];
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
      const tokenIn = path[i];
      const tokenOut = path[i + 1];

      const hopAmount = await client.readContract({
        address: DEX_ADDRESS,
        abi: DEX_ABI,
        functionName: "quoteSwapExactAmountIn",
        args: [tokenIn, tokenOut, currentAmount],
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
  bidLiquidity: bigint;  // Total bid liquidity at this tick
  askLiquidity: bigint;  // Total ask liquidity at this tick
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

const ORDERBOOK_ABI = [
  {
    name: "books",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "bytes32", name: "pairKey" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { type: "address", name: "base" },
          { type: "address", name: "quote" },
          { type: "int16", name: "bestBidTick" },
          { type: "int16", name: "bestAskTick" },
        ],
      },
    ],
  },
  {
    name: "getTickLevel",
    type: "function",
    stateMutability: "view",
    inputs: [
      { type: "address", name: "base" },
      { type: "int16", name: "tick" },
      { type: "bool", name: "isBid" },
    ],
    outputs: [
      { type: "uint128", name: "head" },
      { type: "uint128", name: "tail" },
      { type: "uint128", name: "totalLiquidity" },
    ],
  },
  {
    name: "tickToPrice",
    type: "function",
    stateMutability: "pure",
    inputs: [{ type: "int16", name: "tick" }],
    outputs: [{ type: "uint32", name: "price" }],
  },
  {
    name: "PRICE_SCALE",
    type: "function",
    stateMutability: "pure",
    inputs: [],
    outputs: [{ type: "uint32" }],
  },
  {
    name: "MIN_TICK",
    type: "function",
    stateMutability: "pure",
    inputs: [],
    outputs: [{ type: "int16" }],
  },
  {
    name: "MAX_TICK",
    type: "function",
    stateMutability: "pure",
    inputs: [],
    outputs: [{ type: "int16" }],
  },
  {
    name: "TICK_SPACING",
    type: "function",
    stateMutability: "pure",
    inputs: [],
    outputs: [{ type: "int16" }],
  },
] as const;

function computePairKey(childToken: Address): `0x${string}` {
  const parent = tokenMeta[childToken]?.parent;
  if (!parent) throw new Error("token has no parent");
  return keccak256(encodePacked(["address", "address"], [childToken, parent]));
}

/** Fetch orderbook liquidity for a child/parent pair at a specific block */
export async function fetchPairLiquidity(
  childToken: Address,
  blockNumber: bigint
): Promise<PairLiquidity | { error: string }> {
  const parent = tokenMeta[childToken]?.parent;
  if (!parent) {
    return { error: "token has no parent" };
  }

  try {
    const pairKey = computePairKey(childToken);

    const [book, priceScale, minTick, maxTick, tickSpacing] = await Promise.all([
      client.readContract({
        address: DEX_ADDRESS,
        abi: ORDERBOOK_ABI,
        functionName: "books",
        args: [pairKey],
        blockNumber,
      }),
      client.readContract({
        address: DEX_ADDRESS,
        abi: ORDERBOOK_ABI,
        functionName: "PRICE_SCALE",
      }),
      client.readContract({
        address: DEX_ADDRESS,
        abi: ORDERBOOK_ABI,
        functionName: "MIN_TICK",
      }),
      client.readContract({
        address: DEX_ADDRESS,
        abi: ORDERBOOK_ABI,
        functionName: "MAX_TICK",
      }),
      client.readContract({
        address: DEX_ADDRESS,
        abi: ORDERBOOK_ABI,
        functionName: "TICK_SPACING",
      }),
    ]);

    const bestBidTick = book.bestBidTick;
    const bestAskTick = book.bestAskTick;
    const hasBid = bestBidTick > minTick;
    const hasAsk = bestAskTick < maxTick;

    if (!hasBid && !hasAsk) {
      return { error: "no liquidity" };
    }

    const scale = Number(priceScale);
    const spacing = Number(tickSpacing);

    // Determine the range of ticks to display
    // From highest ask tick down to lowest bid tick
    const highTick = hasAsk ? bestAskTick : bestBidTick;
    const lowTick = hasBid ? bestBidTick : bestAskTick;

    // Generate all ticks in the range (highest to lowest)
    const ticks: number[] = [];
    for (let t = highTick; t >= lowTick; t -= spacing) {
      ticks.push(t);
    }

    // Fetch both bid and ask liquidity at each tick in parallel
    const tickPromises = ticks.map(async (tick) => {
      const [priceRaw, bidLevel, askLevel] = await Promise.all([
        client.readContract({
          address: DEX_ADDRESS,
          abi: ORDERBOOK_ABI,
          functionName: "tickToPrice",
          args: [tick as unknown as number],
        }),
        client.readContract({
          address: DEX_ADDRESS,
          abi: ORDERBOOK_ABI,
          functionName: "getTickLevel",
          args: [childToken, tick as unknown as number, true], // isBid = true
          blockNumber,
        }),
        client.readContract({
          address: DEX_ADDRESS,
          abi: ORDERBOOK_ABI,
          functionName: "getTickLevel",
          args: [childToken, tick as unknown as number, false], // isBid = false
          blockNumber,
        }),
      ]);
      return {
        tick,
        price: Number(priceRaw) / scale,
        bidLiquidity: bidLevel[2],
        askLiquidity: askLevel[2],
      };
    });

    const tickResults = await Promise.all(tickPromises);

    // Filter: endpoints must have nonzero liquidity on their respective side
    // Find first tick with any liquidity (ask at top, or bid if no asks)
    let startIdx = 0;
    while (
      startIdx < tickResults.length &&
      tickResults[startIdx].askLiquidity === 0n &&
      tickResults[startIdx].bidLiquidity === 0n
    ) {
      startIdx++;
    }
    // Find last tick with any liquidity (bid at bottom, or ask if no bids)
    let endIdx = tickResults.length - 1;
    while (
      endIdx >= startIdx &&
      tickResults[endIdx].bidLiquidity === 0n &&
      tickResults[endIdx].askLiquidity === 0n
    ) {
      endIdx--;
    }

    // If no valid range, return error
    if (startIdx > endIdx) {
      return { error: "no liquidity" };
    }

    // Slice to valid range
    const tickRows: TickRow[] = tickResults.slice(startIdx, endIdx + 1);

    // Compute prices and spread
    const askPrice = tickRows.length > 0 ? tickRows[0].price : 0;
    const bidPrice = tickRows.length > 0 ? tickRows[tickRows.length - 1].price : 0;

    let midPrice: number;
    if (tickRows.length > 1) {
      midPrice = (bidPrice + askPrice) / 2;
    } else {
      midPrice = tickRows[0]?.price ?? 0;
    }

    let spreadBps = 0;
    if (tickRows.length > 1 && midPrice > 0) {
      spreadBps = ((askPrice - bidPrice) / midPrice) * 10000;
    }

    // Calculate total liquidity
    let totalBidUsd = 0;
    let totalAskUsd = 0;
    for (const row of tickRows) {
      totalBidUsd += (Number(row.bidLiquidity) / 10 ** TOKEN_DECIMALS) * row.price;
      totalAskUsd += Number(row.askLiquidity) / 10 ** TOKEN_DECIMALS;
    }

    return {
      childToken,
      parentToken: parent,
      bestBidTick,
      bestAskTick,
      midPrice,
      spreadBps,
      totalLiquidityUsd: totalBidUsd + totalAskUsd,
      tickRows,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return { error: message };
  }
}

// -----------------------------------------------------------------------------
// History (re-exported from indexSupply.ts)
// -----------------------------------------------------------------------------

export {
  fetchSwapHistory,
  formatSwapSummary,
  type SwapSummary,
} from "./indexSupply";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Get all non-root tokens (tokens that have pairs) */
export function getNonRootTokens(): Address[] {
  return Object.keys(tokenMeta).filter(
    (addr) => addr !== ROOT_TOKEN && tokenMeta[addr as Address]?.parent
  ) as Address[];
}

