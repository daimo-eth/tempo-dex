// SwapBox - swap form, wallet connection, and execution
import React, { useMemo } from "react";
import type { Address } from "viem";
import { formatUnits, parseUnits } from "viem";
import { Actions, Addresses } from "viem/tempo";
import {
  useAccount,
  useConnect,
  useConnectors,
  useDisconnect,
  useReadContracts,
  useSendCallsSync,
  useSwitchChain,
} from "wagmi";
import { ERC20_ABI, TOKENS, TOKEN_DECIMALS, tokenMeta } from "./config";
import type { QuoteState } from "./types";
import { shortenAddress } from "./utils";
import { tempoTestnet } from "./wagmi";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const REQUIRED_CHAIN_ID = tempoTestnet.id;
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
  const { address, isConnected, chainId: walletChainId } = useAccount();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const sendCalls = useSendCallsSync();
  const connectors = useConnectors();
  const { connect } = useConnect();

  const [showWalletOptions, setShowWalletOptions] = React.useState(false);

  const isSwapPending = sendCalls.isPending;
  const isWrongChain = isConnected && walletChainId !== REQUIRED_CHAIN_ID;
  const isNoOp = fromToken === toToken;

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
      address: tokenAddr as Address,
      abi: ERC20_ABI,
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

  // Swap handler
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

    const calls = [
      Actions.token.approve.call({
        amount: amountIn,
        spender: Addresses.stablecoinExchange,
        token: fromToken,
      }),
      Actions.dex.sell.call({
        amountIn,
        minAmountOut,
        tokenIn: fromToken,
        tokenOut: toToken,
      }),
    ];

    console.log("[swap] sending calls", calls);
    sendCalls.sendCallsSync(
      { calls },
      {
        onSuccess: (data) => {
          console.log("[swap] success", data);
          onSwapSuccess();
        },
        onError: (error) => {
          console.error("[swap] error", error);
        },
      }
    );
  };

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
        if (a.type === "injected" && b.type !== "injected") return -1;
        if (a.type !== "injected" && b.type === "injected") return 1;
        return 0;
      });
  }, [connectors]);

  // Can swap?
  const canSwap =
    !isNoOp &&
    !insufficientBalance &&
    !isSwapPending &&
    amountOut > 0n &&
    !quote.error &&
    !quote.loading;

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
              onChange={(e) => setFromToken(e.target.value as Address)}
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
              onChange={(e) => setToToken(e.target.value as Address)}
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
          {isNoOp ? (
            <div>no-op</div>
          ) : quote.loading ? (
            <div>loading quote...</div>
          ) : quote.error ? (
            <div className="error">{quote.error}</div>
          ) : amountOut > 0n ? (
            <>
              <div>rate: {rate.toFixed(6)}</div>
              <div>
                output: {amountOutFormatted.toFixed(2)}{" "}
                {tokenMeta[toToken]?.symbol}
              </div>
            </>
          ) : parsedAmount > 0 ? (
            <div>enter amount</div>
          ) : null}
          {insufficientBalance && (
            <div className="error">insufficient balance</div>
          )}
        </div>

        {showWalletOptions ? (
          <div className="wallet-options">
            <div className="wallet-options-title">select wallet</div>
            {filteredConnectors.map((connector) => (
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
            <button
              className="btn-link"
              onClick={() => setShowWalletOptions(false)}
            >
              cancel
            </button>
          </div>
        ) : !isConnected ? (
          <button
            className="btn-primary"
            onClick={() => setShowWalletOptions(true)}
          >
            CONNECT
          </button>
        ) : isWrongChain ? (
          <div className="action-section">
            <button
              className="btn-primary"
              disabled={isSwitching}
              onClick={() => switchChain({ chainId: REQUIRED_CHAIN_ID })}
            >
              {isSwitching ? "SWITCHING..." : "SWITCH CHAIN"}
            </button>
            <button className="btn-link" onClick={handleDisconnect}>
              connected {shortenAddress(address!)}
            </button>
          </div>
        ) : (
          <div className="action-section">
            <button
              className="btn-primary"
              disabled={!canSwap}
              onClick={handleSwap}
            >
              {isSwapPending ? "SWAPPING..." : "SWAP"}
            </button>
            <button className="btn-link" onClick={handleDisconnect}>
              connected {shortenAddress(address!)}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
