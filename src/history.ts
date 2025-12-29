// History fetching for Tempo DEX
import type { Address } from "viem";
import { createPublicClient, http, parseAbiItem, formatUnits } from "viem";
import { DEX_ADDRESS, TOKEN_DECIMALS, tokenMeta } from "./config";
import { tempoTestnet } from "./wagmi";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface FillEvent {
  txHash: string;
  blockNumber: bigint;
  orderId: bigint;
  maker: Address;
  taker: Address;
  amountFilled: bigint;
  partialFill: boolean;
}

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
// Client
// -----------------------------------------------------------------------------

const client = createPublicClient({
  chain: tempoTestnet,
  transport: http(),
});

// OrderFilled event signature
const ORDER_FILLED_EVENT = parseAbiItem(
  "event OrderFilled(uint128 indexed orderId, address indexed maker, address indexed taker, uint128 amountFilled, bool partialFill)"
);

// ERC20 Transfer event signature
const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)"
);

// -----------------------------------------------------------------------------
// Fetch functions
// -----------------------------------------------------------------------------

/** Fetch OrderFilled events where taker = address */
async function fetchFillEvents(
  address: Address,
  fromBlock: bigint
): Promise<FillEvent[]> {
  console.log("[history] fetching fill events for", address, "from block", fromBlock.toString());

  const logs = await client.getLogs({
    address: DEX_ADDRESS,
    event: ORDER_FILLED_EVENT,
    args: { taker: address },
    fromBlock,
    toBlock: "latest",
  });

  console.log("[history] got", logs.length, "fill events");

  return logs.map((log) => ({
    txHash: log.transactionHash,
    blockNumber: log.blockNumber,
    orderId: log.args.orderId!,
    maker: log.args.maker! as Address,
    taker: log.args.taker! as Address,
    amountFilled: log.args.amountFilled!,
    partialFill: log.args.partialFill!,
  }));
}

/** Fetch Transfer events for a transaction to determine net token flows */
async function fetchTransfersForTx(
  txHash: string,
  address: Address
): Promise<{ token: Address; amount: bigint; direction: "in" | "out" }[]> {
  const receipt = await client.getTransactionReceipt({
    hash: txHash as `0x${string}`,
  });

  const transfers: { token: Address; amount: bigint; direction: "in" | "out" }[] = [];

  for (const log of receipt.logs) {
    // Check if it's a Transfer event (topic[0] matches)
    if (
      log.topics[0] ===
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
    ) {
      const from = ("0x" + log.topics[1]!.slice(26)) as Address;
      const to = ("0x" + log.topics[2]!.slice(26)) as Address;
      const value = BigInt(log.data);
      const token = log.address as Address;

      // Only track transfers involving our address
      if (from.toLowerCase() === address.toLowerCase()) {
        transfers.push({ token, amount: value, direction: "out" });
      } else if (to.toLowerCase() === address.toLowerCase()) {
        transfers.push({ token, amount: value, direction: "in" });
      }
    }
  }

  return transfers;
}

// -----------------------------------------------------------------------------
// Rollup logic (pure function)
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// Main fetch function
// -----------------------------------------------------------------------------

/** Fetch swap history for an address */
export async function fetchSwapHistory(
  address: Address,
  maxSwaps = 20
): Promise<SwapSummary[]> {
  console.log("[history] fetchSwapHistory for", address);

  try {
    // Get current block
    const currentBlock = await client.getBlockNumber();
    // Look back ~100k blocks (roughly 2 days on Tempo)
    const fromBlock = currentBlock > 100000n ? currentBlock - 100000n : 0n;

    // Fetch fill events
    const fills = await fetchFillEvents(address, fromBlock);

    if (fills.length === 0) {
      console.log("[history] no fills found");
      return [];
    }

    // Group by txHash
    const txHashes = [...new Set(fills.map((f) => f.txHash))];
    console.log("[history] found", txHashes.length, "unique transactions");

    // Limit to most recent
    const recentTxHashes = txHashes.slice(-maxSwaps);

    // Fetch transfers for each tx and roll up
    const summaries: SwapSummary[] = [];

    for (const txHash of recentTxHashes) {
      const transfers = await fetchTransfersForTx(txHash, address);
      const { tokenIn, tokenOut, amountIn, amountOut } = rollupTransfers(transfers);

      // Get block number from fills
      const fill = fills.find((f) => f.txHash === txHash);
      const blockNumber = fill?.blockNumber ?? 0n;

      summaries.push({
        txHash,
        blockNumber,
        tokenIn,
        tokenOut,
        amountIn,
        amountOut,
      });
    }

    // Sort by block descending (newest first)
    summaries.sort((a, b) => Number(b.blockNumber - a.blockNumber));

    console.log("[history] returning", summaries.length, "swaps");
    return summaries;
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

