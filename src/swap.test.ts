import assert from "node:assert";
import { describe, it } from "node:test";
import type { Address } from "viem";
import {
  buildChildrenMap,
  calculateAmountAtHop,
  calculateOutputAmount,
  calculateSwapRoute,
  FEE_PER_HOP,
  getPathToRoot,
  getTokenDepth,
} from "./swap.js";

// Mock token tree using Address-like strings:
//   ROOT (0x00)
//   ├── A (0x01)
//   │   └── C (0x03)
//   └── B (0x02)
//       └── D (0x04)

const ROOT = "0x0000000000000000000000000000000000000000" as Address;
const A = "0x0000000000000000000000000000000000000001" as Address;
const B = "0x0000000000000000000000000000000000000002" as Address;
const C = "0x0000000000000000000000000000000000000003" as Address;
const D = "0x0000000000000000000000000000000000000004" as Address;

const mockParent: Record<Address, Address | null> = {
  [ROOT]: null,
  [A]: ROOT,
  [B]: ROOT,
  [C]: A,
  [D]: B,
};
const mockSymbol: Record<Address, string> = {
  [ROOT]: "pathUSD",
  [A]: "AlphaUSD",
  [B]: "BetaUSD",
  [C]: "GammaUSD",
  [D]: "DeltaUSD",
};

const getParent = (addr: Address) => mockParent[addr] ?? null;
const getSymbol = (addr: Address) => mockSymbol[addr] ?? "";

describe("getPathToRoot", () => {
  it("returns path from leaf to root", () => {
    assert.deepStrictEqual(getPathToRoot(C, getParent), [C, A, ROOT]);
    assert.deepStrictEqual(getPathToRoot(D, getParent), [D, B, ROOT]);
  });

  it("returns single element for root", () => {
    assert.deepStrictEqual(getPathToRoot(ROOT, getParent), [ROOT]);
  });

  it("returns path for direct child of root", () => {
    assert.deepStrictEqual(getPathToRoot(A, getParent), [A, ROOT]);
  });
});

describe("calculateSwapRoute", () => {
  it("calculates route between siblings", () => {
    const route = calculateSwapRoute(A, B, ROOT, getParent);
    assert.deepStrictEqual(route.inputPath, [A]);
    assert.deepStrictEqual(route.outputPath, [ROOT, B]);
    assert.strictEqual(route.hops, 2);
    assert.ok(Math.abs(route.rate - Math.pow(FEE_PER_HOP, 2)) < 0.0001);
  });

  it("calculates route from leaf to leaf", () => {
    const route = calculateSwapRoute(C, D, ROOT, getParent);
    assert.deepStrictEqual(route.inputPath, [C, A]);
    assert.deepStrictEqual(route.outputPath, [ROOT, B, D]);
    assert.strictEqual(route.hops, 4);
    assert.ok(route.highlightNodes.has(C));
    assert.ok(route.highlightNodes.has(A));
    assert.ok(route.highlightNodes.has(ROOT));
    assert.ok(route.highlightNodes.has(B));
    assert.ok(route.highlightNodes.has(D));
  });

  it("calculates route from parent to child", () => {
    const route = calculateSwapRoute(A, C, ROOT, getParent);
    assert.deepStrictEqual(route.inputPath, []);
    assert.deepStrictEqual(route.outputPath, [A, C]);
    assert.strictEqual(route.hops, 1);
  });

  it("calculates route from child to parent", () => {
    const route = calculateSwapRoute(C, A, ROOT, getParent);
    assert.deepStrictEqual(route.inputPath, [C]);
    assert.deepStrictEqual(route.outputPath, [A]);
    assert.strictEqual(route.hops, 1);
  });

  it("handles same token (zero hops)", () => {
    const route = calculateSwapRoute(A, A, ROOT, getParent);
    assert.strictEqual(route.hops, 0);
    assert.strictEqual(route.rate, 1);
  });
});

describe("calculateOutputAmount", () => {
  it("applies rate correctly", () => {
    assert.ok(Math.abs(calculateOutputAmount(100, 0.994) - 99.4) < 0.01);
    assert.strictEqual(calculateOutputAmount(100, 1), 100);
  });

  it("returns 0 for invalid input", () => {
    assert.strictEqual(calculateOutputAmount(NaN, 0.99), 0);
    assert.strictEqual(calculateOutputAmount(Infinity, 0.99), 0);
    assert.strictEqual(calculateOutputAmount(-100, 0.99), 0);
  });
});

describe("calculateAmountAtHop", () => {
  it("applies fee per hop", () => {
    assert.strictEqual(calculateAmountAtHop(100, 0), 100);
    assert.ok(
      Math.abs(calculateAmountAtHop(100, 1) - 100 * FEE_PER_HOP) < 0.01
    );
    assert.ok(
      Math.abs(calculateAmountAtHop(100, 2) - 100 * FEE_PER_HOP * FEE_PER_HOP) <
        0.01
    );
  });
});

describe("getTokenDepth", () => {
  it("returns 0 for root", () => {
    assert.strictEqual(getTokenDepth(ROOT, getParent), 0);
  });

  it("returns correct depth for children", () => {
    assert.strictEqual(getTokenDepth(A, getParent), 1);
    assert.strictEqual(getTokenDepth(B, getParent), 1);
    assert.strictEqual(getTokenDepth(C, getParent), 2);
    assert.strictEqual(getTokenDepth(D, getParent), 2);
  });
});

describe("buildChildrenMap", () => {
  it("builds children map sorted by symbol", () => {
    const tokens = [ROOT, A, B, C, D] as const;
    const map = buildChildrenMap(tokens, getParent, getSymbol);

    assert.deepStrictEqual(map.get(ROOT), [A, B]);
    assert.deepStrictEqual(map.get(A), [C]);
    assert.deepStrictEqual(map.get(B), [D]);
    assert.strictEqual(map.has(C), false);
  });
});
