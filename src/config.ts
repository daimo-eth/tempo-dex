import type { Address } from 'viem'

export const ROOT_TOKEN: Address = '0x20c0000000000000000000000000000000000000'

// Token decimals (all Tempo stablecoins use 6)
export const TOKEN_DECIMALS = 6

// Minimal ERC20 ABI for balance reading
export const ERC20_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

// Mock router address for swap transactions
export const ROUTER_ADDRESS: Address = '0x20c0000000000000000000000000000000000999'

// Router ABI for swap
export const ROUTER_ABI = [
  {
    name: 'swap',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOut', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'minAmountOut', type: 'uint256' },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const

export const TOKENS: readonly Address[] = [
  ROOT_TOKEN,
  '0x20c0000000000000000000000000000000000001',
  '0x20c0000000000000000000000000000000000002',
  '0x20c0000000000000000000000000000000000003',
  '0x20c0000000000000000000000000000000000004',
]

export interface TokenMeta {
  address: Address
  addressShort: string
  symbol: string
  parent: Address | null
}

export const tokenMeta: Record<Address, TokenMeta> = {
  [ROOT_TOKEN]: {
    address: ROOT_TOKEN,
    addressShort: '0x20c0...0000',
    symbol: 'pathUSD',
    parent: null,
  },
  '0x20c0000000000000000000000000000000000001': {
    address: '0x20c0000000000000000000000000000000000001',
    addressShort: '0x20c0...0001',
    symbol: 'AlphaUSD',
    parent: ROOT_TOKEN,
  },
  '0x20c0000000000000000000000000000000000002': {
    address: '0x20c0000000000000000000000000000000000002',
    addressShort: '0x20c0...0002',
    symbol: 'BetaUSD',
    parent: ROOT_TOKEN,
  },
  '0x20c0000000000000000000000000000000000003': {
    address: '0x20c0000000000000000000000000000000000003',
    addressShort: '0x20c0...0003',
    symbol: 'GammaUSD',
    parent: '0x20c0000000000000000000000000000000000001',
  },
  '0x20c0000000000000000000000000000000000004': {
    address: '0x20c0000000000000000000000000000000000004',
    addressShort: '0x20c0...0004',
    symbol: 'DeltaUSD',
    parent: '0x20c0000000000000000000000000000000000002',
  },
}
