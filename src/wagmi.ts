import { KeyManager, webAuthn } from "tempo.ts/wagmi";
import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { tempoModerato } from "./config";

export const config = createConfig({
  chains: [tempoModerato],
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
    [tempoModerato.id]: http(undefined, {
      retryCount: 5,
      retryDelay: 150,
    }),
  },
});
