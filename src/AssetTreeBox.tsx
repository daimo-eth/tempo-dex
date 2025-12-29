// AssetTreeBox - displays the token tree with swap path highlighted
import React from "react";
import type { Address } from "viem";
import { formatUnits } from "viem";
import { ROOT_TOKEN, TOKEN_DECIMALS, tokenMeta } from "./config";
import { getSwapPath } from "./data";
import { getTokenDepth } from "./swap";
import { Label } from "./text";
import type { QuoteState } from "./types";
import {
  BOX_CORNER,
  BOX_CORNER_UP,
  TREE_W_CHARS,
  padOrTruncate,
} from "./utils";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface AssetTreeBoxProps {
  fromToken: Address;
  toToken: Address;
  quote: QuoteState;
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export function AssetTreeBox({ fromToken, toToken, quote }: AssetTreeBoxProps) {
  const getParent = (addr: Address) => tokenMeta[addr]?.parent ?? null;
  const getSymbol = (addr: Address) => tokenMeta[addr]?.symbol ?? "";

  // Get path - this is instant, doesn't depend on quote loading
  const path = getSwapPath(fromToken, toToken);
  const highlightNodes = new Set(path);
  const isNoOp = fromToken === toToken;

  // Build amount lookup from quote data
  const amountByNode = new Map<Address, bigint>();
  if (quote.data) {
    quote.data.path.forEach((addr, idx) => {
      amountByNode.set(addr, quote.data!.amounts[idx]);
    });
  }

  const renderTree = () => {
    const lines: React.ReactNode[] = [];

    // Determine if path goes through root
    const pathThroughRoot =
      path.includes(ROOT_TOKEN) &&
      path[0] !== ROOT_TOKEN &&
      path[path.length - 1] !== ROOT_TOKEN;

    // Find where root is in the path
    const rootIdx = path.indexOf(ROOT_TOKEN);
    const inputPath = rootIdx >= 0 ? path.slice(0, rootIdx) : path;
    const outputPath = rootIdx >= 0 ? path.slice(rootIdx) : [];

    const inputNode = path[0];
    const outputNode = path[path.length - 1];

    const addLine = (addr: Address, useUpwardL: boolean) => {
      const isOnPath = highlightNodes.has(addr);
      const depth = getTokenDepth(addr, getParent);
      const symbol = getSymbol(addr);

      // Build prefix: spaces for depth, then L connector
      let prefix = "";
      for (let i = 0; i < depth; i++) prefix += "    ";
      if (depth > 0) {
        prefix =
          prefix.slice(0, -4) + (useUpwardL ? BOX_CORNER_UP : BOX_CORNER);
      }

      // Amount and label for on-path nodes only
      let rightContent: React.ReactNode = null;
      if (isOnPath && !isNoOp) {
        const amt = amountByNode.get(addr);
        if (amt !== undefined) {
          const formatted = Number(formatUnits(amt, TOKEN_DECIMALS));
          let label: React.ReactNode = null;
          if (addr === inputNode) label = <Label> INPUT</Label>;
          if (addr === outputNode && inputNode !== outputNode)
            label = <Label> OUTPUT</Label>;
          rightContent = (
            <>
              ${formatted.toFixed(2)}{label}
            </>
          );
        } else if (quote.loading) {
          rightContent = "...";
        }
      }

      const leftCol = padOrTruncate(prefix + symbol, TREE_W_CHARS);
      lines.push(
        <div
          key={addr}
          className={`tree-line ${isOnPath ? "on-path" : "off-path"}`}
        >
          <span className="left">{leftCol}</span>
          {rightContent && <span className="right">{rightContent}</span>}
        </div>
      );
    };

    if (pathThroughRoot) {
      // Cross-branch swap: input above, pathUSD center, output below
      inputPath.forEach((addr) => addLine(addr, true));
      outputPath.forEach((addr) => addLine(addr, false));
    } else if (path.length > 1) {
      // Same-branch swap: all nodes above pathUSD, ordered by depth desc
      const sorted = [...path].sort(
        (a, b) => getTokenDepth(b, getParent) - getTokenDepth(a, getParent)
      );
      sorted.forEach((addr) => addLine(addr, true));
      // Show pathUSD greyed at bottom if not in path
      if (!highlightNodes.has(ROOT_TOKEN)) {
        addLine(ROOT_TOKEN, false);
      }
    } else {
      // Single node (no-op) - show token above pathUSD
      if (path[0] !== ROOT_TOKEN) {
        addLine(path[0], true); // Use upward corner since it's above pathUSD
        addLine(ROOT_TOKEN, false);
      } else {
        addLine(ROOT_TOKEN, false);
      }
    }

    return lines;
  };

  return (
    <section className="panel">
      <div className="panel-title">// asset tree</div>
      <div className="tree">{renderTree()}</div>
    </section>
  );
}
