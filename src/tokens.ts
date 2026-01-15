// TokenManager - loads tokens from public tokenlist and chain
import {
  type Address,
  createPublicClient,
  getAddress,
  http,
} from "viem";
import { tempoModerato } from "./config";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const TOKENLIST_URL =
  "https://tempoxyz.github.io/tempo-apps/42431/tokenlist.json";

const TIP20_ABI = [
  {
    name: "parent",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const;

// Fallback parent relationships for when parent() call fails
// These are manually set based on known token tree structure
const FALLBACK_PARENTS: Record<Address, Address> = {
  [getAddress("0x20C0000000000000000000000000000000000001")]: getAddress(
    "0x20C0000000000000000000000000000000000000"
  ), // AlphaUSD -> pathUSD
  [getAddress("0x20C0000000000000000000000000000000000002")]: getAddress(
    "0x20C0000000000000000000000000000000000000"
  ), // BetaUSD -> pathUSD
  [getAddress("0x20C0000000000000000000000000000000000003")]: getAddress(
    "0x20C0000000000000000000000000000000000001"
  ), // ThetaUSD -> AlphaUSD
};

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface TokenlistEntry {
  name: string;
  symbol: string;
  decimals: number;
  chainId: number;
  address: string;
  logoURI?: string;
}

interface TokenlistResponse {
  name: string;
  tokens: TokenlistEntry[];
}

export interface TokenMeta {
  address: Address;
  symbol: string;
  decimals: number;
  parent: Address | null;
  logoURI?: string;
}

export interface TokenManagerState {
  tokens: Address[];
  tokenMeta: Record<Address, TokenMeta>;
  loading: boolean;
  error: string | null;
}

// -----------------------------------------------------------------------------
// Client
// -----------------------------------------------------------------------------

const client = createPublicClient({
  chain: tempoModerato,
  transport: http(undefined, {
    retryCount: 5,
    retryDelay: 150, // exponential backoff: 150ms, 300ms, 600ms, 1200ms, 2400ms
    batch: true, // batch JSON-RPC calls
  }),
  batch: {
    multicall: false, // chain doesn't have Multicall3
  },
});

// -----------------------------------------------------------------------------
// State (singleton)
// -----------------------------------------------------------------------------

let state: TokenManagerState = {
  tokens: [],
  tokenMeta: {},
  loading: false,
  error: null,
};

let loadPromise: Promise<TokenManagerState> | null = null;

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/** Get current token state (may be empty if not loaded) */
export function getTokenState(): TokenManagerState {
  return state;
}

/** Load tokens from tokenlist + fetch parent relationships from chain */
export async function loadTokens(): Promise<TokenManagerState> {
  // Return existing promise if already loading
  if (loadPromise) return loadPromise;

  // Return cached state if already loaded
  if (state.tokens.length > 0 && !state.error) return state;

  loadPromise = doLoadTokens();
  return loadPromise;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

async function doLoadTokens(): Promise<TokenManagerState> {
  state = { ...state, loading: true, error: null };

  try {
    // Fetch tokenlist
    const res = await fetch(TOKENLIST_URL);
    if (!res.ok) {
      throw new Error(`failed to fetch tokenlist: ${res.status}`);
    }

    const data: TokenlistResponse = await res.json();
    const entries = data.tokens.filter((t) => t.chainId === tempoModerato.id);

    // Normalize addresses
    const tokens: Address[] = entries.map((t) => getAddress(t.address));

    // Build initial tokenMeta (without parent)
    const tokenMeta: Record<Address, TokenMeta> = {};
    for (const entry of entries) {
      const addr = getAddress(entry.address);
      tokenMeta[addr] = {
        address: addr,
        symbol: entry.symbol,
        decimals: entry.decimals,
        parent: null,
        logoURI: entry.logoURI,
      };
    }

    // Fetch parent for each token (batched via JSON-RPC batching in transport)
    await Promise.all(
      tokens.map(async (addr) => {
        try {
          const parentAddr = await client.readContract({
            address: addr,
            abi: TIP20_ABI,
            functionName: "parent",
          });
          // Zero address means no parent (root token)
          if (parentAddr !== "0x0000000000000000000000000000000000000000") {
            tokenMeta[addr].parent = getAddress(parentAddr);
          }
        } catch {
          // Try fallback parent relationship
          const fallback = FALLBACK_PARENTS[addr];
          if (fallback) {
            tokenMeta[addr].parent = getAddress(fallback);
          }
        }
      })
    );

    state = { tokens, tokenMeta, loading: false, error: null };
    loadPromise = null;
    return state;
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed to load tokens";
    state = { ...state, loading: false, error: message };
    loadPromise = null;
    return state;
  }
}

/** Lookup token by address (normalizes input) */
export function getToken(address: string): TokenMeta | undefined {
  try {
    const normalized = getAddress(address);
    return state.tokenMeta[normalized];
  } catch {
    return undefined;
  }
}

/** Get token symbol or shortened address as fallback */
export function getSymbol(address: string): string {
  const token = getToken(address);
  if (token) return token.symbol;
  // Fallback to shortened address
  if (address.length >= 10) {
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }
  return address;
}

