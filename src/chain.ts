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
import {
  encodeFunctionData,
  erc20Abi,
  maxUint256,
  numberToHex,
} from "viem";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useReadContracts,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { chain, DEX_ABI, DEX_ADDRESS } from "./config";
import {
  fetchBlockNumber,
  fetchPairLiquidity,
  fetchQuote,
  type PairLiquidity,
} from "./data";
import { fetchSwapHistory, type SwapSummary } from "./indexSupply";
import { getTokenState } from "./tokens";
import type { Quote, QuoteState } from "./types";
import { TEMPO_CONNECTOR_ID } from "./wagmi";

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

/**
 * Allowance for `owner` granting `spender` to spend `token`, keyed on the
 * chain head. Spender defaults to the DEX.
 */
export function useAllowance(
  token: Address,
  owner: Address | undefined,
  spender: Address = DEX_ADDRESS
) {
  const { data: blockNumber } = useChainHead();

  useEffect(() => {
    if (owner && blockNumber !== undefined) {
      console.log(
        "[allowance] fetching as of block",
        blockNumber.toString()
      );
    }
  }, [owner, blockNumber, token]);

  return useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: owner ? [owner, spender] : undefined,
    blockNumber,
    query: {
      enabled: !!owner && blockNumber !== undefined,
      placeholderData: keepPreviousData,
      staleTime: Infinity,
    },
  });
}

// -----------------------------------------------------------------------------
// Quote (DEX read, keyed on chain head)
// -----------------------------------------------------------------------------

/**
 * Quote a swap from `from` to `to` of `amountIn` units, keyed on the chain
 * head. Returns the legacy QuoteState shape so consumers don't have to learn
 * React Query internals. Caller is responsible for debouncing the inputs
 * (see `useDebouncedValue`).
 */
export function useQuote(
  from: Address | null,
  to: Address | null,
  amountIn: bigint
): QuoteState {
  const { data: blockNumber } = useChainHead();

  const enabled =
    !!from &&
    !!to &&
    from !== to &&
    amountIn > 0n &&
    blockNumber !== undefined;

  const result = useQuery<Quote, Error>({
    queryKey: [
      "quote",
      from,
      to,
      amountIn.toString(),
      blockNumber?.toString(),
    ],
    queryFn: async () => {
      if (!from || !to || blockNumber === undefined) {
        throw new Error("disabled query ran");
      }
      console.log("[quote] fetching as of block", blockNumber.toString());
      const r = await fetchQuote(from, to, amountIn, blockNumber);
      if ("error" in r) throw new Error(r.error);
      return r.quote;
    },
    enabled,
    placeholderData: keepPreviousData,
    staleTime: Infinity,
  });

  // Translate to the legacy QuoteState shape. On error, drop data so the UI
  // doesn't render a stale path next to a fresh error.
  return useMemo<QuoteState>(() => {
    if (from && to && from === to) {
      return { loading: false, error: "same token (no-op)", data: null };
    }
    if (result.error) {
      return {
        loading: result.isFetching,
        error: result.error.message,
        data: null,
      };
    }
    return {
      loading: result.isFetching,
      error: null,
      data: result.data ?? null,
    };
  }, [from, to, result.isFetching, result.error, result.data]);
}

// -----------------------------------------------------------------------------
// Swap history (Index Supply, keyed on chain head)
// -----------------------------------------------------------------------------

