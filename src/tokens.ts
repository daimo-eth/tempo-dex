// TokenManager - loads tokens from public tokenlist and chain
import {
  type Address,
  createPublicClient,
  getAddress,
  http,
} from "viem";
import { Abis } from "viem/tempo";
import { chain, RPC_FETCH_OPTIONS, RPC_URL, TOKENLIST_URL } from "./config";

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
  chain,
  transport: http(RPC_URL, {
    retryCount: 5,
    retryDelay: 150, // exponential backoff: 150ms, 300ms, 600ms, 1200ms, 2400ms
    batch: true, // batch JSON-RPC calls
    fetchOptions: RPC_FETCH_OPTIONS,
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
    const entries = data.tokens.filter((t) => t.chainId === chain.id);

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

    // Fetch quoteToken (parent) for each token via TIP-20 ABI
    await Promise.all(
      tokens.map(async (addr) => {
        try {
          const quoteToken = await client.readContract({
            address: addr,
            abi: Abis.tip20,
            functionName: "quoteToken",
          });
          // Zero address means no parent (root token)
          if (quoteToken !== "0x0000000000000000000000000000000000000000") {
            tokenMeta[addr].parent = getAddress(quoteToken);
          }
        } catch {
          // Root token or unsupported - no parent
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

