// Tempo DEX - Main application

// BigInt can't be serialized by JSON.stringify (React 19 dev mode needs this)
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { getAddress, isAddress, parseUnits, type Address } from "viem";
import { useAccount, useDisconnect, WagmiProvider } from "wagmi";
import {
  AssetsBox,
  HistoryBox,
  SwapTreeBox,
  SwapBox,
  TabBar,
} from "./components";
import { EXPLORER_URL, NETWORK_BADGE, ROOT_TOKEN, TOKEN_DECIMALS } from "./config";
import { fetchBlockNumber, fetchQuote } from "./data";
import "./style.css";
import { getTokenState, loadTokens } from "./tokens";
import { getNonRootTokens } from "./data";
import type { QuoteState } from "./types";
import { shortenAddress } from "./utils";
import { config } from "./wagmi";

// Debug: set to an address to override connected wallet (null in prod)
// const DEBUG_WALLET_ADDR = getAddress("0xc60A0A0E8bBc32DAC2E03030989AD6BEe45A874D");
const DEBUG_WALLET_ADDR: Address | null = null;

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const queryClient = new QueryClient();

type Tab = "dex" | "assets";

// -----------------------------------------------------------------------------
// Hash routing: #/ = dex, #/assets = assets, #/assets/0x... = assets + token
// -----------------------------------------------------------------------------

function parseHash(): { tab: Tab; asset: Address | null } {
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (hash.startsWith("assets")) {
    const addr = hash.split("/")[1];
    if (addr && isAddress(addr)) {
      return { tab: "assets", asset: getAddress(addr) };
    }
    return { tab: "assets", asset: null };
  }
  return { tab: "dex", asset: null };
}

function setHash(tab: Tab, asset: Address | null) {
  const hash =
    tab === "assets"
      ? asset
        ? `#/assets/${asset}`
        : "#/assets"
      : "#/";
  if (window.location.hash !== hash) {
    window.history.pushState(null, "", hash);
  }
}

// -----------------------------------------------------------------------------
// App wrapper
// -----------------------------------------------------------------------------

function App() {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <Page />
      </QueryClientProvider>
    </WagmiProvider>
  );
}

// -----------------------------------------------------------------------------
// Page - main state and quote logic
// -----------------------------------------------------------------------------

