// SwapBox - swap form, wallet connection, and execution
import { useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import {
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  maxUint256,
  parseUnits,
} from "viem";
import { tempoTestnet } from "viem/chains";
import {
  useAccount,
  useConnect,
  useConnectors,
  useDisconnect,
  useReadContract,
  useReadContracts,
  useSendCalls,
  useSwitchChain,
  useWaitForCallsStatus,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import {
  DEX_ABI,
  DEX_ADDRESS,
  TOKENS,
  TOKEN_DECIMALS,
  tokenMeta,
} from "../config";
import type { QuoteState } from "../types";
import { shortenAddress } from "../utils";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const REQUIRED_CHAIN_ID = tempoTestnet.id;
const SLIPPAGE_TOLERANCE = 0.005; // 0.5%
const EXPLORER_URL = tempoTestnet.blockExplorers.default.url;

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
    return TOKENS.map((tokenAddr) => ({
      address: tokenAddr,
      abi: erc20Abi,
      functionName: "balanceOf" as const,
      args: [address] as const,
    }));
  }, [address]);

  const { data: balanceResults } = useReadContracts({
    contracts: balanceContracts,
    query: { enabled: isConnected && balanceContracts.length > 0 },
  });

  const balances = useMemo(() => {
    const map: Record<Address, bigint> = {};
    if (balanceResults) {
      TOKENS.forEach((addr, idx) => {
        const result = balanceResults[idx];
        map[addr] =
          result?.status === "success" ? (result.result as bigint) : 0n;
      });
    }
    return map;
  }, [balanceResults]);

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

  // Batched swap (approve + swap in one call) for wallets that support it
  const batchedSwap = useSendCalls();

  // Wait for batched calls to complete
  const { data: batchedStatus, isLoading: isBatchedConfirming } =
    useWaitForCallsStatus({
      id: batchedSwap.data?.id,
      query: {
        enabled: !!batchedSwap.data?.id,
      },
    });

  // Track last batched swap params for success message
  const [lastBatchedSwapParams, setLastBatchedSwapParams] = useState<{
    fromAmount: string;
    fromSymbol: string;
    toAmount: string;
    toSymbol: string;
  } | null>(null);

  // Log receipts and handle errors
  useEffect(() => {
    if (!batchedStatus) return;

    console.log("[batchedSwap] status", batchedStatus);
    if (batchedStatus.receipts) {
      console.log("[batchedSwap] receipts", batchedStatus.receipts);
    }

    // Check status - "success"/"failure" string, or statusCode 200/500
    const statusCode = (batchedStatus as { statusCode?: number }).statusCode;
    const isSuccess = batchedStatus.status === "success" || statusCode === 200;
    const isFailure = batchedStatus.status === "failure" || statusCode === 500;

    if (isSuccess && lastBatchedSwapParams) {
      setSwapResult({
        type: "success",
        ...lastBatchedSwapParams,
      });
      onSwapSuccess();
      refetchAllowance();
    } else if (isFailure) {
      // Check for reverted receipts
      const failedReceipt = batchedStatus.receipts?.find(
        (r: { status: string }) => r.status === "reverted"
      );
      setSwapResult({
        type: "error",
        message: failedReceipt ? "transaction reverted" : "swap failed",
      });
    }
  }, [batchedStatus, lastBatchedSwapParams, onSwapSuccess, refetchAllowance]);

  const isBatchedPending = batchedSwap.isPending || isBatchedConfirming;

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

    // Build calls array - include approve if needed
    const calls: { to: Address; data: `0x${string}` }[] = [];

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

    calls.push({
      to: DEX_ADDRESS,
      data: encodeFunctionData({
        abi: DEX_ABI,
        functionName: "swapExactAmountIn",
        args: [fromToken, toToken, amountIn, minAmountOut],
      }),
    });

    // Capture params for success message
    const inputFormatted = Number(formatUnits(amountIn, TOKEN_DECIMALS));
    setLastBatchedSwapParams({
      fromAmount: inputFormatted.toFixed(2),
      fromSymbol: tokenMeta[fromToken]?.symbol ?? "",
      toAmount: amountOutFormatted.toFixed(2),
      toSymbol: tokenMeta[toToken]?.symbol ?? "",
    });
    setSwapResult(null);

    batchedSwap.sendCalls(
      {
        calls,
        chainId: REQUIRED_CHAIN_ID,
      },
      {
        onSuccess: (result) => {
          console.log("[batchedSwap] sendCalls result", result);
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
  }, [balances]);

  const tokensBySymbol = useMemo(() => {
    return Object.values(tokenMeta).sort((a, b) =>
      a.symbol.localeCompare(b.symbol)
    );
  }, []);

  // Balance check
  const fromBalance = balances[fromToken] ?? 0n;
  const fromBalanceFormatted = Number(formatUnits(fromBalance, TOKEN_DECIMALS));
  const parsedAmount = Number(amount) || 0;
  const insufficientBalance =
    isConnected && parsedAmount > fromBalanceFormatted;

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
                  connect({ connector: webAuthnConnector });
                  setShowWalletOptions(false);
                }}
              >
                SIGN UP
              </button>
              <button
                className="btn-secondary"
                onClick={() => {
                  connect({ connector: webAuthnConnector });
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

        <div className="field">
          <label htmlFor="amount">amount</label>
          <input
            id="amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
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
              <button className="btn-link" onClick={() => setSwapResult(null)}>
                continue
              </button>
            </div>
          ) : execBlockedBecause ? (
            <div>{execBlockedBecause}</div>
          ) : amountOut > 0n ? (
            <div className="success">
              outputs {amountOutFormatted.toFixed(2)}{" "}
              {tokenMeta[toToken]?.symbol}
            </div>
          ) : null}
        </div>

        {renderActionButtons()}
      </div>
    </section>
  );
}
