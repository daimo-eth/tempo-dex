import { tempoWallet } from "accounts/wagmi";
import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { chain, RPC_FETCH_OPTIONS, RPC_URL } from "./config";

/** rdns of the Tempo Wallet dialog connector from `accounts/wagmi`. */
export const TEMPO_CONNECTOR_ID = "xyz.tempo";

export const config = createConfig({
  chains: [chain],
  connectors: [tempoWallet(), injected()],
  transports: {
    [chain.id]: http(RPC_URL, {
      retryCount: 5,
      retryDelay: 150,
      fetchOptions: RPC_FETCH_OPTIONS,
    }),
  },
});
