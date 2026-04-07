// HistoryBox - account bar + swap history table for the connected wallet
import { useEffect, useMemo } from "react";
import type { Address } from "viem";
import { useDisconnect } from "wagmi";
import { useChainHead, useSwapHistory } from "../chain";
import { BLOCK_TIME_MS, EXPLORER_URL, TOKEN_DECIMALS } from "../config";
import { getSymbol, getTokenState } from "../tokens";
import {
  formatBlockAge,
  formatTokenAmount,
  shortenAddress,
} from "../utils";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface HistoryBoxProps {
  address: Address;
}

// Module-level set so "newness" survives HistoryBox unmount/remount (e.g.
// when the user tabs over to Assets and back). Without this, every row
// would mount fresh on each return and re-trigger the flash animation.
const seenSwapHashes = new Set<string>();

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export function HistoryBox({ address }: HistoryBoxProps) {
  const { disconnect } = useDisconnect();

  // Keyed off the chain head via the chain layer. placeholderData keeps the
  // previous swaps visible while a refetch is in flight, so the table no
  // longer flickers on every block tick.
  const { data: swaps } = useSwapHistory(address);

  // Subscribe to the chain head directly so the relative-age cells re-render
  // on every poll tick even when the swap data itself is unchanged.
  const { data: headBlock } = useChainHead();

  // Tx hashes we haven't shown the user yet — these get the flash animation.
  // Computed BEFORE the effect that marks them seen, so the className picks
  // up the truly-new ones on the same render.
  const newHashes = useMemo(() => {
    const set = new Set<string>();
    if (!swaps) return set;
    for (const s of swaps) {
      if (!seenSwapHashes.has(s.txHash)) set.add(s.txHash);
    }
    return set;
  }, [swaps]);

  // Mark every visible swap as seen after render so the next tick / refetch
  // / remount won't flag it again.
  useEffect(() => {
    if (!swaps) return;
    for (const s of swaps) seenSwapHashes.add(s.txHash);
  }, [swaps]);

  // Per-token decimal lookup. Tokens not in the loaded tokenlist (or null
  // for malformed swaps) fall back to TOKEN_DECIMALS.
  const { tokenMeta } = getTokenState();
  const decimalsFor = (addr: Address | null) =>
    (addr && tokenMeta[addr]?.decimals) ?? TOKEN_DECIMALS;

  return (
    <section className="panel">
      <div className="panel-title">
        <span>// trade history</span>
        <a
          className="btn-link"
          href="https://wallet.tempo.xyz"
          target="_blank"
          rel="noopener noreferrer"
        >
          show wallet
        </a>
      </div>

      <div className="history-account">
        <a
          className="btn-link"
          href={`${EXPLORER_URL}/address/${address}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          {shortenAddress(address)}
        </a>
        <button className="btn-link" onClick={() => disconnect()}>
          disconnect
        </button>
      </div>

      <div className="history">
        <table className="history-table">
          <thead>
            <tr>
              <th>time</th>
              <th>in</th>
              <th>out</th>
              <th>tx</th>
            </tr>
          </thead>
          <tbody>
            {swaps === undefined ? (
              // Initial load — don't show the empty placeholder until we
              // have a confirmed result from Index Supply, otherwise the
              // user sees "no trades yet" flash before their real history
              // populates.
              null
            ) : swaps.length === 0 ? (
              <tr>
                <td className="history-empty" colSpan={4}>
                  no trades yet
                </td>
              </tr>
            ) : (
              swaps.map((swap) => (
                <tr
                  key={swap.txHash}
                  className={
                    newHashes.has(swap.txHash) ? "history-row-new" : undefined
                  }
                >
                  <td>
                    {headBlock !== undefined
                      ? formatBlockAge(
                          swap.blockNumber,
                          headBlock,
                          BLOCK_TIME_MS
                        )
                      : "—"}
                  </td>
                  <td>
                    {formatTokenAmount(
                      swap.amountIn,
                      decimalsFor(swap.tokenIn),
                      2
                    )}{" "}
                    <span className="amount-symbol">
                      {swap.tokenIn ? getSymbol(swap.tokenIn) : "?"}
                    </span>
                  </td>
                  <td>
                    {formatTokenAmount(
                      swap.amountOut,
                      decimalsFor(swap.tokenOut),
                      2
                    )}{" "}
                    <span className="amount-symbol">
                      {swap.tokenOut ? getSymbol(swap.tokenOut) : "?"}
                    </span>
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
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
