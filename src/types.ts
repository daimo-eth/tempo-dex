// Shared types for Tempo DEX
import type { Address } from "viem";

// Quote state - single object containing all quote data
export interface Quote {
  // Input parameters
  fromToken: Address;
  toToken: Address;
  amountIn: bigint;
  // Path through the tree
  path: Address[];
  // Amounts at each node (same length as path)
  amounts: bigint[];
  // Final output
  amountOut: bigint;
  rate: number;
  // Block at which quote was fetched
  block: bigint;
}

export interface QuoteState {
  loading: boolean;
  error: string | null;
  data: Quote | null;
}

// Swap route (local path calculation)
export interface SwapRoute {
  inputPath: Address[];
  outputPath: Address[];
  highlightNodes: Set<Address>;
  hops: number;
}
