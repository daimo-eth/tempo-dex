// Pure utility functions

import { formatUnits } from "viem";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

export const TREE_W_CHARS = 20;

// -----------------------------------------------------------------------------
// Text formatting
// -----------------------------------------------------------------------------

/** Pad string to width with spaces, or truncate with ellipsis */
export function padOrTruncate(str: string, width: number): string {
  if (str.length > width) {
    return str.slice(0, width - 1) + "…";
  }
  return str.padEnd(width, " ");
}

/** Shorten an address to 0x1234...5678 format */
export function shortenAddress(address: string): string {
  if (address.length < 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * Translate a wallet/RPC error from a swap or approve submission into a
 * short, user-friendly message that fits in the SwapBox status line.
 *
 * Searches the full stringified error (so nested viem `cause` chains are
 * matched too) for known patterns. Falls back to the error's shortMessage
 * (viem) or message, then to a generic "swap failed".
 *
 *   user cancelled            → "swap cancelled"
 *   insufficient funds / gas  → "not enough to cover gas — try a smaller amount"
 *   slippage / min out / liq  → "price moved — try again"
 *   anything else             → shortMessage / message / "swap failed"
 */
export function classifySwapError(error: unknown): string {
  // Walk the cause chain so a viem-wrapped error with the real reason
  // nested deep still gets matched. Handles both Error instances and
  // plain objects (RPC errors often come back as { code, message }).
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current; depth++) {
    if (current instanceof Error) {
      parts.push(current.message);
      const withExtras = current as Error & {
        shortMessage?: unknown;
        code?: unknown;
      };
      if (typeof withExtras.shortMessage === "string") {
        parts.push(withExtras.shortMessage);
      }
      if (withExtras.code !== undefined) parts.push(`code ${withExtras.code}`);
      current = (current as { cause?: unknown }).cause;
    } else if (typeof current === "object" && current !== null) {
      const obj = current as Record<string, unknown>;
      if (typeof obj.message === "string") parts.push(obj.message);
      if (typeof obj.shortMessage === "string") parts.push(obj.shortMessage);
      if (obj.code !== undefined) parts.push(`code ${obj.code}`);
      current = obj.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  const haystack = parts.join(" \n ").toLowerCase();

  // EIP-1193 4001 / wallet rejection.
  if (
    haystack.includes("user rejected") ||
    haystack.includes("user denied") ||
    haystack.includes("rejected the request") ||
    /\b4001\b/.test(haystack)
  ) {
    return "swap cancelled";
  }

  // Not enough balance to cover the swap amount + gas. On Tempo this
  // comes back as either the standard EVM "insufficient funds for gas"
  // or "exceeds the balance" wording.
  if (
    haystack.includes("insufficient funds") ||
    haystack.includes("insufficient feetoken") ||
    haystack.includes("exceeds the balance") ||
    haystack.includes("exceeds balance")
  ) {
    return "not enough to cover gas — try a smaller amount";
  }

  // Slippage / quote stale / no route.
  if (
    haystack.includes("slippage") ||
    haystack.includes("min out") ||
    haystack.includes("minamountout") ||
    haystack.includes("insufficientliquidity")
  ) {
    return "price moved — try again";
  }

  // Generic fallback. viem errors expose a `shortMessage` that's
  // usually one line and presentable.
  if (
    error &&
    typeof error === "object" &&
    "shortMessage" in error &&
    typeof (error as { shortMessage?: unknown }).shortMessage === "string"
  ) {
    return (error as { shortMessage: string }).shortMessage;
  }
  if (error instanceof Error && error.message) return error.message;
  return "swap failed";
}

/**
 * Format a token quantity for display.
 *
 * `decimals` is always passed in by the caller (read from the per-token
 * metadata) — we never assume a fixed precision. `fractionDigits` is the
 * number of digits to show after the decimal point and defaults to 4 for
 * the swap form / asset tree; the trade history passes 2 to keep its
 * cells compact.
 *
 * Uses `toLocaleString` with a fixed `en-US` locale so the output has
 * comma thousands separators ("1,234,567.8900") and is deterministic
 * across machines.
 */
export function formatTokenAmount(
  amount: bigint,
  decimals: number,
  fractionDigits = 4
): string {
  const n = Number(formatUnits(amount, decimals));
  return n.toLocaleString("en-US", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

/**
 * Format the age of a past block (e.g. a swap's block) relative to the
 * current chain head as a compact human-readable string.
 *
 * `msPerBlock` is the chain's average block time in milliseconds (Tempo
 * is ~491ms — see `BLOCK_TIME_MS` in config.ts). It defaults to 1000ms
 * (1s/block) to preserve the legacy behavior used by the existing tests.
 *
 *   < 60s  → "5s ago"
 *   < 60m  → "55m ago"
 *   < 24h  → "3h ago"
 *   < 7d   → "2d ago"
 *   ≥ 7d   → ISO date "2026-01-13"
 */
export function formatBlockAge(
  block: bigint,
  headBlock: bigint,
  msPerBlock = 1000
): string {
  const blocks = Number(headBlock > block ? headBlock - block : 0n);
  const seconds = Math.floor((blocks * msPerBlock) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(seconds / 3600);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(seconds / 86400);
  if (days < 7) return `${days}d ago`;
  // Older than a week — fall back to an absolute date.
  const swapMillis = Date.now() - seconds * 1000;
  return new Date(swapMillis).toISOString().slice(0, 10);
}

// -----------------------------------------------------------------------------
// Tree drawing
// -----------------------------------------------------------------------------

export const BOX_VERT = "│";
export const BOX_BRANCH = "├── ";
export const BOX_CORNER = "└── ";
export const BOX_CORNER_UP = "┌── ";
export const BOX_SPACE = "    ";
export const BOX_CONT = "│   ";

/** Build tree prefix for a given depth */
export function buildTreePrefix(
  depth: number,
  isLast: boolean,
  continuesBelow: boolean
): string {
  if (depth === 0) return "";
  let prefix = "";
  for (let i = 0; i < depth - 1; i++) {
    prefix += continuesBelow ? BOX_CONT : BOX_SPACE;
  }
  prefix += isLast && !continuesBelow ? BOX_CORNER : BOX_BRANCH;
  return prefix;
}
