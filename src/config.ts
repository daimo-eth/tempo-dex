import { type Address, defineChain, getAddress } from "viem";

// -----------------------------------------------------------------------------
// Chain configuration - moderato testnet
// -----------------------------------------------------------------------------

export const tempoModerato = defineChain({
  id: 42431,
  name: "Tempo Moderato Testnet",
  nativeCurrency: {
    name: "USD",
    symbol: "USD",
    decimals: 6,
  },
  rpcUrls: {
    default: {
      http: ["https://rpc.moderato.tempo.xyz"],
      webSocket: ["wss://rpc.moderato.tempo.xyz"],
    },
  },
  blockExplorers: {
    default: {
      name: "Tempo Explorer",
      url: "https://explore.moderato.tempo.xyz",
    },
  },
  testnet: true,
});

// Explorer URL export for convenience
export const EXPLORER_URL = tempoModerato.blockExplorers.default.url;

// Badge text for header display
export const NETWORK_BADGE = "moderato testnet";

// Faucet URL for users with no balance
export const FAUCET_URL = "https://docs.tempo.xyz/quickstart/faucet";

// -----------------------------------------------------------------------------
// Token configuration
// -----------------------------------------------------------------------------

export const ROOT_TOKEN = getAddress(
  "0x20c0000000000000000000000000000000000000"
);

// Token decimals (all Tempo stablecoins use 6)
export const TOKEN_DECIMALS = 6;

// Tempo DEX address
export const DEX_ADDRESS = getAddress(
  "0xdec0000000000000000000000000000000000000"
);

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
