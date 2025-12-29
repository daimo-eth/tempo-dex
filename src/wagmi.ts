import { defineChain } from "viem";
import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { KeyManager, webAuthn } from "tempo.ts/wagmi";
// Porto disabled: RpcResponse.InternalError: This Wallet does not support the requested chain ID
// import { porto } from "wagmi/connectors";

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
      url: "https://explore.tempo.xyz",
    },
  },
  testnet: true,
});

export const config = createConfig({
  chains: [tempoTestnet],
  connectors: [
    webAuthn({ keyManager: KeyManager.localStorage() }),
    injected(),
  ],
  transports: {
    [tempoTestnet.id]: http(),
  },
});
