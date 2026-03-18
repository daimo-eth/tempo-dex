import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { KeyManager, webAuthn } from "wagmi/tempo";
import { chain, RPC_URL } from "./config";

export const config = createConfig({
  chains: [chain],
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
    [chain.id]: http(RPC_URL, {
      retryCount: 5,
      retryDelay: 150,
    }),
  },
});
