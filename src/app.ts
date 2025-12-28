// Tempo DEX - Main application
// Structure: imports, constants, App wrapper, page components, subcomponents, mount

import React, { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { WagmiProvider, useAccount, useConnect, useDisconnect, useConnectors, useReadContracts, useWriteContract, useSwitchChain, useChainId } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { parseUnits, formatUnits, type Address } from 'viem'
import './style.css'
import { config, tempoTestnet } from './wagmi'
import { ROOT_TOKEN, TOKENS, tokenMeta, ERC20_ABI, ROUTER_ADDRESS, ROUTER_ABI, TOKEN_DECIMALS } from './config'
import {
  calculateSwapRoute,
  calculateOutputAmount,
  calculateAmountAtHop,
  getTokenDepth,
} from './swap'
import { TREE_W_CHARS, padOrTruncate, shortenAddress, BOX_CORNER, BOX_CORNER_UP } from './utils'

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

// Debug: set to an address to override connected wallet (null in prod)
// const DEBUG_WALLET_ADDR: Address | null = '0xc60A0A0E8bBc32DAC2E03030989AD6BEe45A874D'
const DEBUG_WALLET_ADDR: Address | null = null

// Required chain (Tempo Testnet for now; future: env var for mainnet)
const REQUIRED_CHAIN_ID = tempoTestnet.id

const queryClient = new QueryClient()

// -----------------------------------------------------------------------------
// App wrapper
// -----------------------------------------------------------------------------

function App() {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <Page />
      </QueryClientProvider>
    </WagmiProvider>
  )
}

// -----------------------------------------------------------------------------
// Page layout
// -----------------------------------------------------------------------------

function Page() {
  const { address: connectedAddress, isConnected: walletConnected } = useAccount()
  const { disconnect } = useDisconnect()
  const [showWalletOptions, setShowWalletOptions] = useState(false)
  const [fromToken, setFromToken] = useState('AlphaUSD')
  const [toToken, setToToken] = useState('BetaUSD')
  const [amount, setAmount] = useState('100')
  const [swapCount, setSwapCount] = useState(0)

  // debug override for testing balances
  const effectiveAddress = DEBUG_WALLET_ADDR ?? connectedAddress
  const isConnected = DEBUG_WALLET_ADDR ? true : walletConnected

  const handleDisconnect = () => {
    if (DEBUG_WALLET_ADDR) return // can't disconnect debug wallet
    if (window.confirm('Disconnect wallet?')) disconnect()
  }

  return (
    <main className="page">
      <header className="header">
        <h1>TEMPO DEX</h1>
        <span className="badge">testnet</span>
      </header>

      <AssetTreeBox
        fromToken={fromToken}
        toToken={toToken}
        amount={amount}
      />

      <SwapBox
        fromToken={fromToken}
        toToken={toToken}
        amount={amount}
        setFromToken={setFromToken}
        setToToken={setToToken}
        setAmount={setAmount}
        showWalletOptions={showWalletOptions}
        setShowWalletOptions={setShowWalletOptions}
        onSwapSuccess={() => setSwapCount((c) => c + 1)}
        onDisconnect={handleDisconnect}
        address={effectiveAddress}
        isConnected={isConnected}
      />

      {isConnected && effectiveAddress && (
        <HistoryBox address={effectiveAddress} refreshKey={swapCount} />
      )}
    </main>
  )
}

// -----------------------------------------------------------------------------
// AssetTreeBox
// -----------------------------------------------------------------------------

interface AssetTreeBoxProps {
  fromToken: string
  toToken: string
  amount: string
}

