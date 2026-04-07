// SwapBox - swap form, wallet connection, and execution
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Address } from "viem";
import { formatUnits, parseUnits } from "viem";
import { useAccount, useConnect, useConnectors, useSwitchChain } from "wagmi";
import {
  useAllowance,
  useBalances,
  useSubmitSwap,
  type SwapParams,
} from "../chain";
import { chain, TOKEN_DECIMALS } from "../config";
import { getTokenState } from "../tokens";
import type { QuoteState } from "../types";
import { TEMPO_CONNECTOR_ID } from "../wagmi";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const REQUIRED_CHAIN_ID = chain.id;
const SLIPPAGE_TOLERANCE = 0.005; // 0.5%

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface SwapBoxProps {
  fromToken: Address;
  toToken: Address;
  amount: string;
  quote: QuoteState;
  setFromToken: (addr: Address) => void;
  setToToken: (addr: Address) => void;
  setAmount: (v: string) => void;
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export function SwapBox({
  fromToken,
  toToken,
  amount,
  quote,
  setFromToken,
  setToToken,
  setAmount,
}: SwapBoxProps) {
  // Get tokens from TokenManager
  const { tokens, tokenMeta } = getTokenState();

  // Ref for amount input (for re-focusing after swap)
  const amountInputRef = useRef<HTMLInputElement>(null);

  const {
    address,
    isConnected,
    chainId: walletChainId,
  } = useAccount();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const connectors = useConnectors();
  const { connect } = useConnect({
    mutation: {
      onMutate: ({ connector }) => {
        console.log("[connect] attempting", connector.name);
      },
      onSuccess: (data) => {
        console.log("[connect] success", data);
      },
      onError: (error, { connector }) => {
        console.error("[connect] error", connector.name, error);
      },
    },
  });

  // All transaction state (approve, swap, batched swap, pending flags,
  // success/error result, post-confirmation chain refresh) lives inside
  // useSubmitSwap.
  const submit = useSubmitSwap();

  const isWrongChain = isConnected && walletChainId !== REQUIRED_CHAIN_ID;
  const isNoOp = fromToken === toToken;

  // Clear any previous swap result when inputs change
  useEffect(() => {
    submit.reset();
  }, [fromToken, toToken, amount, submit]);

  // Parse amount
  const amountIn = useMemo(() => {
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0n;
    return parseUnits(amount, TOKEN_DECIMALS);
  }, [amount]);

  // Balances and allowance — both keyed on the chain head, so they cascade
  // automatically whenever the head ticks or is fast-forwarded after a swap.
  const { balances } = useBalances(address);
  const { data: allowance } = useAllowance(fromToken, address);

  const currentAllowance = (allowance as bigint) ?? 0n;
  const needsApproval = amountIn > 0n && currentAllowance < amountIn;

  // Quote info
  const amountOut = quote.data?.amountOut ?? 0n;
  const amountOutFormatted = Number(formatUnits(amountOut, TOKEN_DECIMALS));
  const rate = quote.data?.rate ?? 0;

  // Slippage
  const minAmountOut =
    amountOut > 0n
      ? (amountOut * BigInt(Math.floor((1 - SLIPPAGE_TOLERANCE) * 1000))) /
        1000n
      : 0n;

  // Build the SwapParams payload from current form/quote state. Captured at
  // call time so the success message reflects what was actually submitted.
  const buildSwapParams = useCallback((): SwapParams => {
    const inputFormatted = Number(formatUnits(amountIn, TOKEN_DECIMALS));
    return {
      fromToken,
      toToken,
      amountIn,
      minAmountOut,
      fromAmount: inputFormatted.toFixed(2),
      fromSymbol: tokenMeta[fromToken]?.symbol ?? "",
      toAmount: amountOutFormatted.toFixed(2),
      toSymbol: tokenMeta[toToken]?.symbol ?? "",
    };
  }, [
    fromToken,
    toToken,
    amountIn,
    minAmountOut,
    amountOutFormatted,
    tokenMeta,
  ]);

  const handleApprove = () => submit.approve(fromToken);
  const handleSwap = () => submit.swap(buildSwapParams());
  const handleBatchedSwap = () =>
    void submit.batchedSwap(buildSwapParams(), needsApproval);

  // Token lists for dropdowns
  const tokensByBalance = useMemo(() => {
    return Object.values(tokenMeta).sort((a, b) => {
      const balA = balances[a.address] ?? 0n;
      const balB = balances[b.address] ?? 0n;
      if (balB > balA) return 1;
      if (balB < balA) return -1;
      return a.symbol.localeCompare(b.symbol);
    });
  }, [balances, tokenMeta]);

  const tokensBySymbol = useMemo(() => {
    return Object.values(tokenMeta).sort((a, b) =>
      a.symbol.localeCompare(b.symbol)
    );
  }, [tokenMeta]);

  // Balance check
  const fromBalance = balances[fromToken] ?? 0n;
  const fromBalanceFormatted = Number(formatUnits(fromBalance, TOKEN_DECIMALS));
  const parsedAmount = Number(amount) || 0;
  const insufficientBalance =
    isConnected && parsedAmount > fromBalanceFormatted;

  // Check if user has no assets at all
  const hasNoAssets =
    isConnected &&
    tokens.every((addr) => (balances[addr] ?? 0n) === 0n);

  const formatBalance = (bal: bigint) => {
    const num = Number(formatUnits(bal, TOKEN_DECIMALS));
    if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + "M";
    if (num >= 1_000) return (num / 1_000).toFixed(1) + "K";
    if (num >= 1) return num.toFixed(2);
    return num.toFixed(4);
  };

  // The Tempo Wallet dialog connector is the only sign-in path we expose.
  const tempoConnector = useMemo(
    () => connectors.find((c) => c.id === TEMPO_CONNECTOR_ID),
    [connectors]
  );

  // Button state - allow actions if we have valid quote data, even during background refresh
  const hasValidQuote = quote.data && !quote.error;

  const canApprove =
    !isNoOp &&
    !insufficientBalance &&
    !submit.isApprovePending &&
    amountIn > 0n &&
    hasValidQuote;

  const canSwap =
    !isNoOp &&
    !insufficientBalance &&
    !submit.isSwapPending &&
    !needsApproval &&
    amountOut > 0n &&
    hasValidQuote;

  // Batched swap can proceed even if needsApproval (it will include approve in the batch)
  const canBatchedSwap =
    !isNoOp &&
    !insufficientBalance &&
    !submit.isBatchedPending &&
    amountOut > 0n &&
    hasValidQuote;

  // Determine why execution is blocked (null if can proceed)
  const execBlockedBecause = (() => {
    if (isNoOp) return "no-op";
    if (insufficientBalance) return "insufficient balance";
    if (quote.error) return "insufficient liquidity";
    if (quote.loading && !quote.data) return "loading...";
    if (parsedAmount <= 0) return "enter amount";
    return null;
  })();

  // Render action button(s)
  const renderActionButtons = () => {
    if (!isConnected) {
      return (
        <button
          className="btn-primary"
          disabled={!tempoConnector}
          onClick={() =>
            tempoConnector && connect({ connector: tempoConnector })
          }
        >
          CONNECT
        </button>
      );
    }

    if (isWrongChain) {
      return (
        <div className="action-section">
          <button
            className="btn-primary"
            disabled={isSwitching}
            onClick={() => switchChain({ chainId: REQUIRED_CHAIN_ID })}
          >
            {isSwitching ? "SWITCHING..." : "SWITCH CHAIN"}
          </button>
        </div>
      );
    }

    // Connected and on correct chain
    // Use batched flow if wallet supports it, otherwise traditional approve → swap
    if (submit.supportsBatchedCalls) {
      return (
        <div className="action-section">
          <button
            className="btn-primary"
            disabled={!canBatchedSwap || !!submit.result}
            onClick={handleBatchedSwap}
          >
            {submit.isBatchedPending ? "SWAPPING..." : "SWAP"}
          </button>
        </div>
      );
    }

    // Traditional approve → swap flow
    return (
      <div className="action-section">
        {needsApproval ? (
          <button
            className="btn-primary"
            disabled={!canApprove || !!submit.result}
            onClick={handleApprove}
          >
            {submit.isApprovePending ? "APPROVING..." : "APPROVE"}
          </button>
        ) : (
          <button
            className="btn-primary"
            disabled={!canSwap || !!submit.result}
            onClick={handleSwap}
          >
            {submit.isSwapPending ? "SWAPPING..." : "SWAP"}
          </button>
        )}
      </div>
    );
  };

  return (
    <section className="panel">
      <div className="panel-title">// swap</div>
      <div className="swap">
        <div className="row">
          <div className="field">
            <label htmlFor="fromToken">from</label>
            <select
              id="fromToken"
              value={fromToken}
              onChange={(e) => {
                const token = tokenMeta[e.target.value as Address];
                if (token) setFromToken(token.address);
              }}
            >
              {(isConnected ? tokensByBalance : tokensBySymbol).map((t) => (
                <option key={t.address} value={t.address}>
                  {t.symbol}
                  {isConnected
                    ? ` (${formatBalance(balances[t.address] ?? 0n)})`
                    : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="toToken">to</label>
            <select
              id="toToken"
              value={toToken}
              onChange={(e) => {
                const token = tokenMeta[e.target.value as Address];
                if (token) setToToken(token.address);
              }}
            >
              {tokensBySymbol.map((t) => (
                <option key={t.address} value={t.address}>
                  {t.symbol}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="row">
          <div className="field">
            <label htmlFor="amount">amount</label>
            <input
              ref={amountInputRef}
              id="amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="output">output</label>
            <input
              id="output"
              disabled
              value={
                quote.loading && !quote.data
                  ? ""
                  : quote.error
                    ? ""
                    : amountOut > 0n
                      ? amountOutFormatted.toFixed(2)
                      : ""
              }
            />
          </div>
        </div>

        {/* Status line + action button as a .field combo, so the
            label/control vertical rhythm matches the input/select fields
            above. The status line is always rendered ("ready" by default)
            so the panel never shifts. */}
        <div className="field">
          <div className="quote">
            {submit.result?.type === "error" ? (
              <div className="quote-row">
                <span className="error">{submit.result.message}</span>
                <button className="btn-link" onClick={submit.reset}>
                  continue
                </button>
              </div>
            ) : submit.result?.type === "success" ? (
              <div className="quote-row">
                <span className="success">
                  swapped {submit.result.fromAmount} {submit.result.fromSymbol} →{" "}
                  {submit.result.toAmount} {submit.result.toSymbol}
                </span>
                <button
                  className="btn-link"
                  onClick={() => {
                    submit.reset();
                    setAmount("");
                    amountInputRef.current?.focus();
                  }}
                >
                  continue
                </button>
              </div>
            ) : hasNoAssets ? (
              <div className="quote-row">
                <span>no assets</span>
                <a
                  className="btn-link"
                  href="https://wallet.tempo.xyz/"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  top up
                </a>
              </div>
            ) : (
              <div>{execBlockedBecause ?? "ready"}</div>
            )}
          </div>
          {renderActionButtons()}
        </div>
      </div>
    </section>
  );
}
