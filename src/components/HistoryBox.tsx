// HistoryBox - displays swap history for connected wallet
import { useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import { formatUnits } from "viem";
import { EXPLORER_URL, TOKEN_DECIMALS } from "../config";
import { fetchSwapHistory, type SwapSummary } from "../indexSupply";
import { getSymbol } from "../tokens";
import { shortenAddress } from "../utils";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface HistoryBoxProps {
  address: Address;
  blockNumber: bigint;
}

interface HistoryState {
  loading: boolean;
  error: string | null;
  swaps: SwapSummary[];
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export function HistoryBox({ address, blockNumber }: HistoryBoxProps) {
  const [state, setState] = useState<HistoryState>({
    loading: true,
    error: null,
    swaps: [],
  });

  // Deduplication: track last fetched params
  const lastFetchRef = useRef<string>("");

  useEffect(() => {
    const fetchKey = `${address}-${blockNumber}`;
    if (fetchKey === lastFetchRef.current) return;
    lastFetchRef.current = fetchKey;

    let cancelled = false;

    fetchSwapHistory(address, blockNumber, 20)
      .then((swaps) => {
        if (!cancelled) {
          setState({ loading: false, error: null, swaps });
        }
      })
      .catch((err) => {
        if (!cancelled) {
          const message =
            err instanceof Error ? err.message : "failed to load history";
          setState((s) => ({ ...s, loading: false, error: message }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [address, blockNumber]);

  const formatAmount = (amount: bigint) => {
    const num = Number(formatUnits(amount, TOKEN_DECIMALS));
    if (num >= 1_000_000) return (num / 1_000_000).toFixed(2) + "M";
    if (num >= 1_000) return (num / 1_000).toFixed(2) + "K";
    return num.toFixed(2);
  };

  // Don't render anything if no swaps
  if (state.swaps.length === 0) {
    return null;
  }

  return (
    <section className="panel">
      <div className="panel-title">// trade history</div>
      <div className="history">
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
                  {formatAmount(swap.amountIn)}{" "}
                  {swap.tokenIn ? getSymbol(swap.tokenIn) : "?"}
                </td>
                <td>
                  {formatAmount(swap.amountOut)}{" "}
                  {swap.tokenOut ? getSymbol(swap.tokenOut) : "?"}
                </td>
                <td>
                  <a
                    href={`${EXPLORER_URL}/tx/${swap.txHash}`}
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
      </div>
    </section>
  );
}

