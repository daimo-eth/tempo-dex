// Pure functions for swap path calculation and rate computation

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

export const FEE_PER_HOP = 0.997

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface TokenMeta {
  address: string
  symbol: string
  parent: string | null
}

export interface SwapRoute {
  inputPath: string[]   // path from input token up to (not including) LCA
  outputPath: string[]  // path from LCA down to output token
  highlightNodes: Set<string>
  hops: number
  rate: number
}

// -----------------------------------------------------------------------------
// Core functions
// -----------------------------------------------------------------------------

/** Walk from address up to root, returning addresses in order */
export function getPathToRoot(
  address: string,
  getParent: (addr: string) => string | null
): string[] {
  const path: string[] = []
  let current: string | null = address
  while (current) {
    path.push(current)
    current = getParent(current)
  }
  return path
}

/** Compute swap route between two tokens */
export function calculateSwapRoute(
  fromAddress: string,
  toAddress: string,
  rootToken: string,
  getParent: (addr: string) => string | null
): SwapRoute {
  const pathA = getPathToRoot(fromAddress, getParent)
  const pathB = getPathToRoot(toAddress, getParent)
  const pathASet = new Set(pathA)

  // find lowest common ancestor
  const lca = pathB.find((node) => pathASet.has(node)) ?? rootToken
  const idxA = pathA.indexOf(lca)
  const idxB = pathB.indexOf(lca)

  // build highlight set (all nodes on the path)
  const highlightNodes = new Set<string>()
  pathA.slice(0, idxA + 1).forEach((node) => highlightNodes.add(node))
  pathB.slice(0, idxB + 1).forEach((node) => highlightNodes.add(node))

  // input path: from input up to (not including) LCA
  // output path: from LCA down to output
  const inputPath = pathA.slice(0, idxA)
  const outputPath = [lca, ...pathB.slice(0, idxB).reverse()]

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
  address: string,
  getParent: (addr: string) => string | null
): number {
  let depth = 0
  let current: string | null = getParent(address)
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
  tokens: string[],
  getParent: (addr: string) => string | null,
  getSymbol: (addr: string) => string
): Map<string, string[]> {
  const children = new Map<string, string[]>()
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

