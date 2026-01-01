// Centralized data fetching for Tempo DEX
// All queries use a consistent block number for data coherence
import type { Address } from "viem";
import { createPublicClient, formatUnits, getAddress, http } from "viem";
import { tempoTestnet } from "viem/chains";
import { DEX_ABI, DEX_ADDRESS, ROOT_TOKEN, TOKEN_DECIMALS } from "./config";
import { getTokenState } from "./tokens";
import type { Quote } from "./types";

// Normalized root token address for consistent comparisons
const rootToken = getAddress(ROOT_TOKEN);

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

const ORDERBOOK_ABI = [
  {
    name: "pairKey",
    type: "function",
    stateMutability: "pure",
    inputs: [
      { type: "address", name: "base" },
      { type: "address", name: "quote" },
    ],
    outputs: [{ type: "bytes32" }],
  },
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
    const pairKey = await client.readContract({
      address: DEX_ADDRESS,
      abi: ORDERBOOK_ABI,
      functionName: "pairKey",
      args: [childToken, parent],
    });

    const [book, priceScale, tickSpacing] = await Promise.all([
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
        functionName: "TICK_SPACING",
      }),
    ]);

    const bestBidTick = book.bestBidTick;
    const bestAskTick = book.bestAskTick;

    const scale = Number(priceScale);
    const spacing = Number(tickSpacing);

    // When no liquidity exists, contract returns bestAskTick=bestBidTick=0,
    // so the loop produces a single tick at 0.
    const ticks: number[] = [];
    for (let t = bestAskTick; t >= bestBidTick; t -= spacing) {
      ticks.push(t);
    }

    // Fetch both bid and ask liquidity at each tick in parallel
    const tickPromises = ticks.map(async (tick) => {
      const [priceRaw, bidLevel, askLevel] = await Promise.all([
        client.readContract({
          address: DEX_ADDRESS,
          abi: ORDERBOOK_ABI,
          functionName: "tickToPrice",
          args: [tick],
        }),
        client.readContract({
          address: DEX_ADDRESS,
          abi: ORDERBOOK_ABI,
          functionName: "getTickLevel",
          args: [childToken, tick, true], // isBid = true
          blockNumber,
        }),
        client.readContract({
          address: DEX_ADDRESS,
          abi: ORDERBOOK_ABI,
          functionName: "getTickLevel",
          args: [childToken, tick, false], // isBid = false
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

    const tickRows = await Promise.all(tickPromises);
    console.log(`Loaded ticks for pair ${pairKey}`, tickRows);

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
// Helpers
// -----------------------------------------------------------------------------

/** Get all non-root tokens (tokens that have pairs) */
export function getNonRootTokens(): Address[] {
  const { tokens, tokenMeta } = getTokenState();
  return tokens.filter((addr) => addr !== rootToken && tokenMeta[addr]?.parent);
}
