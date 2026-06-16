# Tempo DEX UI

Experimental web UI for Tempo's tree-structured stablecoin CLOB DEX.

## Prerequisites

- Node.js and npm
- A wallet or account that can connect to the selected Tempo network
- Optional: a custom Tempo RPC endpoint

## Configuration

The app reads its network settings at build time through the esbuild
`--define` flags in `package.json`.

Copy `.env.example` to `.env`, or export the variables in your shell before
running a script:

```sh
TEMPO_NETWORK=mainnet
TEMPO_RPC_URL=
```

`TEMPO_NETWORK` controls the chain selection:

- `mainnet` uses Tempo mainnet and is the default when the value is empty.
- `moderato` uses Tempo Moderato testnet.

`TEMPO_RPC_URL` is optional. When it is omitted, the app uses the default RPC
URL from the `viem` chain definition. If the URL includes basic auth
credentials, `src/config.ts` removes them from the browser URL and forwards
them as an `Authorization` header.

Restart the dev server or rebuild after changing either variable.

## Development

Install dependencies from the lockfile:

```sh
npm ci
```

Start the local dev server:

```sh
npm run dev
```

Then open:

```text
http://localhost:8080
```

To run against Moderato testnet:

```sh
TEMPO_NETWORK=moderato npm run dev
```

## Build And Serve

Create a production bundle:

```sh
npm run build
```

Serve the built files from `public/`:

```sh
npm start
```

`npm start` uses port `8080` by default. Set `PORT` to override it:

```sh
PORT=3000 npm start
```

## Validation

Run the typecheck and unit tests:

```sh
npm test
```

Run only the TypeScript check:

```sh
npm run typecheck
```

## Implementation Notes

- Chain selection, RPC handling, explorer URLs, and DEX addresses are defined
  in `src/config.ts`.
- Token metadata is loaded from the chain-specific tokenlist at
  `https://tempoxyz.github.io/tempo-apps/<chain-id>/tokenlist.json`.
- Canonical Tempo addresses and ABIs come from `viem/tempo`.