/** Swap history for `address`, keyed on the chain head. */
export function useSwapHistory(
  address: Address | undefined
): UseQueryResult<SwapSummary[]> {
  const { data: blockNumber } = useChainHead();
  return useQuery<SwapSummary[]>({
    queryKey: ["history", address, blockNumber?.toString()],
    queryFn: async () => {
      if (!address || blockNumber === undefined) {
        throw new Error("disabled query ran");
      }
      console.log("[history] fetching as of block", blockNumber.toString());
      return fetchSwapHistory(address, blockNumber, 20);
    },
    enabled: !!address && blockNumber !== undefined,
    placeholderData: keepPreviousData,
    staleTime: Infinity,
  });
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
  /** Detail pending flags for individual button states. */
  isApprovePending: boolean;
  isSwapPending: boolean;
  isBatchedPending: boolean;
  /** True if any tx is currently in flight (submission or confirmation). */
  isPending: boolean;
  /** True if the connected wallet supports our atomic batched submit path. */
  supportsBatchedCalls: boolean;
  /** Fire an infinite ERC-20 approval for the DEX. */
  approve: (token: Address) => void;
  /** Submit a non-batched swap (caller has already approved). */
  swap: (params: SwapParams) => void;
  /** Submit an atomic batched approve+swap via the Tempo Wallet dialog. */
  batchedSwap: (params: SwapParams, needsApproval: boolean) => Promise<void>;
  /** Clear `result` (e.g. when inputs change or user clicks "continue"). */
  reset: () => void;
}

/**
 * Encapsulates all swap-related transaction state and side effects:
 *   - Approve write + receipt wait
 *   - Non-batched swap write + receipt wait + success messaging
 *   - Batched (Tempo) atomic approve+swap via direct provider call
 *   - Cascading chain refresh on every confirmation so balances/allowance/
 *     history/quote refetch in lockstep
 *   - Logging the landing block of every successful swap
 *
 * The hook is connector-agnostic — `supportsBatchedCalls` tells the caller
 * which submit path to expose in the UI.
 */
