import React from 'react'
import { createRoot } from 'react-dom/client'
import './style.css'

function App() {
  return (
    <div>
      <header className="topbar">
        <div className="logo">Tempo Docs UI</div>
        <span className="badge">v0 minimal</span>
      </header>

      <main className="container">
        <section className="hero">
          <h1>Stablecoin exchange, simplified.</h1>
          <p>
            A minimal single-page interface styled to match Tempo&#39;s clean
            documentation aesthetic. Lightweight typography, soft borders, and
            clear spacing.
          </p>
          <span className="mono">tempo.ts · viem · dex</span>
        </section>

        <section className="grid">
          <article className="card">
            <h3>Connect</h3>
            <p>Configure a Viem client with Tempo&#39;s chain and fee token.</p>
            <span className="mono">tempo({`{ feeToken }`})</span>
          </article>
          <article className="card">
            <h3>Swap</h3>
            <p>Buy or sell stablecoins with slippage protection.</p>
            <span className="mono">dex.buySync</span>
          </article>
          <article className="card">
            <h3>Orderbook</h3>
            <p>Place limit or flip orders and earn the spread.</p>
            <span className="mono">dex.placeFlip</span>
          </article>
          <article className="card">
            <h3>Balances</h3>
            <p>Keep funds on the DEX to reduce transfer overhead.</p>
            <span className="mono">dex.getBalance</span>
          </article>
        </section>

        <footer className="footer">
          <span>Tempo DEX minimal</span>
          <span>Single page • esbuild</span>
        </footer>
      </main>
    </div>
  )
}

const root = createRoot(document.getElementById('app') as HTMLElement)
root.render(<App />)
