// Pure functions for swap path calculation and rate computation
import type { Address } from 'viem'

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

export const FEE_PER_HOP = 0.997

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface SwapRoute {
  inputPath: Address[]   // path from input token up to (not including) LCA
  outputPath: Address[]  // path from LCA down to output token
  highlightNodes: Set<Address>
  hops: number
  rate: number
}

// -----------------------------------------------------------------------------
// Core functions
// -----------------------------------------------------------------------------

/** Walk from address up to root, returning addresses in order */
export function getPathToRoot(
  address: Address,
  getParent: (addr: Address) => Address | null
): Address[] {
  const path: Address[] = []
  let current: Address | null = address
  while (current) {
    path.push(current)
    current = getParent(current)
  }
  return path
}

/** Compute swap route between two tokens */
export function calculateSwapRoute(
  fromAddress: Address,
  toAddress: Address,
  rootToken: Address,
  getParent: (addr: Address) => Address | null
): SwapRoute {
  const pathA = getPathToRoot(fromAddress, getParent)
  const pathB = getPathToRoot(toAddress, getParent)
  const pathASet = new Set(pathA)

  // find lowest common ancestor
  const lca = pathB.find((node) => pathASet.has(node)) ?? rootToken
  const idxA = pathA.indexOf(lca)
  const idxB = pathB.indexOf(lca)

  // build highlight set (all nodes on the path)
  const highlightNodes = new Set<Address>()
  pathA.slice(0, idxA + 1).forEach((node) => highlightNodes.add(node))
  pathB.slice(0, idxB + 1).forEach((node) => highlightNodes.add(node))

  // input path: from input up to (not including) LCA
  // output path: from LCA down to output
  const inputPath = pathA.slice(0, idxA)
  const outputPath: Address[] = [lca, ...(pathB.slice(0, idxB).reverse() as Address[])]

  const hops = idxA + idxB
  const rate = Math.pow(FEE_PER_HOP, Math.max(hops, 0))

  return { inputPath, outputPath, highlightNodes, hops, rate }
}

/** Calculate output amount after fees */
export function calculateOutputAmount(inputAmount: number, rate: number): number {
  if (!Number.isFinite(inputAmount) || inputAmount < 0) return 0
  return inputAmount * rate
}

/** Calculate amount at a specific hop */
export function calculateAmountAtHop(inputAmount: number, hopIndex: number): number {
  return inputAmount * Math.pow(FEE_PER_HOP, hopIndex)
}

/** Get depth of a token from root (0 = root) */
export function getTokenDepth(
  address: Address,
  getParent: (addr: Address) => Address | null
): number {
  let depth = 0
  let current: Address | null = getParent(address)
  while (current) {
    depth++
    current = getParent(current)
  }
  return depth
}

// -----------------------------------------------------------------------------
// Tree building
// -----------------------------------------------------------------------------

/** Build parent -> children map from token list */
export function buildChildrenMap(
  tokens: readonly Address[],
  getParent: (addr: Address) => Address | null,
  getSymbol: (addr: Address) => string
): Map<Address, Address[]> {
  const children = new Map<Address, Address[]>()
  tokens.forEach((addr) => {
    const parent = getParent(addr)
    if (!parent) return
    const list = children.get(parent) ?? []
    list.push(addr)
    children.set(parent, list)
  })
  // sort children alphabetically by symbol
  children.forEach((list, key) => {
    list.sort((a, b) => getSymbol(a).localeCompare(getSymbol(b)))
    children.set(key, list)
  })
  return children
}

