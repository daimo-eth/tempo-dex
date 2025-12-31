import assert from "node:assert";
import { describe, it } from "node:test";
import { computePairLiquidity, type TickRow } from "./data.js";

const CHILD = "0x20c0000000000000000000000000000000000001" as const;
const PARENT = "0x20c0000000000000000000000000000000000000" as const;

describe("computePairLiquidity", () => {
  it("finds best bid (highest nonzero bid) and best ask (lowest nonzero ask)", () => {
    const tickRows: TickRow[] = [
      { tick: -100, price: 0.99, bidLiquidity: 2200n, askLiquidity: 0n },
      { tick: -50, price: 0.995, bidLiquidity: 1000n, askLiquidity: 0n },
      { tick: 0, price: 1.0, bidLiquidity: 0n, askLiquidity: 0n },
      { tick: 50, price: 1.005, bidLiquidity: 0n, askLiquidity: 400n },
    ];

    const result = computePairLiquidity(CHILD, PARENT, tickRows);

    // Best bid is highest price with bid liquidity = 0.995
    assert.strictEqual(result.midPrice, (0.995 + 1.005) / 2);
    assert.strictEqual(result.bestBidTick, -50);
    assert.strictEqual(result.bestAskTick, 50);
  });
});

