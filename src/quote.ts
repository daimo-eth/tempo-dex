// Quote fetching logic for Tempo DEX
import type { Address } from "viem";
import { createPublicClient, formatUnits, http } from "viem";
import { Actions } from "viem/tempo";
import { ROOT_TOKEN, TOKEN_DECIMALS, tokenMeta } from "./config";
import type { Quote } from "./types";
import { tempoTestnet } from "./wagmi";

// -----------------------------------------------------------------------------
// Client
// -----------------------------------------------------------------------------

const client = createPublicClient({
  chain: tempoTestnet,
  transport: http(),
});

// -----------------------------------------------------------------------------
// Path calculation
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

  // Find lowest common ancestor
  const lca = pathB.find((node) => pathASet.has(node)) ?? ROOT_TOKEN;
  const idxA = pathA.indexOf(lca);
  const idxB = pathB.indexOf(lca);

  // Build full path: fromToken -> ... -> LCA -> ... -> toToken
  const upPath = pathA.slice(0, idxA + 1); // from input up to LCA (inclusive)
  const downPath = pathB.slice(0, idxB).reverse(); // from LCA+1 down to output

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
  amountIn: bigint
): Promise<QuoteResult | QuoteError> {
  console.log("[quote] fetchQuote called", {
    fromToken,
    toToken,
    amountIn: amountIn.toString(),
  });

  if (amountIn === 0n) {
    return { error: "amount must be > 0" };
  }

  if (fromToken === toToken) {
    return { error: "same token (no-op)" };
  }

  try {
    // Get current block
    const block = await client.getBlockNumber();
    console.log("[quote] current block:", block);

    // Get the full path
    const path = getSwapPath(fromToken, toToken);
    console.log(
      "[quote] path:",
      path.map((a) => tokenMeta[a]?.symbol ?? a)
    );

    // Quote each hop along the path
    const amounts: bigint[] = [amountIn];
    let currentAmount = amountIn;

    for (let i = 0; i < path.length - 1; i++) {
      const tokenIn = path[i];
      const tokenOut = path[i + 1];

      console.log(
        "[quote] quoting hop",
        i,
        tokenMeta[tokenIn]?.symbol,
        "->",
        tokenMeta[tokenOut]?.symbol
      );

      // Use viem/tempo Actions to simulate the quote
      const quoteCall = Actions.dex.getSellQuote.call({
        tokenIn,
        tokenOut,
        amountIn: currentAmount,
      });

      const result = await client.call({
        ...quoteCall,
        blockNumber: block,
      });

      if (!result.data) {
        return { error: `no quote data for hop ${i}` };
      }

      // Decode the result (uint256)
      const hopAmount = BigInt(result.data);
      amounts.push(hopAmount);
      currentAmount = hopAmount;

      console.log("[quote] hop", i, "result:", hopAmount.toString());
    }

    const amountOut = amounts[amounts.length - 1];
    const rate =
      Number(formatUnits(amountOut, TOKEN_DECIMALS)) /
      Number(formatUnits(amountIn, TOKEN_DECIMALS));

    console.log("[quote] complete", { amountOut: amountOut.toString(), rate });

    return {
      quote: {
        fromToken,
        toToken,
        amountIn,
        path,
        amounts,
        amountOut,
        rate,
        block,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[quote] error", err);

    if (message.includes("InsufficientLiquidity")) {
      return { error: "insufficient liquidity" };
    }
    return { error: message };
  }
}