export function useSubmitSwap(): SubmitSwap {
  const { address, connector } = useAccount();
  const publicClient = usePublicClient();
  const chainRefresh = useChainRefresh();

  const supportsBatchedCalls =
    !!connector && connector.id === TEMPO_CONNECTOR_ID;

  const [result, setResult] = useState<SwapResult>(null);
  const [pendingParams, setPendingParams] = useState<SwapParams | null>(null);
  const [isBatchedPending, setIsBatchedPending] = useState(false);

  // Approve flow ---------------------------------------------------------
  const approveWrite = useWriteContract();
  const { isLoading: isApproveConfirming } = useWaitForTransactionReceipt({
    hash: approveWrite.data,
    query: { enabled: !!approveWrite.data },
  });

  useEffect(() => {
    if (approveWrite.data && !isApproveConfirming && approveWrite.isSuccess) {
      // Cascade refresh: chain head bumps → allowance refetches.
      chainRefresh();
    }
  }, [
    approveWrite.data,
    isApproveConfirming,
    approveWrite.isSuccess,
    chainRefresh,
  ]);

  const approve = useCallback(
    (token: Address) => {
      console.log("[approve] called", { token, spender: DEX_ADDRESS });
      approveWrite.writeContract(
        {
          address: token,
          abi: erc20Abi,
          functionName: "approve",
          // Infinite approval so the user only approves once per token.
          args: [DEX_ADDRESS, maxUint256],
        },
        {
          onError: (error) => {
            console.error("[approve] error", error);
          },
        }
      );
    },
    [approveWrite]
  );

  // Non-batched swap flow ------------------------------------------------
  const swapWrite = useWriteContract();
  const { data: swapReceipt, isLoading: isSwapConfirming } =
    useWaitForTransactionReceipt({
      hash: swapWrite.data,
      query: { enabled: !!swapWrite.data },
    });

  useEffect(() => {
    if (
      swapWrite.data &&
      !isSwapConfirming &&
      swapWrite.isSuccess &&
      pendingParams
    ) {
      setResult({
        type: "success",
        fromAmount: pendingParams.fromAmount,
        fromSymbol: pendingParams.fromSymbol,
        toAmount: pendingParams.toAmount,
        toSymbol: pendingParams.toSymbol,
      });
      if (swapReceipt) {
        console.log(
          "[swap] landed in block",
          swapReceipt.blockNumber.toString()
        );
      }
      // Cascade refresh: chain head bumps → balances, allowance, history,
      // and quote all refetch automatically off the new key.
      chainRefresh();
    }
  }, [
    swapWrite.data,
    isSwapConfirming,
    swapWrite.isSuccess,
    swapReceipt,
    pendingParams,
    chainRefresh,
  ]);

  const swap = useCallback(
    (params: SwapParams) => {
      console.log("[swap] called", {
        fromToken: params.fromToken,
        toToken: params.toToken,
        amountIn: params.amountIn.toString(),
        minAmountOut: params.minAmountOut.toString(),
      });
      if (params.amountIn === 0n) return;
      setPendingParams(params);
      setResult(null);
      swapWrite.writeContract(
        {
          address: DEX_ADDRESS,
          abi: DEX_ABI,
          functionName: "swapExactAmountIn",
          args: [
            params.fromToken,
            params.toToken,
            params.amountIn,
            params.minAmountOut,
          ],
        },
        {
          onError: (error) => {
            console.error("[swap] error", error);
            setResult({
              type: "error",
              message: error.message || "swap failed",
            });
          },
        }
      );
    },
    [swapWrite]
  );

  // Batched swap flow (Tempo Wallet) -------------------------------------
  //
  // The `accounts` SDK does NOT honor `feeToken` as a `wallet_sendCalls`
  // capability — its schema strips it. Instead, the Tempo
  // `eth_sendTransaction` request format accepts both `calls` (for atomic
  // batching) and `feeToken` (for ERC-20 gas payment), so we bypass
  // `useSendCalls` and call the connector's provider directly. This lets
  // brand-new accounts swap without holding any native gas token.
  const batchedSwap = useCallback(
    async (params: SwapParams, needsApproval: boolean) => {
      console.log("[batchedSwap] called", {
        fromToken: params.fromToken,
        toToken: params.toToken,
        amountIn: params.amountIn.toString(),
        minAmountOut: params.minAmountOut.toString(),
        needsApproval,
      });

      if (params.amountIn === 0n || !connector || !address) return;

      const calls: { to: Address; data: `0x${string}` }[] = [];
      if (needsApproval) {
        calls.push({
          to: params.fromToken,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [DEX_ADDRESS, params.amountIn],
          }),
        });
      }
      calls.push({
        to: DEX_ADDRESS,
        data: encodeFunctionData({
          abi: DEX_ABI,
          functionName: "swapExactAmountIn",
          args: [
            params.fromToken,
            params.toToken,
            params.amountIn,
            params.minAmountOut,
          ],
        }),
      });
      console.log("[batchedSwap] calls:", calls.length);

      setResult(null);
      setIsBatchedPending(true);

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
        console.log("[batchedSwap] tx hash", hash);

        // Wait for receipt so we can log the landing block and ensure
        // success state reflects an actually mined tx.
        if (publicClient) {
          const receipt = await publicClient.waitForTransactionReceipt({
            hash,
          });
          console.log(
            "[swap] landed in block",
            receipt.blockNumber.toString()
          );
        }

        setResult({
          type: "success",
          fromAmount: params.fromAmount,
          fromSymbol: params.fromSymbol,
          toAmount: params.toAmount,
          toSymbol: params.toSymbol,
        });
        // Cascade refresh: chain head bumps → balances, allowance, history,
        // and quote all refetch automatically off the new key.
        await chainRefresh();
      } catch (error) {
        console.error("[batchedSwap] error", error);
        const message =
          error instanceof Error ? error.message : "swap failed";
        setResult({ type: "error", message });
      } finally {
        setIsBatchedPending(false);
      }
    },
    [connector, address, publicClient, chainRefresh]
  );

  const reset = useCallback(() => setResult(null), []);

  const isApprovePending = approveWrite.isPending || isApproveConfirming;
  const isSwapPending = swapWrite.isPending || isSwapConfirming;
  const isPending = isApprovePending || isSwapPending || isBatchedPending;

  return {
    result,
    isApprovePending,
    isSwapPending,
    isBatchedPending,
    isPending,
    supportsBatchedCalls,
    approve,
    swap,
    batchedSwap,
    reset,
  };
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
