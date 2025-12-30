// Index Supply API client
// Encapsulates all SQL queries to Index Supply for swap history

import type { Address } from "viem";
import { TOKEN_DECIMALS, tokenMeta } from "./config";

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const INDEX_SUPPLY_API = "https://api.indexsupply.net/v2/query";
const TEMPO_CHAIN_ID = 42429;

// API key injected at build time via esbuild --define
// Set INDEX_SUPPLY_API_KEY env var before building to enable authentication
declare const __INDEX_SUPPLY_API_KEY__: string;
console.log("Using Index Supply API key:", __INDEX_SUPPLY_API_KEY__);

/**
 * ERC-20 Transfer event signature for Index Supply queries.
 * Used to filter and decode transfer events from the blockchain.
 */
const TRANSFER_SIGNATURE =
  "Transfer(address indexed from, address indexed to, uint256 value)";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface IndexSupplyResponse {
  cursor?: string;
  columns: { name: string; pgtype: string }[];
  rows: string[][];
}

interface TransferRow {
  txHash: string;
  blockNum: bigint;
  token: Address;
  from: Address;
  to: Address;
  value: bigint;
}

/**
 * Summary of a swap transaction derived from transfer events.
 * Computed by analyzing the net token flow for a user in a transaction.
 */
export interface SwapSummary {
  txHash: string;
  blockNumber: bigint;
  timestamp?: number;
  tokenIn: Address | null;
  tokenOut: Address | null;
  amountIn: bigint;
  amountOut: bigint;
}

// -----------------------------------------------------------------------------
// Core query function
// -----------------------------------------------------------------------------

/**
 * Execute a SQL query against Index Supply API.
 * Supports optional API key authentication via INDEX_SUPPLY_API_KEY env var.
 *
 * @param query - SQL query string
 * @param signatures - Event signatures to filter by
 * @returns Array of query results
 */
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

  // Build headers with optional API key (injected at build time)
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (__INDEX_SUPPLY_API_KEY__) {
    headers["Authorization"] = `Bearer ${__INDEX_SUPPLY_API_KEY__}`;
  }

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`index supply error: ${res.status}`);
  }

  return res.json();
}

// -----------------------------------------------------------------------------
// Transfer processing helpers
// -----------------------------------------------------------------------------

/**
 * Roll up multiple transfers into net token flows.
 * Identifies the primary token in and token out for a swap.
 */
function rollupTransfers(
  transfers: { token: Address; amount: bigint; direction: "in" | "out" }[]
): {
  tokenIn: Address | null;
  tokenOut: Address | null;
  amountIn: bigint;
  amountOut: bigint;
} {
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

/**
 * Group transfer rows by transaction and compute swap summaries.
 * Each transaction with a net token in/out is considered a swap.
 */
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
    const directed = txTransfers
      .map((t) => {
        const fromLower = t.from.toLowerCase();
        const toLower = t.to.toLowerCase();
        const userLower = userAddress.toLowerCase();

        if (fromLower === userLower) {
          return { token: t.token, amount: t.value, direction: "out" as const };
        } else if (toLower === userLower) {
          return { token: t.token, amount: t.value, direction: "in" as const };
        }
        return null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    const { tokenIn, tokenOut, amountIn, amountOut } =
      rollupTransfers(directed);

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

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/**
 * Fetch swap history for an address from Index Supply.
 * Queries ERC-20 Transfer events and groups them by transaction to identify swaps.
 *
 * @param address - User wallet address
 * @param blockNumber - Maximum block number to query up to
 * @param maxSwaps - Maximum number of swaps to return (default 20)
 * @returns Array of swap summaries, sorted by block number descending
 */
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
    console.error("[indexSupply] fetchSwapHistory error", err);
    return [];
  }
}

/**
 * Format a swap summary as a human-readable string.
 *
 * @param swap - Swap summary to format
 * @returns Formatted string like "100.00 AlphaUSD → 99.90 BetaUSD"
 */
export function formatSwapSummary(swap: SwapSummary): string {
  const formatAmount = (amount: bigint) =>
    (Number(amount) / 10 ** TOKEN_DECIMALS).toFixed(2);

  const inSymbol = swap.tokenIn
    ? (tokenMeta[swap.tokenIn]?.symbol ?? "?")
    : "?";
  const outSymbol = swap.tokenOut
    ? (tokenMeta[swap.tokenOut]?.symbol ?? "?")
    : "?";
  const inAmt = formatAmount(swap.amountIn);
  const outAmt = formatAmount(swap.amountOut);

  return `${inAmt} ${inSymbol} → ${outAmt} ${outSymbol}`;
}
