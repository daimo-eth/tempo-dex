// HistoryBox - displays swap history for connected wallet
import React, { useEffect, useState } from "react";
import type { Address } from "viem";
import { formatUnits } from "viem";
import { TOKEN_DECIMALS, tokenMeta } from "./config";
import { fetchSwapHistory, type SwapSummary } from "./history";
import { shortenAddress } from "./utils";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const EXPLORER_BASE = "https://explorer.testnet.tempo.xyz/tx/";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface HistoryBoxProps {
  address: Address;
  refreshKey: number;
}

interface HistoryState {
  loading: boolean;
  error: string | null;
  swaps: SwapSummary[];
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export function HistoryBox({ address, refreshKey }: HistoryBoxProps) {
  const [state, setState] = useState<HistoryState>({
    loading: true,
    error: null,
    swaps: [],
  });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setState((s) => ({ ...s, loading: true, error: null }));

      try {
        const swaps = await fetchSwapHistory(address, 20);
        if (!cancelled) {
          setState({ loading: false, error: null, swaps });
        }
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : "failed to load history";
          setState({ loading: false, error: message, swaps: [] });
        }
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [address, refreshKey]);

  const formatAmount = (amount: bigint) => {
    const num = Number(formatUnits(amount, TOKEN_DECIMALS));
    if (num >= 1_000_000) return (num / 1_000_000).toFixed(2) + "M";
    if (num >= 1_000) return (num / 1_000).toFixed(2) + "K";
    return num.toFixed(2);
  };

  const getSymbol = (token: Address | null) => {
    if (!token) return "?";
    return tokenMeta[token]?.symbol ?? shortenAddress(token);
  };

  return (
    <section className="panel">
      <div className="panel-title">// trade history</div>
      <div className="history">
        {state.loading ? (
          <div className="history-loading">loading...</div>
        ) : state.error ? (
          <div className="history-error">{state.error}</div>
        ) : state.swaps.length === 0 ? (
          <div className="history-empty">no swaps found</div>
        ) : (
          <table className="history-table">
            <thead>
              <tr>
                <th>block</th>
                <th>in</th>
                <th>out</th>
                <th>tx</th>
              </tr>
            </thead>
            <tbody>
              {state.swaps.map((swap) => (
                <tr key={swap.txHash}>
                  <td>{swap.blockNumber.toString()}</td>
                  <td>
                    {formatAmount(swap.amountIn)} {getSymbol(swap.tokenIn)}
                  </td>
                  <td>
                    {formatAmount(swap.amountOut)} {getSymbol(swap.tokenOut)}
                  </td>
                  <td>
                    <a
                      href={`${EXPLORER_BASE}${swap.txHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {shortenAddress(swap.txHash)}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

