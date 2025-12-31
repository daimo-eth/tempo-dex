// AssetsBox - displays token tree with selected pair liquidity
import { useEffect, useState } from "react";
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
  asset: Address;
  block: bigint;
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
    nonRootTokens[0] ?? TOKENS[1]
  );
  const [liquidity, setLiquidity] = useState<LiquidityState | null>(null);

  const getParent = (addr: Address) => tokenMeta[addr]?.parent ?? null;
  const getSymbol = (addr: Address) => tokenMeta[addr]?.symbol ?? "";

  // Fetch liquidity when selected token or block number changes
  useEffect(() => {
    let cancelled = false;
    const isTokenChange = liquidity?.asset !== selectedToken;

    // Set loading state
    if (isTokenChange) {
      setLiquidity({
        asset: selectedToken,
        block: blockNumber,
        loading: true,
        error: null,
        data: null,
      });
    } else {
      setLiquidity((prev) =>
        prev ? { ...prev, block: blockNumber, loading: true } : null
      );
    }

    fetchPairLiquidity(selectedToken, blockNumber).then((result) => {
      if (cancelled) return;
      if ("error" in result) {
        setLiquidity({
          asset: selectedToken,
          block: blockNumber,
          loading: false,
          error: result.error,
          data: null,
        });
      } else {
        setLiquidity({
          asset: selectedToken,
          block: blockNumber,
          loading: false,
          error: null,
          data: result,
        });
      }
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedToken, blockNumber]);

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
    if (
      !liquidity ||
      (liquidity.loading && !liquidity.data && !liquidity.error)
    ) {
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

    // Console log market info
    if (tickRows.length > 0) {
      const minTick = tickRows[tickRows.length - 1].tick;
      const maxTick = tickRows[0].tick;
      const minPrice = tickRows[tickRows.length - 1].price;
      const maxPrice = tickRows[0].price;
      console.log(
        `${pairName}, min tick ${minTick} = ${minPrice.toFixed(5)}, max tick ${maxTick} = ${maxPrice.toFixed(5)}`
      );
    }

    // Format liquidity
    const formatLiq = (liq: bigint, price: number, isBid: boolean) => {
      if (liq === 0n) return "";
      // Bids are in child token (need price conversion), asks are in parent token
      const val = isBid
        ? (Number(liq) / 10 ** TOKEN_DECIMALS) * price
        : Number(liq) / 10 ** TOKEN_DECIMALS;
      return val.toFixed(0);
    };

    return (
      <div className="liquidity">
        <div className="liquidity-title">
          # 1 {childSymbol} = {midPrice.toFixed(5)} {parentSymbol}
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
