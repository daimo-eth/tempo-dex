import { KeyManager, webAuthn } from "tempo.ts/wagmi";
import { tempoTestnet } from "viem/chains";
import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";

export const config = createConfig({
  chains: [tempoTestnet],
  connectors: [webAuthn({ keyManager: KeyManager.localStorage() }), injected()],
  transports: {
    [tempoTestnet.id]: http(),
  },
});