function AssetTreeBox({ fromToken, toToken, amount }: AssetTreeBoxProps) {
  const getParent = (addr: string) => tokenMeta[addr]?.parent ?? null
  const getSymbol = (addr: string) => tokenMeta[addr]?.symbol ?? ''

  const symbolToAddress = useMemo(() => {
    const entries = Object.values(tokenMeta).map((t) => [t.symbol, t.address])
    return Object.fromEntries(entries) as Record<string, string>
  }, [])

  const route = useMemo(() => {
    const fromAddr = symbolToAddress[fromToken]
    const toAddr = symbolToAddress[toToken]
    if (!fromAddr || !toAddr) {
      return { inputPath: [], outputPath: [], highlightNodes: new Set<string>(), hops: 0, rate: 1 }
    }
    return calculateSwapRoute(fromAddr, toAddr, ROOT_TOKEN, getParent)
  }, [fromToken, toToken, symbolToAddress])

  const renderTree = () => {
    const lines: React.ReactNode[] = []
    const parsedAmount = Number(amount) || 0
    const { inputPath, outputPath, highlightNodes } = route

    // Build hop index for amount calculation
    const hopIndex = new Map<string, number>()
    let hopCount = 0
    inputPath.forEach((addr) => { hopIndex.set(addr, hopCount); hopCount++ })
    outputPath.forEach((addr, idx) => { if (idx > 0) hopCount++; hopIndex.set(addr, hopCount) })

    // Determine INPUT/OUTPUT nodes
    const inputNode = inputPath.length > 0 ? inputPath[0] : (outputPath.length > 0 ? outputPath[0] : null)
    const outputNode = outputPath.length > 0 ? outputPath[outputPath.length - 1] : null

    // Check if path goes through pathUSD (input and output on different branches)
    const pathThroughRoot = outputPath.includes(ROOT_TOKEN)

    const addLine = (addr: string, useUpwardL: boolean) => {
      const isOnPath = highlightNodes.has(addr)
      const depth = getTokenDepth(addr, getParent)
      const symbol = getSymbol(addr)

      // Build prefix: spaces for depth, then L connector (up or down)
      let prefix = ''
      for (let i = 0; i < depth; i++) prefix += '    '
      if (depth > 0) {
        prefix = prefix.slice(0, -4) + (useUpwardL ? BOX_CORNER_UP : BOX_CORNER)
      }

      // Amount and label for on-path nodes only
      let rightCol = ''
      if (isOnPath) {
        const hop = hopIndex.get(addr) ?? 0
        const amt = calculateAmountAtHop(parsedAmount, hop)
        let label = ''
        if (addr === inputNode) label = ' INPUT'
        if (addr === outputNode && inputNode !== outputNode) label = ' OUTPUT'
        rightCol = `$${amt.toFixed(2)}${label}`
      }

      const leftCol = padOrTruncate(prefix + symbol, TREE_W_CHARS)
      lines.push(
        <div key={addr} className={`tree-line ${isOnPath ? 'on-path' : 'off-path'}`}>
          <span className="left">{leftCol}</span>
          {rightCol && <span className="right">{rightCol}</span>}
        </div>
      )
    }

    if (pathThroughRoot) {
      // Cross-branch swap: input above, pathUSD center, output below
      inputPath.forEach((addr) => addLine(addr, true))
      outputPath.forEach((addr) => addLine(addr, false))
    } else {
      // Same-branch swap: all nodes above pathUSD, ordered by depth desc
      const allNodes = [...inputPath, ...outputPath]
      allNodes.sort((a, b) => getTokenDepth(b, getParent) - getTokenDepth(a, getParent))
      allNodes.forEach((addr) => addLine(addr, true))
      addLine(ROOT_TOKEN, false) // pathUSD greyed at bottom
    }

    return lines
  }

  return (
    <section className="panel">
      <div className="panel-title">// asset tree</div>
      <div className="tree">{renderTree()}</div>
    </section>
  )
}

// -----------------------------------------------------------------------------
// SwapBox
// -----------------------------------------------------------------------------

interface SwapBoxProps {
  fromToken: string
  toToken: string
  amount: string
  setFromToken: (v: string) => void
  setToToken: (v: string) => void
  setAmount: (v: string) => void
  showWalletOptions: boolean
  setShowWalletOptions: (v: boolean) => void
  onSwapSuccess: () => void
  onDisconnect: () => void
  address: Address | undefined
  isConnected: boolean
}

