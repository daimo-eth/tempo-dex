// SwapTreeBox - displays the token tree with swap path highlighted
import React from "react";
import type { Address } from "viem";
import { formatUnits, getAddress } from "viem";
import { ROOT_TOKEN, TOKEN_DECIMALS } from "../config";
import { getSwapPath } from "../data";
import { getTokenDepth } from "../swap";
import { getTokenState } from "../tokens";
import type { QuoteState } from "../types";
import {
  BOX_CORNER,
  BOX_CORNER_UP,
  TREE_W_CHARS,
  padOrTruncate,
} from "../utils";
import { Label } from "./Text";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const AMOUNT_WIDTH = 10;

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface SwapTreeBoxProps {
  fromToken: Address;
  toToken: Address;
  quote: QuoteState;
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export function SwapTreeBox({ fromToken, toToken, quote }: SwapTreeBoxProps) {
  const { tokenMeta } = getTokenState();
  const rootToken = getAddress(ROOT_TOKEN);

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
      path.includes(rootToken) &&
      path[0] !== rootToken &&
      path[path.length - 1] !== rootToken;

    // Find where root is in the path
    const rootIdx = path.indexOf(rootToken);
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
          const amtStr = formatted.toFixed(2).padStart(AMOUNT_WIDTH);
          let label = "";
          if (addr === inputNode) label = " INPUT";
          if (addr === outputNode && inputNode !== outputNode)
            label = " OUTPUT";
          rightContent = (
            <>
              {amtStr}
              {label && <Label>{label}</Label>}
            </>
          );
        } else if (quote.loading) {
          rightContent = "...".padStart(AMOUNT_WIDTH);
        }
      }

      const leftCol = padOrTruncate(prefix + symbol, TREE_W_CHARS);
      const lineKey = `${addr}-${useUpwardL ? "up" : "down"}`;
      lines.push(
        <div
          key={lineKey}
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
      if (!highlightNodes.has(rootToken)) {
        addLine(rootToken, false);
      }
    } else {
      // Single node (no-op) - show token above pathUSD
      if (path[0] !== rootToken) {
        addLine(path[0], true); // Use upward corner since it's above pathUSD
        addLine(rootToken, false);
      } else {
        addLine(rootToken, false);
      }
    }

    return lines;
  };

  return (
    <section className="panel">
      <div className="panel-title">// swap tree</div>
      <div className="tree">{renderTree()}</div>
    </section>
  );
}
