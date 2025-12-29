// AssetsBox - displays token tree with selected pair liquidity
import React, { useCallback, useEffect, useState } from "react";
import type { Address } from "viem";
import { ROOT_TOKEN, TOKEN_DECIMALS, tokenMeta, TOKENS } from "../config";
import {
  fetchPairLiquidity,
  getNonRootTokens,
  type PairLiquidity,
} from "../data";
import { BOX_CORNER, padOrTruncate, TREE_W_CHARS } from "../utils";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface AssetsBoxProps {
  blockNumber: bigint;
}

interface LiquidityState {
  loading: boolean;
  error: string | null;
  data: PairLiquidity | null;
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export function AssetsBox({ blockNumber }: AssetsBoxProps) {
  const nonRootTokens = getNonRootTokens();
  const [selectedToken, setSelectedToken] = useState<Address>(
    nonRootTokens[0] ?? (TOKENS[1] as Address)
  );
  const [liquidity, setLiquidity] = useState<LiquidityState>({
    loading: false,
    error: null,
    data: null,
  });

  const getParent = (addr: Address) => tokenMeta[addr]?.parent ?? null;
  const getSymbol = (addr: Address) => tokenMeta[addr]?.symbol ?? "";

  // Fetch liquidity when selected token or block number changes
  const loadLiquidity = useCallback(
    async (token: Address, block: bigint, isTokenChange: boolean) => {
      // Only clear data when changing token, not on block refresh
      if (isTokenChange) {
        setLiquidity({ loading: true, error: null, data: null });
      } else {
        setLiquidity((prev) => ({ ...prev, loading: true }));
      }
      const result = await fetchPairLiquidity(token, block);
      if ("error" in result) {
        setLiquidity({ loading: false, error: result.error, data: null });
      } else {
        setLiquidity({ loading: false, error: null, data: result });
      }
    },
    []
  );

  // Track previous token to detect token changes vs block refreshes
  const prevTokenRef = React.useRef<Address>(selectedToken);

  useEffect(() => {
    const isTokenChange = prevTokenRef.current !== selectedToken;
    prevTokenRef.current = selectedToken;
    loadLiquidity(selectedToken, blockNumber, isTokenChange);
  }, [selectedToken, blockNumber, loadLiquidity]);

  const handleSelectToken = (addr: Address) => {
    if (addr !== ROOT_TOKEN) {
      setSelectedToken(addr);
    }
  };

  // Build tree with pathUSD always on top, proper parent-child hierarchy
  const renderTree = () => {
    const lines: React.ReactNode[] = [];
    const selectedParent = getParent(selectedToken);
    const highlightedNodes = new Set<Address>([selectedToken]);
    if (selectedParent) highlightedNodes.add(selectedParent);

    // Build children map
    const childrenOf = new Map<Address | null, Address[]>();
    for (const addr of TOKENS) {
      const parent = getParent(addr);
      const siblings = childrenOf.get(parent) ?? [];
      siblings.push(addr);
      childrenOf.set(parent, siblings);
    }

    // DFS traversal starting from root
    const traverse = (addr: Address, depth: number) => {
      const isHighlighted = highlightedNodes.has(addr);
      const isSelected = addr === selectedToken;
      const isRoot = addr === ROOT_TOKEN;
      const symbol = getSymbol(addr);

      // Build prefix
      let prefix = "";
      for (let i = 0; i < depth; i++) prefix += "    ";
      if (depth > 0) {
        prefix = prefix.slice(0, -4) + BOX_CORNER;
      }

      const leftCol = padOrTruncate(prefix + symbol, TREE_W_CHARS);

      lines.push(
        <div
          key={addr}
          className={`tree-line ${isHighlighted ? "on-path" : "off-path"} ${isSelected ? "selected" : ""} ${!isRoot ? "clickable" : ""}`}
          onClick={() => handleSelectToken(addr)}
        >
          <span className="left">{leftCol}</span>
        </div>
      );

      // Recurse into children
      const children = childrenOf.get(addr) ?? [];
      for (const child of children) {
        traverse(child, depth + 1);
      }
    };

    traverse(ROOT_TOKEN, 0);
    return lines;
  };

  // Render liquidity info
  const renderLiquidity = () => {
    const childSymbol = getSymbol(selectedToken);
    const parentSymbol = getSymbol(getParent(selectedToken) ?? ROOT_TOKEN);
    const pairName = `${childSymbol}-${parentSymbol}`;

    // Show loading only if no existing data
    if (liquidity.loading && !liquidity.data && !liquidity.error) {
      return (
        <div className="liquidity">
          <div className="liquidity-title"># {pairName}</div>
          <div className="liquidity-loading">loading...</div>
        </div>
      );
    }

    if (liquidity.error && !liquidity.data) {
      return (
        <div className="liquidity">
          <div className="liquidity-title"># {pairName}</div>
          <div className="liquidity-error">{liquidity.error}</div>
        </div>
      );
    }

    if (!liquidity.data) {
      return null;
    }

    const { midPrice, tickRows } = liquidity.data;

    // Format liquidity to USD
    const formatLiq = (liq: bigint, price: number, isBid: boolean) => {
      if (liq === 0n) return "";
      // Bids are in child token (need price conversion), asks are in parent token
      const usd = isBid
        ? (Number(liq) / 10 ** TOKEN_DECIMALS) * price
        : Number(liq) / 10 ** TOKEN_DECIMALS;
      return `$${usd.toFixed(0)}`;
    };

    return (
      <div className="liquidity">
        <div className="liquidity-title">
          # {pairName} {midPrice.toFixed(5)}
        </div>
        {tickRows.length > 0 && (
          <table className="tick-table">
            <thead>
              <tr>
                <th>price</th>
                <th>bid</th>
                <th>ask</th>
              </tr>
            </thead>
            <tbody>
              {tickRows.map((row) => (
                <tr key={row.tick}>
                  <td>{row.price.toFixed(5)}</td>
                  <td>{formatLiq(row.bidLiquidity, row.price, true)}</td>
                  <td>{formatLiq(row.askLiquidity, row.price, false)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    );
  };

  return (
    <section className="panel">
      <div className="panel-title">// asset tree</div>
      <div className="tree">{renderTree()}</div>
      {renderLiquidity()}
    </section>
  );
}