function SwapBox({
  fromToken, toToken, amount,
  setFromToken, setToToken, setAmount,
  showWalletOptions, setShowWalletOptions,
  onSwapSuccess, onDisconnect,
  address, isConnected,
}: SwapBoxProps) {
  const chainId = useChainId()
  const { switchChain, isPending: isSwitching } = useSwitchChain()
  const { writeContract, isPending: isSwapPending } = useWriteContract()

  const isWrongChain = isConnected && chainId !== REQUIRED_CHAIN_ID

  const getParent = (addr: string) => tokenMeta[addr]?.parent ?? null

  const symbolToAddress = useMemo(() => {
    const entries = Object.values(tokenMeta).map((t) => [t.symbol, t.address])
    return Object.fromEntries(entries) as Record<string, string>
  }, [])

  const balanceContracts = useMemo(() => {
    if (!address) return []
    return TOKENS.map((tokenAddr) => ({
      address: tokenAddr as Address,
      abi: ERC20_ABI,
      functionName: 'balanceOf' as const,
      args: [address] as const,
    }))
  }, [address])

  const { data: balanceResults } = useReadContracts({
    contracts: balanceContracts,
    query: { enabled: isConnected && balanceContracts.length > 0 },
  })

  const balances = useMemo(() => {
    const map: Record<string, bigint> = {}
    if (balanceResults) {
      TOKENS.forEach((addr, idx) => {
        const result = balanceResults[idx]
        map[addr] = result?.status === 'success' ? (result.result as bigint) : 0n
      })
    }
    return map
  }, [balanceResults])

  const tokensByBalance = useMemo(() => {
    return Object.values(tokenMeta).sort((a, b) => {
      const balA = balances[a.address] ?? 0n
      const balB = balances[b.address] ?? 0n
      if (balB > balA) return 1
      if (balB < balA) return -1
      return a.symbol.localeCompare(b.symbol)
    })
  }, [balances])

  const tokensBySymbol = useMemo(() => {
    return Object.values(tokenMeta).sort((a, b) => a.symbol.localeCompare(b.symbol))
  }, [])

  const isNoOp = fromToken === toToken
    const fromAddress = symbolToAddress[fromToken]
  const fromBalance = fromAddress ? balances[fromAddress] ?? 0n : 0n
  const fromBalanceFormatted = Number(formatUnits(fromBalance, TOKEN_DECIMALS))
  const parsedAmount = Number(amount) || 0
  const insufficientBalance = isConnected && parsedAmount > fromBalanceFormatted

  const { route, amountOut } = useMemo(() => {
    const fromAddr = symbolToAddress[fromToken]
    const toAddr = symbolToAddress[toToken]
    if (!fromAddr || !toAddr) {
      return { route: { hops: 0, rate: 1 }, amountOut: 0 }
    }
    const r = calculateSwapRoute(fromAddr, toAddr, ROOT_TOKEN, getParent)
    const out = calculateOutputAmount(parsedAmount, r.rate)
    return { route: r, amountOut: out }
  }, [amount, fromToken, toToken, symbolToAddress, parsedAmount])

  const handleSwap = () => {
    const fromAddr = symbolToAddress[fromToken] as Address
    const toAddr = symbolToAddress[toToken] as Address
    const amountIn = parseUnits(amount, TOKEN_DECIMALS)
    const minAmountOut = parseUnits((amountOut * 0.99).toFixed(TOKEN_DECIMALS), TOKEN_DECIMALS)

    writeContract(
      {
        address: ROUTER_ADDRESS,
        abi: ROUTER_ABI,
        functionName: 'swap',
        args: [fromAddr, toAddr, amountIn, minAmountOut],
      },
      { onSuccess: onSwapSuccess }
    )
  }

  const formatBalance = (bal: bigint) => {
    const num = Number(formatUnits(bal, TOKEN_DECIMALS))
    if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M'
    if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K'
    if (num >= 1) return num.toFixed(2)
    return num.toFixed(4)
  }

  return (
      <section className="panel">
      <div className="panel-title">// swap</div>
        <div className="swap">
          <div className="row">
            <div className="field">
            <label htmlFor="fromToken">from</label>
            <select id="fromToken" value={fromToken} onChange={(e) => setFromToken(e.target.value)}>
              {(isConnected ? tokensByBalance : tokensBySymbol).map((t) => (
                <option key={t.address} value={t.symbol}>
                  {t.symbol}{isConnected ? ` (${formatBalance(balances[t.address] ?? 0n)})` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
            <label htmlFor="toToken">to</label>
            <select id="toToken" value={toToken} onChange={(e) => setToToken(e.target.value)}>
              {tokensBySymbol.map((t) => (
                <option key={t.address} value={t.symbol}>{t.symbol}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="field">
          <label htmlFor="amount">amount</label>
          <input id="amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>

          <div className="quote">
          {insufficientBalance && <div className="error">insufficient balance</div>}
          {isNoOp ? (
            <div>no-op</div>
          ) : (
            <>
              <div>rate: {route.rate.toFixed(6)} (0.3%/hop)</div>
              <div>output: {amountOut.toFixed(2)} {toToken}</div>
            </>
          )}
            </div>

        {showWalletOptions ? (
          <WalletOptions onClose={() => setShowWalletOptions(false)} />
        ) : !isConnected ? (
          <button className="btn-primary" onClick={() => setShowWalletOptions(true)}>CONNECT</button>
        ) : isWrongChain ? (
          <div className="action-section">
            <button
              className="btn-primary"
              disabled={isSwitching}
              onClick={() => switchChain({ chainId: REQUIRED_CHAIN_ID })}
            >
              {isSwitching ? 'SWITCHING...' : 'SWITCH CHAIN'}
            </button>
            <button className="btn-link" onClick={onDisconnect}>connected {shortenAddress(address!)}</button>
          </div>
        ) : (
          <div className="action-section">
            <button
              className="btn-primary"
              disabled={isNoOp || insufficientBalance || isSwapPending}
              onClick={handleSwap}
            >
              {isSwapPending ? 'SWAPPING...' : 'SWAP'}
            </button>
            <button className="btn-link" onClick={onDisconnect}>connected {shortenAddress(address!)}</button>
          </div>
        )}
      </div>
    </section>
  )
}

// -----------------------------------------------------------------------------
// HistoryBox (placeholder - spec below)
// -----------------------------------------------------------------------------

interface HistoryBoxProps {
  address: string
  refreshKey: number
}

function HistoryBox({ address, refreshKey }: HistoryBoxProps) {
  // TODO: implement trade history fetching and display
  // See spec below
  return (
    <section className="panel">
      <div className="panel-title">// trade history</div>
      <div className="history-placeholder">
        coming soon...
        </div>
      </section>
  )
}

/*
 * HistoryBox Spec
 * ===============
 *
 * Data Fetching:
 * - Use viem's getLogs() to fetch Swap events from ROUTER_ADDRESS
 * - Filter by: address === connected wallet (from args)
 * - Query params: fromBlock = earliest or recent (e.g., last 10000 blocks)
 * - Refetch when refreshKey changes (after each successful swap)
 *
 * Event signature (from ROUTER_ABI):
 *   event Swap(address indexed user, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut)
 *
 * Table columns:
 * | time       | from     | to       | amount in | amount out | tx      |
 * |------------|----------|----------|-----------|------------|---------|
 * | 2m ago     | AlphaUSD | BetaUSD  | 100.00    | 99.40      | [link]  |
 *
 * - time: relative time from block timestamp (e.g., "2m ago", "1h ago")
 * - from/to: token symbols (lookup from tokenMeta)
 * - amount in/out: formatted with 2 decimals
 * - tx: link to https://explorer.testnet.tempo.xyz/tx/{txHash}
 *
 * Implementation:
 * 1. Add Swap event to ROUTER_ABI in config.ts
 * 2. Use useEffect + viem client to fetch logs
 * 3. Parse logs, map addresses to symbols
 * 4. Sort by block number descending (newest first)
 * 5. Limit to last 20 trades
 * 6. Add CSS for .history-table with monospace styling
 */

// -----------------------------------------------------------------------------
// WalletOptions
// -----------------------------------------------------------------------------

function WalletOptions({ onClose }: { onClose: () => void }) {
  const connectors = useConnectors()
  const { connect } = useConnect()

  const filteredConnectors = useMemo(() => {
    const hasSpecificInjected = connectors.some((c) => c.type === 'injected' && c.name !== 'Injected')
    return connectors
      .filter((c) => !(c.name === 'Injected' && hasSpecificInjected))
      .sort((a, b) => {
        if (a.type === 'injected' && b.type !== 'injected') return -1
        if (a.type !== 'injected' && b.type === 'injected') return 1
        return 0
      })
  }, [connectors])

  return (
    <div className="wallet-options">
      <div className="wallet-options-title">select wallet</div>
      {filteredConnectors.map((connector) => (
        <button
          key={connector.uid}
          className="btn-connector"
          onClick={() => { connect({ connector }); onClose() }}
        >
          {connector.name}
        </button>
      ))}
      <button className="btn-link" onClick={onClose}>cancel</button>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Mount
// -----------------------------------------------------------------------------

const root = createRoot(document.getElementById('app') as HTMLElement)
root.render(<App />)
