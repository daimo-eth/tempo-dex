// History fetching for Tempo DEX using Index Supply
import type { Address } from "viem";
import { formatUnits } from "viem";
import { TOKEN_DECIMALS, tokenMeta } from "./config";

// -----------------------------------------------------------------------------
// Types
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

interface IndexSupplyRow {
  tx_hash: string;
  block_num: string;
  address: string;
  from: string;
  to: string;
  value: string;
}

interface IndexSupplyResponse {
  cursor?: string;
  columns: { name: string; pgtype: string }[];
  rows: string[][];
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const INDEX_SUPPLY_API = "https://api.indexsupply.net/v2/query";
const TEMPO_CHAIN_ID = 42429;

// Transfer event signature for Index Supply
const TRANSFER_SIGNATURE = "Transfer(address indexed from, address indexed to, uint256 value)";

// -----------------------------------------------------------------------------
// Index Supply query
// -----------------------------------------------------------------------------

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
  console.log("[history] querying Index Supply");

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Index Supply error: ${res.status}`);
  }

  return res.json();
}

// -----------------------------------------------------------------------------
// Rollup logic (pure function)
// -----------------------------------------------------------------------------

interface TransferRow {
  txHash: string;
  blockNum: bigint;
  token: Address;
  from: Address;
  to: Address;
  value: bigint;
}

/** 
 * Roll up transfers into net token flows per transaction.
 * Returns tokenIn (net outflow) and tokenOut (net inflow).
 */
export function rollupTransfers(
  transfers: { token: Address; amount: bigint; direction: "in" | "out" }[]
): { tokenIn: Address | null; tokenOut: Address | null; amountIn: bigint; amountOut: bigint } {
  // Aggregate by token
  const netByToken = new Map<Address, bigint>();

  for (const t of transfers) {
    const current = netByToken.get(t.token) ?? 0n;
    if (t.direction === "in") {
      netByToken.set(t.token, current + t.amount);
    } else {
      netByToken.set(t.token, current - t.amount);
    }
  }

  // Find largest outflow (tokenIn) and largest inflow (tokenOut)
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

/** Group transfers by txHash and compute net flows */
export function groupTransfersByTx(
  transfers: TransferRow[],
  userAddress: Address
): SwapSummary[] {
  // Group by txHash
  const byTx = new Map<string, TransferRow[]>();
  for (const t of transfers) {
    const arr = byTx.get(t.txHash) ?? [];
    arr.push(t);
    byTx.set(t.txHash, arr);
  }

  const summaries: SwapSummary[] = [];

  for (const [txHash, txTransfers] of byTx) {
    // Convert to direction-based format
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

    // Only include if there's actual swap activity
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
// Main fetch function
// -----------------------------------------------------------------------------

/** Fetch swap history for an address using Index Supply */
export async function fetchSwapHistory(
  address: Address,
  maxSwaps = 20
): Promise<SwapSummary[]> {
  console.log("[history] fetchSwapHistory for", address);

  try {
    // Query transfers involving this address on Tempo Testnet
    // We query both directions: from and to the user
    const query = `
      SELECT tx_hash, block_num, address, "from", "to", value
      FROM transfer
      WHERE chain = ${TEMPO_CHAIN_ID}
        AND ("from" = ${address} OR "to" = ${address})
      ORDER BY block_num DESC
      LIMIT 500
    `;

    const results = await queryIndexSupply(query, [TRANSFER_SIGNATURE]);

    if (!results.length || !results[0].rows.length) {
      console.log("[history] no transfers found");
      return [];
    }

    const response = results[0];
    console.log("[history] got", response.rows.length, "transfer rows");

    // Parse rows into TransferRow objects
    const transfers: TransferRow[] = response.rows.map((row) => ({
      txHash: row[0],
      blockNum: BigInt(row[1]),
      token: row[2] as Address,
      from: row[3] as Address,
      to: row[4] as Address,
      value: BigInt(row[5]),
    }));

    // Group by tx and compute net flows
    const summaries = groupTransfersByTx(transfers, address);

    // Sort by block descending (newest first) and limit
    summaries.sort((a, b) => Number(b.blockNumber - a.blockNumber));
    const limited = summaries.slice(0, maxSwaps);

    console.log("[history] returning", limited.length, "swaps");
    return limited;
  } catch (err) {
    console.error("[history] error", err);
    return [];
  }
}

// -----------------------------------------------------------------------------
// Formatting helpers
// -----------------------------------------------------------------------------

export function formatSwapSummary(swap: SwapSummary): string {
  const inSymbol = swap.tokenIn ? tokenMeta[swap.tokenIn]?.symbol ?? "?" : "?";
  const outSymbol = swap.tokenOut ? tokenMeta[swap.tokenOut]?.symbol ?? "?" : "?";
  const inAmt = Number(formatUnits(swap.amountIn, TOKEN_DECIMALS)).toFixed(2);
  const outAmt = Number(formatUnits(swap.amountOut, TOKEN_DECIMALS)).toFixed(2);

  return `${inAmt} ${inSymbol} → ${outAmt} ${outSymbol}`;
}
