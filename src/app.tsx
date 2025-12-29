// Tempo DEX - Main application
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { parseUnits, type Address } from "viem";
import { WagmiProvider, useAccount } from "wagmi";
import { AssetsBox } from "./AssetsBox";
import { AssetTreeBox } from "./AssetTreeBox";
import { TOKEN_DECIMALS } from "./config";
import { fetchBlockNumber, fetchQuote } from "./data";
import { HistoryBox } from "./HistoryBox";
import "./style.css";
import { SwapBox } from "./SwapBox";
import type { QuoteState } from "./types";
import { config } from "./wagmi";

// Debug: set to an address to override connected wallet (null in prod)
// const DEBUG_WALLET_ADDR: Address | null = "0xc60A0A0E8bBc32DAC2E03030989AD6BEe45A874D";
const DEBUG_WALLET_ADDR: Address | null = null;

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const queryClient = new QueryClient();

// Default tokens
const DEFAULT_FROM = "0x20c0000000000000000000000000000000000001" as Address; // AlphaUSD
const DEFAULT_TO = "0x20c0000000000000000000000000000000000002" as Address; // BetaUSD

type Tab = "dex" | "assets";

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
  const { address: connectedAddress, isConnected: walletConnected } = useAccount();

  // Debug override for testing
  const address = DEBUG_WALLET_ADDR ?? connectedAddress;
  const isConnected = DEBUG_WALLET_ADDR ? true : walletConnected;

  // Tab state
  const [activeTab, setActiveTab] = useState<Tab>("dex");

  // Block number - the single source of truth for data coherence
  const [blockNumber, setBlockNumber] = useState<bigint | null>(null);

  // Core state - minimal
  const [fromToken, setFromToken] = useState<Address>(DEFAULT_FROM);
  const [toToken, setToToken] = useState<Address>(DEFAULT_TO);
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

      // Skip if same params
      if (paramsKey === lastQuoteParamsRef.current && quote.data) {
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
    [quote.data]
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
    if (blockNumber !== null) {
      triggerQuote(fromToken, toToken, amount, blockNumber);
    }
  }, [blockNumber, fromToken, toToken, amount, triggerQuote]);

  // Input handlers that trigger quote
  const handleFromToken = useCallback(
    (addr: Address) => {
      setFromToken(addr);
    },
    []
  );

  const handleToToken = useCallback(
    (addr: Address) => {
      setToToken(addr);
    },
    []
  );

  const handleAmount = useCallback(
    (amountStr: string) => {
      setAmount(amountStr);
    },
    []
  );

  const handleSwapSuccess = useCallback(() => {
    // Refresh gets new block and triggers all data refetch
    refresh();
  }, [refresh]);

  return (
    <main className="page">
      <header className="header">
        <h1>TEMPO DEX</h1>
        <div className="header-right">
          {blockNumber !== null && (
            <span className="block-number">#{blockNumber.toString()}</span>
          )}
          <span className="badge">testnet</span>
        </div>
      </header>

      {activeTab === "dex" && (
        <>
          <AssetTreeBox fromToken={fromToken} toToken={toToken} quote={quote} />

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
        <AssetsBox blockNumber={blockNumber} />
      )}
    </main>
  );
}

// -----------------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------------

const root = createRoot(document.getElementById("app") as HTMLElement);
root.render(<App />);
