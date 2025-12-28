// Pure utility functions

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

export const TREE_W_CHARS = 24

// -----------------------------------------------------------------------------
// Text formatting
// -----------------------------------------------------------------------------

/** Pad string to width with spaces, or truncate with ellipsis */
export function padOrTruncate(str: string, width: number): string {
  if (str.length > width) {
    return str.slice(0, width - 1) + '…'
  }
  return str.padEnd(width, ' ')
}

/** Shorten an address to 0x1234...5678 format */
export function shortenAddress(address: string): string {
  if (address.length < 10) return address
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

// -----------------------------------------------------------------------------
// Tree drawing
// -----------------------------------------------------------------------------

export const BOX_VERT = '│'
export const BOX_BRANCH = '├── '
export const BOX_CORNER = '└── '
export const BOX_CORNER_UP = '┌── '
export const BOX_SPACE = '    '
export const BOX_CONT = '│   '

/** Build tree prefix for a given depth */
export function buildTreePrefix(
  depth: number,
  isLast: boolean,
  continuesBelow: boolean
): string {
  if (depth === 0) return ''
  let prefix = ''
  for (let i = 0; i < depth - 1; i++) {
    prefix += continuesBelow ? BOX_CONT : BOX_SPACE
  }
  prefix += isLast && !continuesBelow ? BOX_CORNER : BOX_BRANCH
  return prefix
}

