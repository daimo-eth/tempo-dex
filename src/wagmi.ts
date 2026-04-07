import { tempoWallet } from "accounts/wagmi";
import { createConfig, http } from "wagmi";
import { chain, RPC_FETCH_OPTIONS, RPC_URL } from "./config";

export const config = createConfig({
  chains: [chain],
  connectors: [tempoWallet()],
  transports: {
    [chain.id]: http(RPC_URL, {
      retryCount: 5,
      retryDelay: 150,
      fetchOptions: RPC_FETCH_OPTIONS,
    }),
  },
});
