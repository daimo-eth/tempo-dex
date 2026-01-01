import type { Address } from "viem";

export const ROOT_TOKEN: Address = "0x20c0000000000000000000000000000000000000";

// Token decimals (all Tempo stablecoins use 6)
export const TOKEN_DECIMALS = 6;

// Tempo DEX address
export const DEX_ADDRESS: Address =
  "0xdec0000000000000000000000000000000000000";

// DEX ABI (subset for swap functions)
export const DEX_ABI = [
  {
    name: "swapExactAmountIn",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { type: "address", name: "tokenIn" },
      { type: "address", name: "tokenOut" },
      { type: "uint128", name: "amountIn" },
      { type: "uint128", name: "minAmountOut" },
    ],
    outputs: [{ type: "uint128", name: "amountOut" }],
  },
  {
    name: "quoteSwapExactAmountIn",
    type: "function",
    stateMutability: "view",
    inputs: [
      { type: "address", name: "tokenIn" },
      { type: "address", name: "tokenOut" },
      { type: "uint128", name: "amountIn" },
    ],
    outputs: [{ type: "uint128", name: "amountOut" }],
  },
] as const;
