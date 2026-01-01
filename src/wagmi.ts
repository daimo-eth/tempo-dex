import { KeyManager, webAuthn } from "tempo.ts/wagmi";
import { tempoTestnet } from "viem/chains";
import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";

export const config = createConfig({
  chains: [tempoTestnet],
  connectors: [
    webAuthn({
      keyManager: KeyManager.localStorage(),
      // Use platform authenticator (TouchID, FaceID, password manager)
      // instead of external security keys
      createOptions: {
        authenticatorSelection: {
          authenticatorAttachment: "platform",
        },
      } as unknown as Parameters<typeof webAuthn>[0]["createOptions"],
    }),
    injected(),
  ],
  transports: {
    [tempoTestnet.id]: http(),
  },
});
