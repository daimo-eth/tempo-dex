// Tempo DEX - Main application
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { parseUnits, type Address } from "viem";
import { useAccount, WagmiProvider } from "wagmi";
import {
  AssetsBox,
  HistoryBox,
  SwapTreeBox,
  SwapBox,
  TabBar,
} from "./components";
import { TOKEN_DECIMALS } from "./config";
import { fetchBlockNumber, fetchQuote } from "./data";
import "./style.css";
import { getTokenState, loadTokens } from "./tokens";
import type { QuoteState } from "./types";
import { config } from "./wagmi";

// Debug: set to an address to override connected wallet (null in prod)
// const DEBUG_WALLET_ADDR: Address | null = "0xc60A0A0E8bBc32DAC2E03030989AD6BEe45A874D";
const DEBUG_WALLET_ADDR: Address | null = null;

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const queryClient = new QueryClient();

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
  const { address: connectedAddress, isConnected: walletConnected } =
    useAccount();

  // Debug override for testing
  const address = DEBUG_WALLET_ADDR ?? connectedAddress;
  const isConnected = DEBUG_WALLET_ADDR ? true : walletConnected;

  // Token loading state
  const [tokensReady, setTokensReady] = useState(false);

  // Tab state
  const [activeTab, setActiveTab] = useState<Tab>("dex");

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
        // Set defaults from first two tokens if available
        if (state.tokens.length >= 2) {
          setFromToken(state.tokens[1]); // First non-root token
          setToToken(state.tokens[2] ?? state.tokens[0]); // Second non-root or root
        }
        setTokensReady(true);
      }
    });
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
        <TabBar activeTab={activeTab} onTabChange={setActiveTab} />
        <div className="header-right">
          {blockNumber !== null && (
            <span className="block-number">#{blockNumber.toString()}</span>
          )}
          <span className="badge">testnet</span>
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
