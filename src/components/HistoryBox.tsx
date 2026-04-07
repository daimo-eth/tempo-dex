// HistoryBox - displays swap history for connected wallet
import type { Address } from "viem";
import { formatUnits } from "viem";
import { useSwapHistory } from "../chain";
import { EXPLORER_URL, TOKEN_DECIMALS } from "../config";
import { getSymbol } from "../tokens";
import { shortenAddress } from "../utils";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface HistoryBoxProps {
  address: Address;
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export function HistoryBox({ address }: HistoryBoxProps) {
  // Keyed off the chain head via the chain layer. placeholderData keeps the
  // previous swaps visible while a refetch is in flight, so the table no
  // longer flickers on every block tick.
  const { data: swaps } = useSwapHistory(address);

  const formatAmount = (amount: bigint) => {
    const num = Number(formatUnits(amount, TOKEN_DECIMALS));
    if (num >= 1_000_000) return (num / 1_000_000).toFixed(2) + "M";
    if (num >= 1_000) return (num / 1_000).toFixed(2) + "K";
    return num.toFixed(2);
  };

  // Don't render anything if no swaps
  if (!swaps || swaps.length === 0) {
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
            {swaps.map((swap) => (
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
