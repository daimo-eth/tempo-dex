import assert from "node:assert";
import { describe, it } from "node:test";
import {
  classifySwapError,
  formatBlockAge,
  formatTokenAmount,
  padOrTruncate,
  shortenAddress,
  TREE_W_CHARS,
} from "./utils.js";

describe("padOrTruncate", () => {
  it("pads short strings", () => {
    assert.strictEqual(padOrTruncate("abc", 6), "abc   ");
    assert.strictEqual(padOrTruncate("", 3), "   ");
  });

  it("returns string unchanged if exact length", () => {
    assert.strictEqual(padOrTruncate("abcdef", 6), "abcdef");
  });

  it("truncates and adds ellipsis for long strings", () => {
    assert.strictEqual(padOrTruncate("abcdefgh", 6), "abcde…");
    assert.strictEqual(padOrTruncate("toolongstring", 10), "toolongst…");
  });

  it("uses configured width", () => {
    const result = padOrTruncate("test", TREE_W_CHARS);
    assert.strictEqual(result.length, TREE_W_CHARS);
  });
});

describe("shortenAddress", () => {
  it("shortens long addresses", () => {
    assert.strictEqual(
      shortenAddress("0x1234567890abcdef1234567890abcdef12345678"),
      "0x1234...5678"
    );
  });

  it("returns short addresses unchanged", () => {
    assert.strictEqual(shortenAddress("0x1234"), "0x1234");
  });
});

describe("formatTokenAmount", () => {
  it("formats 6-decimal amounts with 4 fraction digits by default", () => {
    // 100.5 USDC.e at 6 decimals = 100_500_000n
    assert.strictEqual(formatTokenAmount(100_500_000n, 6), "100.5000");
    // 99.9912
    assert.strictEqual(formatTokenAmount(99_991_234n, 6), "99.9912");
  });

  it("uses comma thousands separators for large amounts", () => {
    // 1,234,567.8900
    assert.strictEqual(
      formatTokenAmount(1_234_567_890_000n, 6),
      "1,234,567.8900"
    );
  });

  it("respects per-token decimals (not hardcoded to 6)", () => {
    // 1 ETH at 18 decimals = 10n ** 18n
    assert.strictEqual(formatTokenAmount(10n ** 18n, 18), "1.0000");
    // 1.5 of an 8-decimal token
    assert.strictEqual(formatTokenAmount(150_000_000n, 8), "1.5000");
  });

  it("supports a custom fractionDigits override (history uses 2)", () => {
    assert.strictEqual(formatTokenAmount(100_500_000n, 6, 2), "100.50");
    assert.strictEqual(formatTokenAmount(1_234_567_890_000n, 6, 2), "1,234,567.89");
  });

  it("rounds dust to zero at 4 fraction digits", () => {
    // 1 atomic unit at 6 decimals = 0.000001 → rounds to 0.0000
    assert.strictEqual(formatTokenAmount(1n, 6), "0.0000");
    // Zero is zero
    assert.strictEqual(formatTokenAmount(0n, 6), "0.0000");
  });
});

describe("formatBlockAge", () => {
  // Tempo blocktime = 1s, so block delta = seconds.
  it("formats sub-minute ages in seconds", () => {
    assert.strictEqual(formatBlockAge(995n, 1000n), "5s ago");
    assert.strictEqual(formatBlockAge(941n, 1000n), "59s ago");
    assert.strictEqual(formatBlockAge(1000n, 1000n), "0s ago");
  });

  it("formats sub-hour ages in minutes", () => {
    assert.strictEqual(formatBlockAge(940n, 1000n), "1m ago");
    assert.strictEqual(formatBlockAge(0n, 3300n), "55m ago");
    assert.strictEqual(formatBlockAge(0n, 3599n), "59m ago");
  });

  it("formats sub-day ages in hours", () => {
    assert.strictEqual(formatBlockAge(0n, 3600n), "1h ago");
    assert.strictEqual(formatBlockAge(0n, 10_800n), "3h ago");
    assert.strictEqual(formatBlockAge(0n, 86_399n), "23h ago");
  });

  it("formats sub-week ages in days", () => {
    assert.strictEqual(formatBlockAge(0n, 86_400n), "1d ago");
    assert.strictEqual(formatBlockAge(0n, 172_800n), "2d ago");
    assert.strictEqual(formatBlockAge(0n, 6n * 86_400n), "6d ago");
  });

  it("formats older ages as ISO date", () => {
    // 8 days old → ISO date format
    const result = formatBlockAge(0n, 8n * 86_400n);
    assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
  });

  it("clamps negative deltas to 0", () => {
    // Swap block ahead of head (shouldn't happen in practice but be safe)
    assert.strictEqual(formatBlockAge(1010n, 1000n), "0s ago");
  });

  it("honors a custom msPerBlock (Tempo is ~491ms)", () => {
    // 100 blocks × 491ms = 49100ms → floor to 49s
    assert.strictEqual(formatBlockAge(0n, 100n, 491), "49s ago");
    // 7332 blocks × 491ms ≈ 3600s = 1h
    assert.strictEqual(formatBlockAge(0n, 7332n, 491), "1h ago");
    // 0 blocks → 0s
    assert.strictEqual(formatBlockAge(100n, 100n, 491), "0s ago");
  });
});

describe("classifySwapError", () => {
  it("detects user rejection / cancel", () => {
    assert.strictEqual(
      classifySwapError(new Error("User rejected the request.")),
      "swap cancelled"
    );
    assert.strictEqual(
      classifySwapError(new Error("MetaMask Tx Signature: User denied transaction signature.")),
      "swap cancelled"
    );
    assert.strictEqual(
      classifySwapError({ code: 4001, message: "code 4001" }),
      "swap cancelled"
    );
  });

  it("detects insufficient funds for gas", () => {
    assert.strictEqual(
      classifySwapError(
        new Error("insufficient funds for gas * price + value: have 0 want 21468")
      ),
      "not enough to cover gas — try a smaller amount"
    );
    assert.strictEqual(
      classifySwapError(
        new Error("The total cost of executing this transaction exceeds the balance of the account.")
      ),
      "not enough to cover gas — try a smaller amount"
    );
  });

  it("detects slippage / minOut violations", () => {
    assert.strictEqual(
      classifySwapError(new Error("Execution reverted: InsufficientLiquidity")),
      "price moved — try again"
    );
    assert.strictEqual(
      classifySwapError(new Error("min out not satisfied")),
      "price moved — try again"
    );
  });

  it("walks the cause chain to match nested errors", () => {
    const inner = new Error("insufficient funds for gas");
    const outer = new Error("RPC request failed");
    (outer as Error & { cause: Error }).cause = inner;
    assert.strictEqual(
      classifySwapError(outer),
      "not enough to cover gas — try a smaller amount"
    );
  });

  it("falls back to viem shortMessage when no pattern matches", () => {
    const viemErr = Object.assign(new Error("Long verbose message"), {
      shortMessage: "Transaction reverted.",
    });
    assert.strictEqual(classifySwapError(viemErr), "Transaction reverted.");
  });

  it("falls back to message then 'swap failed'", () => {
    assert.strictEqual(
      classifySwapError(new Error("Something obscure")),
      "Something obscure"
    );
    assert.strictEqual(classifySwapError(undefined), "swap failed");
    assert.strictEqual(classifySwapError(null), "swap failed");
  });
});
