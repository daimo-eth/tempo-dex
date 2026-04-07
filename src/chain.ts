// Centralized chain data layer.
//
// Single source of truth: useChainHead returns the canonical block number,
// polled every 5s and shown in the header. Every other read in this file
// includes that block number in its query key, so when the head ticks (or is
// fast-forwarded after a swap via useChainRefresh), all dependent queries
// auto-refetch in lockstep. With placeholderData: keepPreviousData, the UI
// keeps showing the previous data while the next read is in flight, so there
// is no flicker on tick.

import {
  keepPreviousData,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import { encodeFunctionData, erc20Abi, numberToHex } from "viem";
import { Actions as TempoActions } from "viem/tempo";
import { useAccount, usePublicClient, useReadContracts } from "wagmi";
import { chain } from "./config";
import {
  estimateGasReserve,
  fetchBlockNumber,
  fetchPairLiquidity,
  fetchQuote,
  fetchSwapHistory,
  type PairLiquidity,
  type SwapSummary,
} from "./data";
import { getTokenState } from "./tokens";
import type { Quote, QuoteState } from "./types";
import { classifySwapError } from "./utils";

// -----------------------------------------------------------------------------
// Chain head — the single source of truth
// -----------------------------------------------------------------------------

const CHAIN_HEAD_KEY = ["chain", "head"] as const;
const POLL_INTERVAL_MS = 5000;

/**
 * The canonical chain head block number, polled every 5s. Displayed in the
 * header and used as a key dependency by every other hook in this file.
 */
export function useChainHead(): UseQueryResult<bigint> {
  return useQuery({
    queryKey: CHAIN_HEAD_KEY,
    queryFn: fetchBlockNumber,
    refetchInterval: POLL_INTERVAL_MS,
    staleTime: POLL_INTERVAL_MS,
  });
}

/**
 * Returns a function that fast-forwards the chain head by fetching a fresh
 * block number and writing it into the cache. All hooks that depend on
 * useChainHead will re-key and refetch automatically. Resolves with the new
 * block number so callers can log/coordinate.
 */
export function useChainRefresh(): () => Promise<bigint> {
  const queryClient = useQueryClient();
  return useCallback(async () => {
    const newBlock = await fetchBlockNumber();
    queryClient.setQueryData<bigint>(CHAIN_HEAD_KEY, newBlock);
    console.log("[chain] refreshed to block", newBlock.toString());
    return newBlock;
  }, [queryClient]);
}

// -----------------------------------------------------------------------------
// Balances and allowance (wagmi-managed, keyed on chain head)
// -----------------------------------------------------------------------------

/** All ERC-20 balances for `address`, keyed on the chain head. */
export function useBalances(address: Address | undefined) {
  const { data: blockNumber } = useChainHead();
  const { tokens } = getTokenState();

  const contracts = useMemo(() => {
    if (!address) return [];
    return tokens.map((tokenAddr) => ({
      address: tokenAddr,
      abi: erc20Abi,
      functionName: "balanceOf" as const,
      args: [address] as const,
    }));
  }, [address, tokens]);

  useEffect(() => {
    if (address && blockNumber !== undefined) {
      console.log(
        "[balances] fetching as of block",
        blockNumber.toString()
      );
    }
  }, [address, blockNumber]);

  const result = useReadContracts({
    contracts,
    blockNumber,
    query: {
      enabled:
        !!address && blockNumber !== undefined && contracts.length > 0,
      placeholderData: keepPreviousData,
      staleTime: Infinity,
    },
  });

  const balances = useMemo(() => {
    const map: Record<Address, bigint> = {};
    if (result.data) {
      tokens.forEach((addr, idx) => {
        const r = result.data?.[idx];
        map[addr] = r?.status === "success" ? (r.result as bigint) : 0n;
      });
    }
    return map;
  }, [result.data, tokens]);

  return { ...result, balances };
}

// -----------------------------------------------------------------------------
// Quote (DEX read, keyed on chain head)
// -----------------------------------------------------------------------------

/**
 * Quote a swap from `from` to `to` of `amountIn` units, keyed on the chain
 * head. Returns the legacy QuoteState shape so consumers don't have to learn
 * React Query internals.
 *
 * Debouncing is handled INSIDE this hook (the queryKey uses a debounced
 * copy of `amountIn`) so callers can pass the immediate input value and
 * remain the single source of truth — there's no second `debouncedAmount`
 * state to drift out of sync. Empty input (`amountIn === 0n`) bypasses the
 * debounce and clears the displayed quote on the same render.
 */
export function useQuote(
  from: Address | null,
  to: Address | null,
  amountIn: bigint
): QuoteState {
  const { data: blockNumber } = useChainHead();

  // Debounce only what fires the network request. Skip the debounce when
  // the input is empty so the previous quote clears immediately rather
  // than lingering for 300ms.
  const debouncedAmountIn = useDebouncedValue(
    amountIn,
    amountIn === 0n ? 0 : 300
  );

  const enabled =
    !!from &&
    !!to &&
    from !== to &&
    debouncedAmountIn > 0n &&
    blockNumber !== undefined;

  const result = useQuery<Quote, Error>({
    queryKey: [
      "quote",
      from,
      to,
      debouncedAmountIn.toString(),
      blockNumber?.toString(),
    ],
    queryFn: async () => {
      if (!from || !to || blockNumber === undefined) {
        throw new Error("disabled query ran");
      }
      console.log("[quote] fetching as of block", blockNumber.toString());
      const r = await fetchQuote(from, to, debouncedAmountIn, blockNumber);
      if ("error" in r) throw new Error(r.error);
      return r.quote;
    },
    enabled,
    placeholderData: keepPreviousData,
    staleTime: Infinity,
  });

  // Translate to the legacy QuoteState shape. On error, drop data so the UI
  // doesn't render a stale path next to a fresh error. On empty input,
  // also drop data — checked against the IMMEDIATE amountIn (not the
  // debounced one) so the swap form clears the moment the user empties
  // the input box.
  //
  // We also drop the cached `result.data` whenever it doesn't match the
  // CURRENT (immediate) input — otherwise, during the 300ms debounce
  // window or while the network refetch is in flight after a token
  // change, the UI would render the previous quote's amounts against
  // the new input. The Quote object self-describes its inputs, so we
  // can detect staleness with a direct comparison. Block-tick refetches
  // still benefit from `keepPreviousData`: same from/to/amountIn → the
  // cached data is considered fresh and shown without flicker.
  return useMemo<QuoteState>(() => {
    if (from && to && from === to) {
      return { loading: false, error: "same token (no-op)", data: null };
    }
    if (amountIn === 0n) {
      return { loading: false, error: null, data: null };
    }
    if (result.error) {
      return {
        loading: result.isFetching,
        error: result.error.message,
        data: null,
      };
    }
    const dataMatchesInput =
      !!result.data &&
      result.data.fromToken === from &&
      result.data.toToken === to &&
      result.data.amountIn === amountIn;
    return {
      loading: result.isFetching || !dataMatchesInput,
      error: null,
      data: dataMatchesInput ? result.data : null,
    };
  }, [from, to, amountIn, result.isFetching, result.error, result.data]);
}

// -----------------------------------------------------------------------------
// Swap history (Index Supply, keyed on chain head)
// -----------------------------------------------------------------------------

/**
 * Swap history for `address`. Refetches on every chain-head tick via an
 * effect rather than via the queryKey, so the cache entry is shared across
 * mounts: tabbing away from /dex and back doesn't blow away the cached
 * swaps and re-show the "no trades yet" placeholder.
 */
export function useSwapHistory(
  address: Address | undefined
): UseQueryResult<SwapSummary[]> {
  const { data: blockNumber } = useChainHead();
  const queryClient = useQueryClient();

  const result = useQuery<SwapSummary[]>({
    queryKey: ["history", address],
    queryFn: async () => {
      if (!address || blockNumber === undefined) {
        throw new Error("disabled query ran");
      }
      console.log("[history] fetching as of block", blockNumber.toString());
      return fetchSwapHistory(address, blockNumber);
    },
    enabled: !!address && blockNumber !== undefined,
    placeholderData: keepPreviousData,
    staleTime: Infinity,
  });

  // staleTime: Infinity means the query won't auto-refetch on its own; we
  // explicitly invalidate it whenever the chain head moves. invalidateQueries
  // triggers a refetch with the latest queryFn closure (which captures the
  // current blockNumber).
  useEffect(() => {
    if (!address || blockNumber === undefined) return;
    queryClient.invalidateQueries({ queryKey: ["history", address] });
  }, [address, blockNumber, queryClient]);

  return result;
}

// -----------------------------------------------------------------------------
// Pair liquidity (DEX orderbook, keyed on chain head)
// -----------------------------------------------------------------------------

type PairLiquidityResult = PairLiquidity | { error: string };

/** Pair liquidity for `token`, keyed on the chain head. */
export function usePairLiquidity(
  token: Address | null
): UseQueryResult<PairLiquidityResult> {
  const { data: blockNumber } = useChainHead();
  return useQuery<PairLiquidityResult>({
    queryKey: ["pair-liquidity", token, blockNumber?.toString()],
    queryFn: async () => {
      if (!token || blockNumber === undefined) {
        throw new Error("disabled query ran");
      }
      console.log(
        "[pair-liquidity] fetching as of block",
        blockNumber.toString()
      );
      return fetchPairLiquidity(token, blockNumber);
    },
    enabled: !!token && blockNumber !== undefined,
    placeholderData: keepPreviousData,
    staleTime: Infinity,
  });
}

// -----------------------------------------------------------------------------
// Max swappable amount (gas reserve)
// -----------------------------------------------------------------------------

// Conservative fallback if eth_estimateGas fails — e.g. for a brand-new
// account that has zero balance and so the simulation reverts. In the
// from-token's smallest unit; 50000n at 6 decimals = $0.05.
const GAS_RESERVE_FALLBACK = 50_000n;

/**
 * Compute the maximum amount the user can swap given their balance and
 * the gas headroom needed for the swap tx itself. On Tempo the batched
 * swap pays gas in `feeToken: fromToken`, so the user effectively needs
 * `balance ≥ amountIn + gasReserve`. Returning `maxSwappable = balance -
 * gasReserve` lets both the MAX button and the insufficient-balance
 * check use the same value.
 *
 * The reserve is `eth_estimateGas × maxFeePerGas × 1.5` (the 50% buffer
 * absorbs gas-price drift between estimation and submission, plus the
 * approve overhead when bundled). On any estimation failure we fall
 * back to GAS_RESERVE_FALLBACK so the form stays usable.
 */
export function useMaxSwappable(
  fromToken: Address | undefined,
  toToken: Address | undefined,
  address: Address | undefined,
  balance: bigint
): { maxSwappable: bigint; gasReserve: bigint } {
  const { data: blockNumber } = useChainHead();

  const { data: gasReserve = GAS_RESERVE_FALLBACK } = useQuery<bigint>({
    queryKey: [
      "gas-reserve",
      fromToken,
      toToken,
      address,
      blockNumber?.toString(),
    ],
    queryFn: async () => {
      if (!fromToken || !toToken || !address) return GAS_RESERVE_FALLBACK;
      try {
        return await estimateGasReserve(fromToken, toToken, address);
      } catch (err) {
        console.warn("[gas] estimation failed, using fallback", err);
        return GAS_RESERVE_FALLBACK;
      }
    },
    enabled:
      !!fromToken &&
      !!toToken &&
      !!address &&
      blockNumber !== undefined,
    placeholderData: keepPreviousData,
    staleTime: Infinity,
  });

  const maxSwappable = balance > gasReserve ? balance - gasReserve : 0n;
  return { maxSwappable, gasReserve };
}

// -----------------------------------------------------------------------------
// Submit swap (write path)
// -----------------------------------------------------------------------------

/** Inputs to a swap submission. */
export interface SwapParams {
  fromToken: Address;
  toToken: Address;
  amountIn: bigint;
  minAmountOut: bigint;
  // Pre-formatted display strings, captured at submit time so the success
  // message reflects what the user actually swapped (not whatever's in the
  // form by the time the receipt arrives).
  fromAmount: string;
  fromSymbol: string;
  toAmount: string;
  toSymbol: string;
}

/** Outcome of the most recent submit attempt. */
export type SwapResult =
  | {
      type: "success";
      fromAmount: string;
      fromSymbol: string;
      toAmount: string;
      toSymbol: string;
    }
  | { type: "error"; message: string }
  | null;

/** Public surface returned by `useSubmitSwap`. */
export interface SubmitSwap {
  /** Latest result; null until the user submits anything. */
  result: SwapResult;
  /** True while a tx is in flight (submission or confirmation). */
  isPending: boolean;
  /** Submit an atomic batched approve+swap via the Tempo Wallet dialog. */
  submit: (params: SwapParams) => Promise<void>;
  /** Clear `result` (e.g. when inputs change or user clicks "continue"). */
  reset: () => void;
}

/**
 * Submits an atomic approve+swap batch via the Tempo Wallet dialog.
 *
 * The `accounts` SDK strips `feeToken` from `wallet_sendCalls`
 * capabilities, so we bypass `useSendCalls` and call the connector's
 * provider directly. Tempo's `eth_sendTransaction` accepts both `calls`
 * (atomic batching) and `feeToken` (ERC-20 gas payment), letting brand
 * new accounts swap without holding any native gas token.
 *
 * After the receipt lands we cascade-refresh the chain head twice (now,
 * and ~2.5s later) so balances / history / quote refetch in lockstep —
 * the second pass catches the case where the indexer was still behind
 * on the first.
 */
export function useSubmitSwap(): SubmitSwap {
  const { address, connector } = useAccount();
  const publicClient = usePublicClient();
  const chainRefresh = useChainRefresh();

  const [result, setResult] = useState<SwapResult>(null);
  const [isPending, setIsPending] = useState(false);

  const submit = useCallback(
    async (params: SwapParams) => {
      console.log("[submit] called", {
        fromToken: params.fromToken,
        toToken: params.toToken,
        amountIn: params.amountIn.toString(),
        minAmountOut: params.minAmountOut.toString(),
      });

      if (params.amountIn === 0n || !connector || !address) return;

      // Build the swap calldata via the official Tempo SDK helper so the
      // ABI and arg shape stay in lockstep with viem/tempo.
      const sellCall = TempoActions.dex.sell.call({
        tokenIn: params.fromToken,
        tokenOut: params.toToken,
        amountIn: params.amountIn,
        minAmountOut: params.minAmountOut,
      });

      // Always bundle a per-call approve atomically with the swap. This
      // is cheaper than tracking allowance state across renders, and the
      // approval doesn't persist beyond this tx.
      const calls = [
        {
          to: params.fromToken,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [sellCall.to, params.amountIn],
          }),
        },
        { to: sellCall.to, data: sellCall.data },
      ];

      setResult(null);
      setIsPending(true);

      try {
        // Tempo's eth_sendTransaction accepts a `calls` array for atomic
        // batching and a `feeToken` field for ERC-20 gas payment. Neither
        // is part of the standard EIP-1193 type, so we cast loosely.
        const provider = (await connector.getProvider()) as {
          request: (args: {
            method: string;
            params: unknown[];
          }) => Promise<`0x${string}`>;
        };
        const hash = await provider.request({
          method: "eth_sendTransaction",
          params: [
            {
              from: address,
              calls,
              feeToken: params.fromToken,
              chainId: numberToHex(chain.id),
            },
          ],
        });
        console.log("[submit] tx hash", hash);

        if (publicClient) {
          const receipt = await publicClient.waitForTransactionReceipt({
            hash,
          });
          console.log("[submit] landed in block", receipt.blockNumber.toString());
        }

        setResult({
          type: "success",
          fromAmount: params.fromAmount,
          fromSymbol: params.fromSymbol,
          toAmount: params.toAmount,
          toSymbol: params.toSymbol,
        });
        await chainRefresh();
        setTimeout(() => {
          void chainRefresh();
        }, 2500);
      } catch (error) {
        console.error("[submit] error", error);
        setResult({ type: "error", message: classifySwapError(error) });
      } finally {
        setIsPending(false);
      }
    },
    [connector, address, publicClient, chainRefresh]
  );

  const reset = useCallback(() => setResult(null), []);

  return { result, isPending, submit, reset };
}

// -----------------------------------------------------------------------------
// Generic helpers
// -----------------------------------------------------------------------------

/** Returns `value` after it has been stable for `delayMs` ms. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}
