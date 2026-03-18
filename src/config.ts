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
// Browsers reject fetch() with credentials in URLs, so extract basic auth
function parseRpcUrl(raw: string): {
  url: string;
  fetchOptions?: { headers: Record<string, string> };
} {
  try {
    const parsed = new URL(raw);
    if (parsed.username) {
      const auth = btoa(`${parsed.username}:${parsed.password}`);
      parsed.username = "";
      parsed.password = "";
      return {
        url: parsed.toString(),
        fetchOptions: { headers: { Authorization: `Basic ${auth}` } },
      };
    }
  } catch {}
  return { url: raw };
}

const rpcRaw =
  typeof __TEMPO_RPC_URL__ !== "undefined" && __TEMPO_RPC_URL__
    ? __TEMPO_RPC_URL__
    : chain.rpcUrls.default.http[0];

const rpc = parseRpcUrl(rpcRaw);
export const RPC_URL = rpc.url;
export const RPC_FETCH_OPTIONS = rpc.fetchOptions;

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
