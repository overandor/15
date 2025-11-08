# Live Alpha Signals (Informational Only)

- Updates every **3 minutes** for **23h/day** via GitHub Actions (`*/3 0-22 * * *`).
- Mines cross-venue price edges on EVM (UniswapV2-style) and stubs Solana feeds.
- Uses **combinatorics-as-prompting** to bias scans (local LLM optional).  
- Outputs `signals.json`; `index.html` renders a table. **No keys, no signing, no orders.**

## Live Snapshot
<!-- AUTO:START -->

Last refresh: `n/a` (UTC)

No signals available. Populate `signals.json` to refresh this snapshot.
<!-- AUTO:END -->

## Configure
1. Fill `manifests/evm_univ2.json` (≥2 venues for same `symbol`) and `manifests/solana_accounts.json`.
2. Enable Actions on the repo; push `main`.
3. (Optional) Runner with `ollama` improves focus ranking; otherwise deterministic fallback is used.

## Data
Each row includes `edge_bps` and replication fields `buy_venue`, `sell_venue`, `assumptions.fees_bps/slip_bps/buffer_bps`.  
**Disclaimer:** Informational estimates; not advice.
