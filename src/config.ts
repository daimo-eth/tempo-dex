import { getAddress } from "viem";
import { tempoModerato } from "viem/chains";
import { Abis, Addresses } from "viem/tempo";

export { tempoModerato };

// -----------------------------------------------------------------------------
// Chain configuration - moderato testnet
// -----------------------------------------------------------------------------

// Explorer URL export for convenience
export const EXPLORER_URL = tempoModerato.blockExplorers.default.url;

// Badge text for header display
export const NETWORK_BADGE = "moderato testnet";

// Faucet URL for users with no balance
export const FAUCET_URL = "https://docs.tempo.xyz/quickstart/faucet";

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
