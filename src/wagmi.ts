import { defineChain } from "viem";
import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
// TODO: re-enable webAuthn once domain is configured
// import { KeyManager, webAuthn } from "tempo.ts/wagmi";

export const tempoTestnet = defineChain({
  id: 42429,
  name: "Tempo Testnet",
  nativeCurrency: {
    name: "ETH",
    symbol: "ETH",
    decimals: 18,
  },
  rpcUrls: {
    default: { http: ["https://rpc.testnet.tempo.xyz"] },
  },
  blockExplorers: {
    default: {
      name: "Tempo Explorer",
      url: "https://explorer.tempo.xyz",
    },
  },
  testnet: true,
});

export const config = createConfig({
  chains: [tempoTestnet],
  connectors: [
    // webAuthn({ keyManager: KeyManager.localStorage() }),
    injected(),
  ],
  transports: {
    [tempoTestnet.id]: http(),
  },
});
