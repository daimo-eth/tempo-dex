import { type Chain, getAddress } from "viem";
import { tempo, tempoModerato } from "viem/chains";
import { Abis, Addresses } from "viem/tempo";

// -----------------------------------------------------------------------------
// Build-time configuration (injected via esbuild --define)
// -----------------------------------------------------------------------------

declare const __TEMPO_NETWORK__: string | undefined;
declare const __TEMPO_RPC_URL__: string | undefined;

const network =
  typeof __TEMPO_NETWORK__ !== "undefined" && __TEMPO_NETWORK__
    ? __TEMPO_NETWORK__
    : "mainnet";

// -----------------------------------------------------------------------------
// Chain configuration
// -----------------------------------------------------------------------------

export const chain: Chain =
  network === "moderato" ? tempoModerato : tempo;

// RPC URL - use env override or chain default
export const RPC_URL =
  typeof __TEMPO_RPC_URL__ !== "undefined" && __TEMPO_RPC_URL__
    ? __TEMPO_RPC_URL__
    : chain.rpcUrls.default.http[0];

// Explorer URL
export const EXPLORER_URL = chain.blockExplorers!.default.url;

// Badge text for header display
export const NETWORK_BADGE = network === "moderato" ? "moderato testnet" : "mainnet";

// Faucet URL for users with no balance (testnet only)
export const FAUCET_URL = "https://docs.tempo.xyz/quickstart/faucet";

// Tokenlist URL (chain-specific)
export const TOKENLIST_URL = `https://tempoxyz.github.io/tempo-apps/${chain.id}/tokenlist.json`;

// -----------------------------------------------------------------------------
// Token configuration (from viem/tempo)
// -----------------------------------------------------------------------------

// Root token (pathUSD) - canonical address from viem/tempo
export const ROOT_TOKEN = getAddress(Addresses.pathUsd);

// Token decimals (all Tempo stablecoins use 6)
export const TOKEN_DECIMALS = 6;

// -----------------------------------------------------------------------------
// DEX configuration (from viem/tempo)
// -----------------------------------------------------------------------------

// Tempo DEX address - canonical address from viem/tempo
export const DEX_ADDRESS = getAddress(Addresses.stablecoinDex);

// DEX ABI - full ABI from viem/tempo
export const DEX_ABI = Abis.stablecoinDex;
