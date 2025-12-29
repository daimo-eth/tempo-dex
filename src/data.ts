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
// History (Index Supply)
// -----------------------------------------------------------------------------

export interface SwapSummary {
  txHash: string;
  blockNumber: bigint;
  timestamp?: number;
  tokenIn: Address | null;
  tokenOut: Address | null;
  amountIn: bigint;
  amountOut: bigint;
}

interface IndexSupplyResponse {
  cursor?: string;
  columns: { name: string; pgtype: string }[];
  rows: string[][];
}

const INDEX_SUPPLY_API = "https://api.indexsupply.net/v2/query";
const TEMPO_CHAIN_ID = 42429;
const TRANSFER_SIGNATURE = "Transfer(address indexed from, address indexed to, uint256 value)";

async function queryIndexSupply(
  query: string,
  signatures: string[]
): Promise<IndexSupplyResponse[]> {
  const params = new URLSearchParams();
  params.set("query", query);
  for (const sig of signatures) {
    params.append("signatures", sig);
  }

  const url = `${INDEX_SUPPLY_API}?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Index Supply error: ${res.status}`);
  }

  return res.json();
}

interface TransferRow {
  txHash: string;
  blockNum: bigint;
  token: Address;
  from: Address;
  to: Address;
  value: bigint;
}

function rollupTransfers(
  transfers: { token: Address; amount: bigint; direction: "in" | "out" }[]
): { tokenIn: Address | null; tokenOut: Address | null; amountIn: bigint; amountOut: bigint } {
  const netByToken = new Map<Address, bigint>();

  for (const t of transfers) {
    const current = netByToken.get(t.token) ?? 0n;
    if (t.direction === "in") {
      netByToken.set(t.token, current + t.amount);
    } else {
      netByToken.set(t.token, current - t.amount);
    }
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

function groupTransfersByTx(
  transfers: TransferRow[],
  userAddress: Address
): SwapSummary[] {
  const byTx = new Map<string, TransferRow[]>();
  for (const t of transfers) {
    const arr = byTx.get(t.txHash) ?? [];
    arr.push(t);
    byTx.set(t.txHash, arr);
  }

  const summaries: SwapSummary[] = [];

  for (const [txHash, txTransfers] of byTx) {
    const directed = txTransfers.map((t) => {
      const fromLower = t.from.toLowerCase();
      const toLower = t.to.toLowerCase();
      const userLower = userAddress.toLowerCase();

      if (fromLower === userLower) {
        return { token: t.token, amount: t.value, direction: "out" as const };
      } else if (toLower === userLower) {
        return { token: t.token, amount: t.value, direction: "in" as const };
      }
      return null;
    }).filter((x): x is NonNullable<typeof x> => x !== null);

    const { tokenIn, tokenOut, amountIn, amountOut } = rollupTransfers(directed);

    if (tokenIn && tokenOut && amountIn > 0n && amountOut > 0n) {
      const blockNumber = txTransfers[0]?.blockNum ?? 0n;
      summaries.push({
        txHash,
        blockNumber,
        tokenIn,
        tokenOut,
        amountIn,
        amountOut,
      });
    }
  }

  return summaries;
}

/** Fetch swap history for an address. Uses block number to limit query range. */
export async function fetchSwapHistory(
  address: Address,
  blockNumber: bigint,
  maxSwaps = 20
): Promise<SwapSummary[]> {
  try {
    // Query transfers up to the current block
    const query = `
      SELECT tx_hash, block_num, address, "from", "to", value
      FROM transfer
      WHERE chain = ${TEMPO_CHAIN_ID}
        AND ("from" = ${address} OR "to" = ${address})
        AND block_num <= ${blockNumber}
      ORDER BY block_num DESC
      LIMIT 500
    `;

    const results = await queryIndexSupply(query, [TRANSFER_SIGNATURE]);

    if (!results.length || !results[0].rows.length) {
      return [];
    }

    const response = results[0];
    const transfers: TransferRow[] = response.rows.map((row) => ({
      txHash: row[0],
      blockNum: BigInt(row[1]),
      token: row[2] as Address,
      from: row[3] as Address,
      to: row[4] as Address,
      value: BigInt(row[5]),
    }));

    const summaries = groupTransfersByTx(transfers, address);
    summaries.sort((a, b) => Number(b.blockNumber - a.blockNumber));
    return summaries.slice(0, maxSwaps);
  } catch (err) {
    console.error("[data] fetchSwapHistory error", err);
    return [];
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Get all non-root tokens (tokens that have pairs) */
export function getNonRootTokens(): Address[] {
  return Object.keys(tokenMeta).filter(
    (addr) => addr !== ROOT_TOKEN && tokenMeta[addr as Address]?.parent
  ) as Address[];
}

export function formatSwapSummary(swap: SwapSummary): string {
  const inSymbol = swap.tokenIn ? tokenMeta[swap.tokenIn]?.symbol ?? "?" : "?";
  const outSymbol = swap.tokenOut ? tokenMeta[swap.tokenOut]?.symbol ?? "?" : "?";
  const inAmt = Number(formatUnits(swap.amountIn, TOKEN_DECIMALS)).toFixed(2);
  const outAmt = Number(formatUnits(swap.amountOut, TOKEN_DECIMALS)).toFixed(2);

  return `${inAmt} ${inSymbol} → ${outAmt} ${outSymbol}`;
}

