// Tempo DEX - Main application

// BigInt can't be serialized by JSON.stringify (React 19 dev mode needs this)
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { getAddress, isAddress, parseUnits, type Address } from "viem";
import { useAccount, WagmiProvider } from "wagmi";
import { useChainHead, useDebouncedValue, useQuote } from "./chain";
import {
  AssetsBox,
  HistoryBox,
  SwapTreeBox,
  SwapBox,
  TabBar,
} from "./components";
import { NETWORK_BADGE, ROOT_TOKEN, TOKEN_DECIMALS } from "./config";
import { getNonRootTokens } from "./data";
import "./style.css";
import { loadTokens } from "./tokens";
import { config } from "./wagmi";

// Debug: set to an address to override connected wallet (null in prod)
// const DEBUG_WALLET_ADDR = getAddress("0xc60A0A0E8bBc32DAC2E03030989AD6BEe45A874D");
const DEBUG_WALLET_ADDR: Address | null = null;

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

// Window-focus refetches would fight the chain-head poll for no benefit
// (everything is keyed off the head, which already polls).
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
    },
  },
});

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
// Page - layout and form state. All chain reads come from `./chain` hooks.
// -----------------------------------------------------------------------------

function Page() {
  const { address: connectedAddress, isConnected: walletConnected } =
    useAccount();

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

  // Form state - tokens initialized after tokens load
  const [fromToken, setFromToken] = useState<Address | null>(null);
  const [toToken, setToToken] = useState<Address | null>(null);
  const [amount, setAmount] = useState("100");

  // Chain head — single source of truth, polled by the chain layer.
  const { data: blockNumber } = useChainHead();

  // Debounced quote — debounce the amount input, then key off the (debounced
  // amount, from, to, blockNumber) tuple via useQuote.
  const debouncedAmount = useDebouncedValue(amount, 300);
  const amountIn = useMemo(() => {
    const parsed = Number(debouncedAmount);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0n;
    try {
      return parseUnits(debouncedAmount, TOKEN_DECIMALS);
    } catch {
      return 0n;
    }
  }, [debouncedAmount]);
  const quote = useQuote(fromToken, toToken, amountIn);

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
          {blockNumber !== undefined && (
            <span className="block-number">#{blockNumber.toString()}</span>
          )}
          <span className="badge">{NETWORK_BADGE}</span>
        </div>
      </header>

      {activeTab === "dex" && (
        <>
          <SwapTreeBox fromToken={fromToken} toToken={toToken} quote={quote} />

          <SwapBox
            fromToken={fromToken}
            toToken={toToken}
            amount={amount}
            quote={quote}
            setFromToken={setFromToken}
            setToToken={setToToken}
            setAmount={setAmount}
          />

          {isConnected && address && <HistoryBox address={address} />}
        </>
      )}

      {activeTab === "assets" && (
        <AssetsBox
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
