import React, { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './style.css'
import { ROOT_TOKEN, TOKENS, tokenMeta } from './config'

function getPathToRoot(address: string) {
  const path: string[] = []
  let current: string | null = address
  while (current) {
    path.push(current)
    current = tokenMeta[current]?.parent ?? null
  }
  return path
}

function App() {
  const [fromToken, setFromToken] = useState('AlphaUSD')
  const [toToken, setToToken] = useState('BetaUSD')
  const [amount, setAmount] = useState('100')

  const symbolToAddress = useMemo(() => {
    const entries = Object.values(tokenMeta).map((token) => [token.symbol, token.address])
    return Object.fromEntries(entries) as Record<string, string>
  }, [])

  const tokensBySymbol = useMemo(() => {
    return Object.values(tokenMeta)
      .filter((token) => token.address !== ROOT_TOKEN)
      .sort((a, b) => a.symbol.localeCompare(b.symbol))
  }, [])

  const tree = useMemo(() => {
    const children = new Map<string, string[]>()
    TOKENS.forEach((address) => {
      const parent = tokenMeta[address]?.parent
      if (!parent) return
      const list = children.get(parent) ?? []
      list.push(address)
      children.set(parent, list)
    })
    children.forEach((list, key) => {
      list.sort((a, b) => tokenMeta[a].symbol.localeCompare(tokenMeta[b].symbol))
      children.set(key, list)
    })
    return children
  }, [])

  const { highlightNodes, pathSymbols, rate, amountOut } = useMemo(() => {
    const fromAddress = symbolToAddress[fromToken]
    const toAddress = symbolToAddress[toToken]
    if (!fromAddress || !toAddress) {
      return {
        highlightNodes: new Set<string>(),
        pathSymbols: [],
        rate: 1,
        amountOut: 0,
      }
    }

    const pathA = getPathToRoot(fromAddress)
    const pathB = getPathToRoot(toAddress)
    const pathASet = new Set(pathA)
    const lca = pathB.find((node) => pathASet.has(node)) ?? ROOT_TOKEN
    const idxA = pathA.indexOf(lca)
    const idxB = pathB.indexOf(lca)

    const nodes = new Set<string>()
    pathA.slice(0, idxA + 1).forEach((node, index, list) => {
      nodes.add(node)
    })

    pathB.slice(0, idxB + 1).forEach((node, index, list) => {
      nodes.add(node)
    })

    const pathToLca = pathA.slice(0, idxA + 1)
    const pathFromLca = pathB.slice(0, idxB).reverse()
    const fullPath = [...pathToLca, ...pathFromLca]
    const symbols = fullPath.map((address) => tokenMeta[address]?.symbol ?? 'Unknown')

    const hops = idxA + idxB
    const feePerHop = 0.997
    const nextRate = Math.pow(feePerHop, Math.max(hops, 0))
    const parsedAmount = Number(amount)
    const nextAmountOut = Number.isFinite(parsedAmount) ? parsedAmount * nextRate : 0

    return {
      highlightNodes: nodes,
      pathSymbols: symbols,
      rate: nextRate,
      amountOut: nextAmountOut,
    }
  }, [amount, fromToken, toToken, symbolToAddress])

  const renderNode = (address: string) => {
    const token = tokenMeta[address]
    const nodeActive = highlightNodes.has(address)
    const children = tree.get(address) ?? []

    return (
      <li key={address}>
        <div className={`node ${nodeActive ? 'is-active' : ''}`}>
          <span className="dot" />
          <span className="symbol">{token.symbol}</span>
          <span className="address">{token.addressShort}</span>
        </div>
        {children.length > 0 && (
          <ul className="branch">
            {children.map((child) => (
              <li key={child}>{renderNode(child)}</li>
            ))}
          </ul>
        )}
      </li>
    )
  }

  return (
    <main className="page">
      <header className="header">
        <h1>Tempo DEX</h1>
        <span className="badge">testnet</span>
      </header>

      <section className="panel">
        <div className="panel-title">Asset tree (pathUSD root)</div>
        <ul className="tree">{renderNode(ROOT_TOKEN)}</ul>
      </section>

      <section className="panel">
        <div className="panel-title">Swap</div>
        <div className="swap">
          <div className="row">
            <div className="field">
              <label htmlFor="fromToken">From</label>
              <select
                id="fromToken"
                value={fromToken}
                onChange={(event) => setFromToken(event.target.value)}
              >
                {tokensBySymbol.map((token) => (
                  <option key={token.address} value={token.symbol}>
                    {token.symbol}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="toToken">To</label>
              <select
                id="toToken"
                value={toToken}
                onChange={(event) => setToToken(event.target.value)}
              >
                {tokensBySymbol.map((token) => (
                  <option key={token.address} value={token.symbol}>
                    {token.symbol}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="field">
            <label htmlFor="amount">Amount</label>
            <input
              id="amount"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </div>

          <div className="quote">
            <div>Rate: {rate.toFixed(6)} (est. 0.3% per hop)</div>
            <div>
              Output: {amountOut.toFixed(6)} {toToken}
            </div>
            <div className="path">Path: {pathSymbols.join(' -> ')}</div>
          </div>
        </div>
      </section>
    </main>
  )
}

const root = createRoot(document.getElementById('app') as HTMLElement)
root.render(<App />)
