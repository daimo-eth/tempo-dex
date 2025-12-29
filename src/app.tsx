// Tempo DEX - Main application
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { parseUnits, type Address } from "viem";
import { WagmiProvider, useAccount } from "wagmi";
import { AssetTreeBox } from "./AssetTreeBox";
import { HistoryBox } from "./HistoryBox";
import { SwapBox } from "./SwapBox";
import { TOKEN_DECIMALS } from "./config";
import { fetchQuote } from "./quote";
import "./style.css";
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

  // Core state - minimal
  const [fromToken, setFromToken] = useState<Address>(DEFAULT_FROM);
  const [toToken, setToToken] = useState<Address>(DEFAULT_TO);
  const [amount, setAmount] = useState("100");
  const [swapCount, setSwapCount] = useState(0);

  // Quote state - single object
  const [quote, setQuote] = useState<QuoteState>({
    loading: false,
    error: null,
    data: null,
  });

  // Debounce ref for quote fetching
  const quoteTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastQuoteParamsRef = useRef<string>("");

  // Quote fetcher - clean async function, no hooks
  const doFetchQuote = useCallback(
    async (from: Address, to: Address, amountStr: string) => {
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
      const paramsKey = `${from}-${to}-${amountIn.toString()}`;

      // Skip if same params
      if (paramsKey === lastQuoteParamsRef.current && quote.data) {
        return;
      }
      lastQuoteParamsRef.current = paramsKey;

      setQuote((prev) => ({ ...prev, loading: true, error: null }));

      const result = await fetchQuote(from, to, amountIn);

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
    (from: Address, to: Address, amountStr: string) => {
      if (quoteTimeoutRef.current) {
        clearTimeout(quoteTimeoutRef.current);
      }
      quoteTimeoutRef.current = setTimeout(() => {
        doFetchQuote(from, to, amountStr);
      }, 300);
    },
    [doFetchQuote]
  );

  // Input handlers that trigger quote
  const handleFromToken = useCallback(
    (addr: Address) => {
      setFromToken(addr);
      triggerQuote(addr, toToken, amount);
    },
    [toToken, amount, triggerQuote]
  );

  const handleToToken = useCallback(
    (addr: Address) => {
      setToToken(addr);
      triggerQuote(fromToken, addr, amount);
    },
    [fromToken, amount, triggerQuote]
  );

  const handleAmount = useCallback(
    (amountStr: string) => {
      setAmount(amountStr);
      triggerQuote(fromToken, toToken, amountStr);
    },
    [fromToken, toToken, triggerQuote]
  );

  // Initial quote on mount
  React.useEffect(() => {
    triggerQuote(fromToken, toToken, amount);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSwapSuccess = useCallback(() => {
    setSwapCount((c) => c + 1);
    // Refetch quote after swap
    triggerQuote(fromToken, toToken, amount);
  }, [fromToken, toToken, amount, triggerQuote]);

  return (
    <main className="page">
      <header className="header">
        <h1>TEMPO DEX</h1>
        <span className="badge">testnet</span>
      </header>

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

      {isConnected && address && (
        <HistoryBox address={address} refreshKey={swapCount} />
      )}
    </main>
  );
}

// -----------------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------------

const root = createRoot(document.getElementById("app") as HTMLElement);
root.render(<App />);
