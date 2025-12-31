// Test script for history fetching
// Run with: npx tsx src/history.script.ts

import type { Address } from "viem";
import { fetchBlockNumber } from "./data";
import { fetchSwapHistory, formatSwapSummary } from "./indexSupply";

const DEBUG_WALLET: Address = "0xc60A0A0E8bBc32DAC2E03030989AD6BEe45A874D";

async function main() {
  console.log("Fetching swap history for", DEBUG_WALLET);
  console.log("---");

  const blockNumber = await fetchBlockNumber();
  console.log("Current block:", blockNumber.toString());

  const swaps = await fetchSwapHistory(DEBUG_WALLET, blockNumber, 10);

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
