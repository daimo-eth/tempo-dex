// SwapBox - swap form, wallet connection, and execution
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Address } from "viem";
import { formatUnits, parseUnits } from "viem";
import { useAccount, useConnect, useConnectors, useSwitchChain } from "wagmi";
import {
  useBalances,
  useMaxSwappable,
  useSubmitSwap,
  type SwapParams,
} from "../chain";
import { chain, TOKEN_DECIMALS } from "../config";
import { getTokenState } from "../tokens";
import type { QuoteState } from "../types";
import { formatTokenAmount } from "../utils";

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

  // All transaction state (pending, success/error result, post-confirmation
  // chain refresh) lives inside useSubmitSwap.
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

  // Balances — keyed on the chain head, cascade-refetched when the head
  // ticks or is fast-forwarded after a swap.
  const { balances } = useBalances(address);

  // Quote info
  const amountOut = quote.data?.amountOut ?? 0n;

  // Per-token decimal lookups (with TOKEN_DECIMALS as the fallback for
  // tokens that aren't in the loaded tokenlist) — used by every display
  // formatter in this component.
  const fromDecimals = tokenMeta[fromToken]?.decimals ?? TOKEN_DECIMALS;
  const toDecimals = tokenMeta[toToken]?.decimals ?? TOKEN_DECIMALS;

  // Slippage
  const minAmountOut =
    amountOut > 0n
      ? (amountOut * BigInt(Math.floor((1 - SLIPPAGE_TOLERANCE) * 1000))) /
        1000n
      : 0n;

  // Build the SwapParams payload from current form/quote state. Captured at
  // call time so the success message reflects what was actually submitted.
  const buildSwapParams = useCallback(
    (): SwapParams => ({
      fromToken,
      toToken,
      amountIn,
      minAmountOut,
      fromAmount: formatTokenAmount(amountIn, fromDecimals),
      fromSymbol: tokenMeta[fromToken]?.symbol ?? "",
      toAmount: formatTokenAmount(amountOut, toDecimals),
      toSymbol: tokenMeta[toToken]?.symbol ?? "",
    }),
    [
      fromToken,
      toToken,
      amountIn,
      amountOut,
      minAmountOut,
      fromDecimals,
      toDecimals,
      tokenMeta,
    ]
  );

  const handleSwap = () => void submit.submit(buildSwapParams());

  // Initial autofocus + select-all so the user can start typing a new
  // amount the moment the page is interactive. The default value is
  // already populated, so select() highlights it for instant replacement.
  useEffect(() => {
    amountInputRef.current?.focus();
    amountInputRef.current?.select();
  }, []);

  // After a successful swap: clear the input immediately so the form is
  // ready for the next entry, then hold the green "SUCCESS" button state
  // for 1 second before resetting the result + restoring focus + select.
  // After the result resets the status line falls through to "enter
  // amount" and the button reverts to its grey-disabled "SWAP" default.
  useEffect(() => {
    if (submit.result?.type !== "success") return;
    setAmount("");
    const t = setTimeout(() => {
      submit.reset();
      amountInputRef.current?.focus();
      amountInputRef.current?.select();
    }, 1000);
    return () => clearTimeout(t);
  }, [submit.result, submit.reset, setAmount]);

  // Button state. `swapBusy` covers both pending and success and triggers
  // the .is-busy CSS override so the button stays green while disabled.
  // Otherwise the standard :disabled grey styling applies.
  const swapSuccess = submit.result?.type === "success";
  const swapBusy = submit.isPending || swapSuccess;
  const swapLabel = submit.isPending
    ? "SWAPPING..."
    : swapSuccess
      ? "SUCCESS"
      : "SWAP";

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

  // Balance check. `maxSwappable = balance - estimatedGasReserve`, so the
  // user can't enter an amount that would leave no headroom for gas. Both
  // the MAX button and this check read the same value.
  const fromBalance = balances[fromToken] ?? 0n;
  const { maxSwappable } = useMaxSwappable(
    fromToken,
    toToken,
    address,
    fromBalance
  );
  const insufficientBalance = isConnected && amountIn > maxSwappable;

  // Check if user has no assets at all
  const hasNoAssets =
    isConnected &&
    tokens.every((addr) => (balances[addr] ?? 0n) === 0n);


  // Only one connector is wired in this app (the Tempo Wallet dialog).
  const tempoConnector = connectors[0];

  // Allow actions if we have valid quote data, even during background refresh.
  const hasValidQuote = quote.data && !quote.error;
  const canSwap =
    !isNoOp &&
    !insufficientBalance &&
    !submit.isPending &&
    amountOut > 0n &&
    hasValidQuote;

  // Determine why execution is blocked (null if can proceed)
  const execBlockedBecause = (() => {
    if (isNoOp) return "no-op";
    if (insufficientBalance) return "insufficient balance";
    if (quote.error) return "insufficient liquidity";
    if (quote.loading && !quote.data) return "loading...";
    if (amountIn === 0n) return "enter amount";
    return null;
  })();

  // Render action button
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

    return (
      <div className="action-section">
        <button
          className={`btn-primary${swapBusy ? " is-busy" : ""}`}
          disabled={!canSwap || !!submit.result}
          onClick={handleSwap}
        >
          {swapLabel}
        </button>
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
                    ? ` (${formatTokenAmount(balances[t.address] ?? 0n, t.decimals)})`
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
            <div className="input-with-max">
              <input
                ref={amountInputRef}
                id="amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              {isConnected && maxSwappable > 0n && (
                <button
                  type="button"
                  className="input-max"
                  onClick={() =>
                    setAmount(formatUnits(maxSwappable, fromDecimals))
                  }
                >
                  MAX
                </button>
              )}
            </div>
          </div>
          <div className="field">
            <label htmlFor="output">output</label>
            <input
              id="output"
              disabled
              value={
                amountIn > 0n && amountOut > 0n
                  ? formatTokenAmount(amountOut, toDecimals)
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
