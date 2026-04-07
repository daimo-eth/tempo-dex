// AssetsBox - displays token tree with selected pair liquidity
import { type ReactNode } from "react";
import type { Address } from "viem";
import { usePairLiquidity } from "../chain";
import { ROOT_TOKEN, TOKEN_DECIMALS } from "../config";
import { getNonRootTokens } from "../data";
import { getTokenState } from "../tokens";
import { BOX_CORNER, padOrTruncate, TREE_W_CHARS } from "../utils";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface AssetsBoxProps {
  selectedToken: Address | null;
  onSelectToken: (addr: Address) => void;
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export function AssetsBox({
  selectedToken: selectedTokenProp,
  onSelectToken,
}: AssetsBoxProps) {
  const { tokens, tokenMeta } = getTokenState();
  const nonRootTokens = getNonRootTokens();
  const rootToken = ROOT_TOKEN;
  const selectedToken = selectedTokenProp ?? nonRootTokens[0] ?? tokens[1];

  // Keyed off (selectedToken, chain head) via the chain layer. The query
  // re-keys when the user picks a different token, naturally producing a
  // loading state. On block ticks the same key is preserved, so
  // placeholderData keeps the orderbook visible without flicker.
  const { data: liquidityResult, isLoading } = usePairLiquidity(selectedToken);

  const liquidityData =
    liquidityResult && !("error" in liquidityResult) ? liquidityResult : null;
  const liquidityError =
    liquidityResult && "error" in liquidityResult ? liquidityResult.error : null;

  const getParent = (addr: Address) => tokenMeta[addr]?.parent ?? null;
  const getSymbol = (addr: Address) => tokenMeta[addr]?.symbol ?? "";

  const handleSelectToken = (addr: Address) => {
    if (addr !== rootToken) {
      onSelectToken(addr);
    }
  };

  // Build tree with pathUSD always on top, proper parent-child hierarchy
  const renderTree = () => {
    const lines: ReactNode[] = [];
    const selectedParent = getParent(selectedToken);

    // Build children map
    const childrenOf = new Map<Address | null, Address[]>();
    for (const addr of tokens) {
      const parent = getParent(addr);
      const siblings = childrenOf.get(parent) ?? [];
      siblings.push(addr);
      childrenOf.set(parent, siblings);
    }

    // DFS traversal starting from root
    const traverse = (addr: Address, depth: number) => {
      const isSelected = addr === selectedToken;
      const isParent = addr === selectedParent;
      const isRoot = addr === rootToken;
      const symbol = getSymbol(addr);

      // Build prefix
      let prefix = "";
      for (let i = 0; i < depth; i++) prefix += "    ";
      if (depth > 0) {
        prefix = prefix.slice(0, -4) + BOX_CORNER;
      }

      const leftCol = padOrTruncate(prefix + symbol, TREE_W_CHARS);

      // Three mutually exclusive states; .parent gets a subtler highlight
      // than .selected via the --c-text-soft color token.
      const stateClass = isSelected
        ? "selected"
        : isParent
          ? "parent"
          : "off-path";

      lines.push(
        <div
          key={addr}
          className={`tree-line ${stateClass}${isRoot ? "" : " clickable"}`}
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

    traverse(rootToken, 0);
    return lines;
  };

  // Render the orderbook body (everything inside the orderbook panel
  // except its panel-title). The wrapping <section> + title live in the
  // main return below so the asset tree and orderbook are two separate
  // panels — matching the per-section panel pattern from the DEX page.
  const renderOrderbookBody = (): ReactNode => {
    const childSymbol = getSymbol(selectedToken);
    const parentSymbol = getSymbol(getParent(selectedToken) ?? rootToken);
    const pairName = `${childSymbol}-${parentSymbol}`;

    // Format liquidity (bids in child token w/ price conversion, asks in parent)
    const formatLiq = (liq: bigint, price: number, isBid: boolean) => {
      if (liq === 0n) return "";
      const val = isBid
        ? (Number(liq) / 10 ** TOKEN_DECIMALS) * price
        : Number(liq) / 10 ** TOKEN_DECIMALS;
      return val.toFixed(0);
    };

    // Show loading only if no existing data (placeholderData prevents this
    // from triggering on block ticks — only on token change).
    if (isLoading && !liquidityData && !liquidityError) {
      return (
        <>
          <div className="liquidity-title"># {pairName}</div>
          <div className="liquidity-loading">loading...</div>
        </>
      );
    }
    if (liquidityError && !liquidityData) {
      return (
        <>
          <div className="liquidity-title"># {pairName}</div>
          <div className="liquidity-error">{liquidityError}</div>
        </>
      );
    }
    if (!liquidityData) return null;

    const { midPrice, tickRows: allRows } = liquidityData;
    // Defense-in-depth: filter empty ticks so a sentinel bug can't flood the DOM
    const tickRows = allRows.filter(
      (r) => r.bidLiquidity > 0n || r.askLiquidity > 0n
    );
    return (
      <>
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
      </>
    );
  };

  return (
    <>
      <section className="panel">
        <div className="panel-title">// asset tree</div>
        <div className="tree">{renderTree()}</div>
      </section>
      <section className="panel">
        <div className="panel-title">// orderbook</div>
        {renderOrderbookBody()}
      </section>
    </>
  );
}
