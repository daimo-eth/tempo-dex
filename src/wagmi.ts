import { createConfig, http } from 'wagmi'
import { defineChain } from 'viem'
import { injected, porto } from 'wagmi/connectors'

export const tempoTestnet = defineChain({
  id: 1088_2024,
  name: 'Tempo Testnet',
  nativeCurrency: {
    name: 'ETH',
    symbol: 'ETH',
    decimals: 18,
  },
  rpcUrls: {
    default: { http: ['https://rpc.testnet.tempo.xyz'] },
  },
  blockExplorers: {
    default: { name: 'Tempo Explorer', url: 'https://explorer.testnet.tempo.xyz' },
  },
  testnet: true,
})

export const config = createConfig({
  chains: [tempoTestnet],
  connectors: [
    injected(),
    porto(),
  ],
  transports: {
    [tempoTestnet.id]: http(),
  },
})
