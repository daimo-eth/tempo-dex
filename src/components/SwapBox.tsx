// SwapBox - swap form, wallet connection, and execution
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import { encodeFunctionData, erc20Abi, formatUnits, maxUint256, parseUnits } from "viem";
import {
  useAccount,
  useConnect,
  useConnectors,
  useDisconnect,
  useReadContract,
  useReadContracts,
  useSendCalls,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import {
  chain,
  DEX_ABI,
  DEX_ADDRESS,
  EXPLORER_URL,
  FAUCET_URL,
  ROOT_TOKEN,
  TOKEN_DECIMALS,
} from "../config";
import { getTokenState } from "../tokens";
import type { QuoteState } from "../types";
import { shortenAddress } from "../utils";

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
  onSwapSuccess: () => void;
}

type SwapResult =
  | {
      type: "success";
      fromAmount: string;
      fromSymbol: string;
      toAmount: string;
      toSymbol: string;
    }
  | { type: "error"; message: string }
  | null;

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
  onSwapSuccess,
}: SwapBoxProps) {
  // Get tokens from TokenManager
  const { tokens, tokenMeta } = getTokenState();

  // Ref for amount input (for re-focusing after swap)
  const amountInputRef = useRef<HTMLInputElement>(null);

  const {
    address,
    isConnected,
    chainId: walletChainId,
    connector,
  } = useAccount();
  const { disconnect } = useDisconnect();
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

  const [showWalletOptions, setShowWalletOptions] = useState(false);

  // Check if wallet supports batched calls
  // tempo.ts webAuthn connector supports batched calls via walletNamespaceCompat
  // but doesn't implement wallet_getCapabilities, so we detect by connector type
  const supportsBatchedCalls = useMemo(() => {
    if (!isConnected || !connector) return false;
    // tempo.ts webAuthn connector has id/type 'webAuthn'
    return connector.id === "webAuthn" || connector.type === "webAuthn";
  }, [isConnected, connector]);

  const isWrongChain = isConnected && walletChainId !== REQUIRED_CHAIN_ID;
  const isNoOp = fromToken === toToken;

  const [swapResult, setSwapResult] = useState<SwapResult>(null);

  // Clear swap result when inputs change
  useEffect(() => {
    setSwapResult(null);
  }, [fromToken, toToken, amount]);

  // Parse amount
  const amountIn = useMemo(() => {
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0n;
    return parseUnits(amount, TOKEN_DECIMALS);
  }, [amount]);

  // Fetch balances
  const balanceContracts = useMemo(() => {
    if (!address) return [];
    return tokens.map((tokenAddr) => ({
      address: tokenAddr,
      abi: erc20Abi,
      functionName: "balanceOf" as const,
      args: [address] as const,
    }));
  }, [address, tokens]);

  const { data: balanceResults } = useReadContracts({
    contracts: balanceContracts,
    query: { enabled: isConnected && balanceContracts.length > 0 },
  });

  const balances = useMemo(() => {
    const map: Record<Address, bigint> = {};
    if (balanceResults) {
      tokens.forEach((addr, idx) => {
        const result = balanceResults[idx];
        map[addr] =
          result?.status === "success" ? (result.result as bigint) : 0n;
      });
    }
    return map;
  }, [balanceResults, tokens]);

  // Fetch allowance for fromToken (spender is DEX)
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: fromToken,
    abi: erc20Abi,
    functionName: "allowance",
    args: address ? [address, DEX_ADDRESS] : undefined,
    query: { enabled: isConnected && !!address },
  });

  const currentAllowance = (allowance as bigint) ?? 0n;
  const needsApproval = amountIn > 0n && currentAllowance < amountIn;

  // Approve transaction
  const approveWrite = useWriteContract();

  // Wait for approve tx confirmation, then refetch allowance
  const { isLoading: isApproveConfirming } = useWaitForTransactionReceipt({
    hash: approveWrite.data,
    query: {
      enabled: !!approveWrite.data,
    },
  });

  // Refetch allowance when approve tx is confirmed
  useEffect(() => {
    if (approveWrite.data && !isApproveConfirming && approveWrite.isSuccess) {
      refetchAllowance();
    }
  }, [
    approveWrite.data,
    isApproveConfirming,
    approveWrite.isSuccess,
    refetchAllowance,
  ]);

  const isApprovePending = approveWrite.isPending || isApproveConfirming;

  const handleApprove = () => {
    console.log("[approve] handleApprove called", {
      fromToken,
      spender: DEX_ADDRESS,
      amount: "infinite",
    });

    // Infinite approval so user only has to approve once per token
    approveWrite.writeContract(
      {
        address: fromToken,
        abi: erc20Abi,
        functionName: "approve",
        args: [DEX_ADDRESS, maxUint256],
      },
      {
        onError: (error) => {
          console.error("[approve] error", error);
        },
      }
    );
  };

  // Swap transaction
  const swapWrite = useWriteContract();

  // Wait for swap tx confirmation
  const { isLoading: isSwapConfirming } = useWaitForTransactionReceipt({
    hash: swapWrite.data,
    query: {
      enabled: !!swapWrite.data,
    },
  });

  // Trigger onSwapSuccess when swap tx is confirmed (fallback flow)
  const [lastSwapParams, setLastSwapParams] = useState<{
    fromAmount: string;
    fromSymbol: string;
    toAmount: string;
    toSymbol: string;
  } | null>(null);

  useEffect(() => {
    if (
      swapWrite.data &&
      !isSwapConfirming &&
      swapWrite.isSuccess &&
      lastSwapParams
    ) {
      setSwapResult({
        type: "success",
        ...lastSwapParams,
      });
      onSwapSuccess();
      refetchAllowance();
    }
  }, [
    swapWrite.data,
    isSwapConfirming,
    swapWrite.isSuccess,
    lastSwapParams,
    onSwapSuccess,
    refetchAllowance,
  ]);

  const isSwapPending = swapWrite.isPending || isSwapConfirming;

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

  const handleSwap = () => {
    console.log("[swap] handleSwap called", {
      fromToken,
      toToken,
      amountIn: amountIn.toString(),
      minAmountOut: minAmountOut.toString(),
    });

    if (amountIn === 0n) {
      console.log("[swap] early return - zero amount");
      return;
    }

    // Capture params for success message
    const inputFormatted = Number(formatUnits(amountIn, TOKEN_DECIMALS));
    setLastSwapParams({
      fromAmount: inputFormatted.toFixed(2),
      fromSymbol: tokenMeta[fromToken]?.symbol ?? "",
      toAmount: amountOutFormatted.toFixed(2),
      toSymbol: tokenMeta[toToken]?.symbol ?? "",
    });
    setSwapResult(null);

    // DEX has built-in routing - single call works for any pair
    swapWrite.writeContract(
      {
        address: DEX_ADDRESS,
        abi: DEX_ABI,
        functionName: "swapExactAmountIn",
        args: [fromToken, toToken, amountIn, minAmountOut],
      },
      {
        onError: (error) => {
          console.error("[swap] error", error);
          setSwapResult({
            type: "error",
            message: error.message || "swap failed",
          });
        },
      }
    );
  };

  // Batched swap using EIP-5792 sendCalls (works with Tempo webAuthn)
  const batchedSwap = useSendCalls();
  const isBatchedPending = batchedSwap.isPending;

  // Track batched swap result
  const [lastBatchedSwapParams, setLastBatchedSwapParams] = useState<{
    fromAmount: string;
    fromSymbol: string;
    toAmount: string;
    toSymbol: string;
  } | null>(null);

  // Handle batched swap success/failure
  const handleBatchedSwapResult = useCallback(
    (status: "success" | "failure") => {
      if (status === "success" && lastBatchedSwapParams) {
        setSwapResult({
          type: "success",
          ...lastBatchedSwapParams,
        });
        onSwapSuccess();
        refetchAllowance();
      } else if (status === "failure") {
        setSwapResult({
          type: "error",
          message: "swap failed",
        });
      }
    },
    [lastBatchedSwapParams, onSwapSuccess, refetchAllowance]
  );

  const handleBatchedSwap = () => {
    console.log("[batchedSwap] handleBatchedSwap called", {
      fromToken,
      toToken,
      amountIn: amountIn.toString(),
      minAmountOut: minAmountOut.toString(),
      needsApproval,
    });

    if (amountIn === 0n) {
      console.log("[batchedSwap] early return - zero amount");
      return;
    }

    // Build calls array
    const calls: { to: Address; data: `0x${string}` }[] = [];

    // Add approval if needed
    if (needsApproval) {
      calls.push({
        to: fromToken,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [DEX_ADDRESS, amountIn],
        }),
      });
    }

    // Add swap call
    calls.push({
      to: DEX_ADDRESS,
      data: encodeFunctionData({
        abi: DEX_ABI,
        functionName: "swapExactAmountIn",
        args: [fromToken, toToken, amountIn, minAmountOut],
      }),
    });

    console.log("[batchedSwap] calls:", calls.length);

    // Store params for success message
    const inputFormatted = Number(formatUnits(amountIn, TOKEN_DECIMALS));
    setLastBatchedSwapParams({
      fromAmount: inputFormatted.toFixed(2),
      fromSymbol: tokenMeta[fromToken]?.symbol ?? "",
      toAmount: amountOutFormatted.toFixed(2),
      toSymbol: tokenMeta[toToken]?.symbol ?? "",
    });
    setSwapResult(null);

    batchedSwap.sendCalls(
      { calls },
      {
        onSuccess: (result) => {
          console.log("[batchedSwap] sendCalls result", result);
          // The result contains the batch ID - we need to wait for confirmation
          // For now, assume success if we get here (the UI will update on receipt)
          handleBatchedSwapResult("success");
        },
        onError: (error) => {
          console.error("[batchedSwap] error", error);
          setSwapResult({
            type: "error",
            message: error.message || "swap failed",
          });
        },
      }
    );
  };

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

  // Check if user has 0 pathUSD (root token) - show faucet link
  const rootTokenBalance = balances[ROOT_TOKEN] ?? 0n;
  const hasZeroPathUSD = isConnected && rootTokenBalance === 0n;

  const handleDisconnect = () => {
    if (window.confirm("Disconnect wallet?")) {
      disconnect();
    }
  };

  const formatBalance = (bal: bigint) => {
    const num = Number(formatUnits(bal, TOKEN_DECIMALS));
    if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + "M";
    if (num >= 1_000) return (num / 1_000).toFixed(1) + "K";
    if (num >= 1) return num.toFixed(2);
    return num.toFixed(4);
  };

  // Wallet options
  const filteredConnectors = useMemo(() => {
    const hasSpecificInjected = connectors.some(
      (c) => c.type === "injected" && c.name !== "Injected"
    );
    return connectors
      .filter((c) => !(c.name === "Injected" && hasSpecificInjected))
      .sort((a, b) => {
        const aInj = a.type === "injected" ? 1 : 0;
        const bInj = b.type === "injected" ? 1 : 0;
        return aInj - bInj;
      });
  }, [connectors]);

  // Button state - allow actions if we have valid quote data, even during background refresh
  const hasValidQuote = quote.data && !quote.error;

  const canApprove =
    !isNoOp &&
    !insufficientBalance &&
    !isApprovePending &&
    amountIn > 0n &&
    hasValidQuote;

  const canSwap =
    !isNoOp &&
    !insufficientBalance &&
    !isSwapPending &&
    !needsApproval &&
    amountOut > 0n &&
    hasValidQuote;

  // Batched swap can proceed even if needsApproval (it will include approve in the batch)
  const canBatchedSwap =
    !isNoOp &&
    !insufficientBalance &&
    !isBatchedPending &&
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
    if (showWalletOptions) {
      const webAuthnConnector = filteredConnectors.find(
        (c) => c.id === "webAuthn" || c.type === "webAuthn"
      );
      const otherConnectors = filteredConnectors.filter(
        (c) => c.id !== "webAuthn" && c.type !== "webAuthn"
      );

      return (
        <div className="wallet-options">
          {webAuthnConnector && (
            <div className="wallet-native">
              <button
                className="btn-primary"
                onClick={() => {
                  // Sign up creates a new passkey
                  connect({
                    connector: webAuthnConnector,
                    capabilities: { type: "sign-up" },
                  } as Parameters<typeof connect>[0]);
                  setShowWalletOptions(false);
                }}
              >
                SIGN UP
              </button>
              <button
                className="btn-secondary"
                onClick={() => {
                  // Log in uses an existing passkey
                  connect({
                    connector: webAuthnConnector,
                    capabilities: { type: "sign-in" },
                  } as Parameters<typeof connect>[0]);
                  setShowWalletOptions(false);
                }}
              >
                LOG IN
              </button>
            </div>
          )}
          {otherConnectors.length > 0 && (
            <>
              <div className="wallet-options-title">or connect wallet</div>
              {otherConnectors.map((connector) => (
                <button
                  key={connector.uid}
                  className="btn-connector"
                  onClick={() => {
                    connect({ connector });
                    setShowWalletOptions(false);
                  }}
                >
                  {connector.name}
                </button>
              ))}
            </>
          )}
          <button
            className="btn-link"
            onClick={() => setShowWalletOptions(false)}
          >
            cancel
          </button>
        </div>
      );
    }

    if (!isConnected) {
      return (
        <button
          className="btn-primary"
          onClick={() => setShowWalletOptions(true)}
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
          <div className="wallet-row">
            <button className="btn-link" onClick={handleDisconnect}>
              {shortenAddress(address!)}
            </button>
            <a
              className="btn-link"
              href={`${EXPLORER_URL}/address/${address}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              show account
            </a>
          </div>
        </div>
      );
    }

    // Connected and on correct chain
    // Use batched flow if wallet supports it, otherwise traditional approve → swap
    if (supportsBatchedCalls) {
      return (
        <div className="action-section">
          <button
            className="btn-primary"
            disabled={!canBatchedSwap || !!swapResult}
            onClick={handleBatchedSwap}
          >
            {isBatchedPending ? "SWAPPING..." : "SWAP"}
          </button>
          <div className="wallet-row">
            <button className="btn-link" onClick={handleDisconnect}>
              {shortenAddress(address!)}
            </button>
            <a
              className="btn-link"
              href={`${EXPLORER_URL}/address/${address}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              show account
            </a>
          </div>
        </div>
      );
    }

    // Traditional approve → swap flow
    return (
      <div className="action-section">
        {needsApproval ? (
          <button
            className="btn-primary"
            disabled={!canApprove || !!swapResult}
            onClick={handleApprove}
          >
            {isApprovePending ? "APPROVING..." : "APPROVE"}
          </button>
        ) : (
          <button
            className="btn-primary"
            disabled={!canSwap || !!swapResult}
            onClick={handleSwap}
          >
            {isSwapPending ? "SWAPPING..." : "SWAP"}
          </button>
        )}
        <div className="wallet-row">
          <button className="btn-link" onClick={handleDisconnect}>
            {shortenAddress(address!)}
          </button>
          <a
            className="btn-link"
            href={`${EXPLORER_URL}/address/${address}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            show account
          </a>
        </div>
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

        <div className="quote">
          {swapResult?.type === "error" ? (
            <div className="quote-row">
              <span className="error">{swapResult.message}</span>
              <button className="btn-link" onClick={() => setSwapResult(null)}>
                continue
              </button>
            </div>
          ) : swapResult?.type === "success" ? (
            <div className="quote-row">
              <span className="success">
                swapped {swapResult.fromAmount} {swapResult.fromSymbol} →{" "}
                {swapResult.toAmount} {swapResult.toSymbol}
              </span>
              <button
                className="btn-link"
                onClick={() => {
                  setSwapResult(null);
                  setAmount("");
                  amountInputRef.current?.focus();
                }}
              >
                continue
              </button>
            </div>
          ) : hasZeroPathUSD ? (
            <div className="quote-row">
              <span>no pathUSD balance</span>
              <a
                className="btn-link"
                href={FAUCET_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                get faucet funds
              </a>
            </div>
          ) : execBlockedBecause ? (
            <div>{execBlockedBecause}</div>
          ) : null}
        </div>

        {renderActionButtons()}
      </div>
    </section>
  );
}