function Page() {
  const { address: connectedAddress, isConnected: walletConnected } =
    useAccount();
  const { disconnect } = useDisconnect();

  // Debug override for testing
  const address = DEBUG_WALLET_ADDR ?? connectedAddress;
  const isConnected = DEBUG_WALLET_ADDR ? true : walletConnected;

  // Token loading state
  const [tokensReady, setTokensReady] = useState(false);

  // Tab + selected asset from hash
  const initial = parseHash();
  const [activeTab, setActiveTab] = useState<Tab>(initial.tab);
  const [selectedAsset, setSelectedAsset] = useState<Address | null>(
    initial.asset
  );

  // Block number - the single source of truth for data coherence
  const [blockNumber, setBlockNumber] = useState<bigint | null>(null);

  // Core state - minimal (initialized after tokens load)
  const [fromToken, setFromToken] = useState<Address | null>(null);
  const [toToken, setToToken] = useState<Address | null>(null);
  const [amount, setAmount] = useState("100");

  // Quote state - single object
  const [quote, setQuote] = useState<QuoteState>({
    loading: false,
    error: null,
    data: null,
  });

  // Debounce ref for quote fetching
  const quoteTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastQuoteParamsRef = useRef<string>("");

  // -----------------------------------------------------------------------------
  // Load tokens on mount
  // -----------------------------------------------------------------------------

  useEffect(() => {
    loadTokens().then((state) => {
      if (!state.error && state.tokens.length > 0) {
        // Default pair: USDC.e → pathUSD
        const usdce = state.tokens.find(
          (addr) => state.tokenMeta[addr]?.symbol === "USDC.e"
        );
        if (usdce) {
          setFromToken(usdce);
          setToToken(ROOT_TOKEN);
        } else if (state.tokens.length >= 2) {
          setFromToken(state.tokens[1]);
          setToToken(state.tokens[0]);
        }
        setTokensReady(true);
      }
    });
  }, []);

  // -----------------------------------------------------------------------------
  // Hash routing
  // -----------------------------------------------------------------------------

  // Listen for back/forward navigation
  useEffect(() => {
    const onPopState = () => {
      const { tab, asset } = parseHash();
      setActiveTab(tab);
      if (asset) setSelectedAsset(asset);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Set default selected asset once tokens are ready (if not set by hash)
  useEffect(() => {
    if (tokensReady && !selectedAsset) {
      const nonRoot = getNonRootTokens();
      if (nonRoot.length > 0) setSelectedAsset(nonRoot[0]);
    }
  }, [tokensReady, selectedAsset]);

  // Tab change handler - sets state and hash
  const handleTabChange = useCallback(
    (tab: Tab) => {
      setActiveTab(tab);
      let asset = selectedAsset;
      if (tab === "assets" && !asset) {
        const nonRoot = getNonRootTokens();
        if (nonRoot.length > 0) {
          asset = nonRoot[0];
          setSelectedAsset(asset);
        }
      }
      setHash(tab, tab === "assets" ? asset : null);
    },
    [selectedAsset]
  );

  // Asset selection handler - sets state and hash
  const handleSelectAsset = useCallback((addr: Address) => {
    setSelectedAsset(addr);
    setHash("assets", addr);
  }, []);

  // -----------------------------------------------------------------------------
  // Refresh - the single path for updating data
  // -----------------------------------------------------------------------------

  const refresh = useCallback(async () => {
    const newBlock = await fetchBlockNumber();
    setBlockNumber(newBlock);
    return newBlock;
  }, []);

  // Initial block fetch + auto-refresh every 5s
  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  // -----------------------------------------------------------------------------
  // Quote fetching - uses block number
  // -----------------------------------------------------------------------------

  const doFetchQuote = useCallback(
    async (from: Address, to: Address, amountStr: string, block: bigint) => {
      const parsed = Number(amountStr);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        setQuote({ loading: false, error: null, data: null });
        return;
      }

      if (from === to) {
        setQuote({ loading: false, error: "same token (no-op)", data: null });
        return;
      }

      const amountIn = parseUnits(amountStr, TOKEN_DECIMALS);
      const paramsKey = `${from}-${to}-${amountIn.toString()}-${block.toString()}`;

      // Skip if same params (already fetched this exact quote)
      if (paramsKey === lastQuoteParamsRef.current) {
        return;
      }
      lastQuoteParamsRef.current = paramsKey;

      setQuote((prev) => ({ ...prev, loading: true, error: null }));

      const result = await fetchQuote(from, to, amountIn, block);

      if ("error" in result) {
        setQuote({ loading: false, error: result.error, data: null });
      } else {
        setQuote({ loading: false, error: null, data: result.quote });
      }
    },
    [] // No dependencies - uses refs for deduplication
  );

  // Debounced quote trigger - called when inputs change
  const triggerQuote = useCallback(
    (from: Address, to: Address, amountStr: string, block: bigint) => {
      if (quoteTimeoutRef.current) {
        clearTimeout(quoteTimeoutRef.current);
      }
      quoteTimeoutRef.current = setTimeout(() => {
        doFetchQuote(from, to, amountStr, block);
      }, 300);
    },
    [doFetchQuote]
  );

  // Re-fetch quote when block number changes
  useEffect(() => {
    if (blockNumber !== null && fromToken && toToken) {
      triggerQuote(fromToken, toToken, amount, blockNumber);
    }
  }, [blockNumber, fromToken, toToken, amount, triggerQuote]);

  // Input handlers that trigger quote
  const handleFromToken = useCallback((addr: Address) => {
    setFromToken(addr);
  }, []);

  const handleToToken = useCallback((addr: Address) => {
    setToToken(addr);
  }, []);

  const handleAmount = useCallback((amountStr: string) => {
    setAmount(amountStr);
  }, []);

  const handleSwapSuccess = useCallback(() => {
    // Refresh gets new block and triggers all data refetch
    refresh();
  }, [refresh]);

  // Show loading until tokens are ready
  if (!tokensReady || !fromToken || !toToken) {
    return (
      <main className="page">
        <header className="header">
          <h1>TEMPO</h1>
          <div className="header-right">
            <span className="badge">loading...</span>
          </div>
        </header>
      </main>
    );
  }

  return (
    <main className="page">
      <header className="header">
        <h1>TEMPO</h1>
        <TabBar activeTab={activeTab} onTabChange={handleTabChange} />
        <div className="header-right">
          {blockNumber !== null && (
            <span className="block-number">#{blockNumber.toString()}</span>
          )}
          <span className="badge">{NETWORK_BADGE}</span>
        </div>
      </header>

      {isConnected && address && (
        <div className="account-bar">
          <a
            className="btn-link"
            href={`${EXPLORER_URL}/address/${address}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {shortenAddress(address)}
          </a>
          <button className="btn-link" onClick={() => disconnect()}>
            disconnect
          </button>
        </div>
      )}

      {activeTab === "dex" && (
        <>
          <SwapTreeBox fromToken={fromToken} toToken={toToken} quote={quote} />

          <SwapBox
            fromToken={fromToken}
            toToken={toToken}
            amount={amount}
            quote={quote}
            setFromToken={handleFromToken}
            setToToken={handleToToken}
            setAmount={handleAmount}
            onSwapSuccess={handleSwapSuccess}
          />

          {isConnected && address && blockNumber !== null && (
            <HistoryBox address={address} blockNumber={blockNumber} />
          )}
        </>
      )}

      {activeTab === "assets" && blockNumber !== null && (
        <AssetsBox
          blockNumber={blockNumber}
          selectedToken={selectedAsset}
          onSelectToken={handleSelectAsset}
        />
      )}
    </main>
  );
}

// -----------------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------------

const root = createRoot(document.getElementById("app") as HTMLElement);
root.render(<App />);
