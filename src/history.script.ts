// Test script for history fetching
// Run with: npx tsx src/history.script.ts

import { getAddress } from "viem";
import { fetchBlockNumber, fetchSwapHistory, type SwapSummary } from "./data";
import { TOKEN_DECIMALS } from "./config";
import { getSymbol, loadTokens } from "./tokens";
import { formatTokenAmount } from "./utils";

const DEBUG_WALLET = getAddress("0xc60A0A0E8bBc32DAC2E03030989AD6BEe45A874D");

function formatSwapSummary(swap: SwapSummary): string {
  const inSymbol = swap.tokenIn ? getSymbol(swap.tokenIn) : "?";
  const outSymbol = swap.tokenOut ? getSymbol(swap.tokenOut) : "?";
  const inAmt = formatTokenAmount(swap.amountIn, TOKEN_DECIMALS, 2);
  const outAmt = formatTokenAmount(swap.amountOut, TOKEN_DECIMALS, 2);
  return `${inAmt} ${inSymbol} → ${outAmt} ${outSymbol}`;
}

async function main() {
  console.log("Fetching swap history for", DEBUG_WALLET);
  console.log("---");

  // Tokens needed for symbol lookup in formatSwapSummary
  await loadTokens();

  const blockNumber = await fetchBlockNumber();
  console.log("Current block:", blockNumber.toString());

  const swaps = await fetchSwapHistory(DEBUG_WALLET, blockNumber);

  if (swaps.length === 0) {
    console.log("No swaps found");
    return;
  }

  console.log(`Found ${swaps.length} swaps:\n`);

  for (const swap of swaps) {
    console.log(`Block ${swap.blockNumber}: ${formatSwapSummary(swap)}`);
    console.log(`  TX: ${swap.txHash}`);
    console.log("");
  }
}

main().catch(console.error);
