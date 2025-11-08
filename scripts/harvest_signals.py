#!/usr/bin/env python3
import json
import time
from pathlib import Path

from scripts.edge_math import edge_bps
from scripts.evm_univ2 import fetch_prices_univ2
from scripts import solana_stub as sol

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "signals.json"
EVM_MAN = ROOT / "manifests/evm_univ2.json"
SOL_MAN = ROOT / "manifests/solana_accounts.json"
FOCUS = ROOT / "cache/focus.json"

SLIP_BPS = 3
BUF_BPS = 2
TTL = 30

def focus_filter(symbol, venue, targets):
    if not targets:
        return True
    key_a = f"price_gap|{venue}|{symbol}"
    key_b = f"triangular_hint|{venue}|{symbol}"
    return (key_a in targets) or (key_b in targets)

def best_edges(prices, targets):
    grouped = {}
    for p in prices:
        if "error" in p:
            continue
        grouped.setdefault(p["symbol"], []).append(p)
    signals = []
    now = int(time.time())
    for symbol, rows in grouped.items():
        best_ask = min(rows, key=lambda r: r["mid"])
        best_bid = max(rows, key=lambda r: r["mid"])
        if not focus_filter(symbol, best_ask["venue"], targets) and not focus_filter(symbol, best_bid["venue"], targets):
            continue
        fees = max(best_ask["fees_bps_roundtrip"], best_bid["fees_bps_roundtrip"])
        edge = edge_bps(best_bid["mid"], best_ask["mid"], fees_bps=fees, slip_bps=SLIP_BPS, buffer_bps=BUF_BPS)
        signals.append({
            "chain": "EVM",
            "symbol": symbol,
            "best_bid": best_bid["mid"],
            "best_ask": best_ask["mid"],
            "sell_venue": best_bid["venue"],
            "buy_venue": best_ask["venue"],
            "edge_bps": edge,
            "ttl_seconds": TTL,
            "ts": now,
            "assumptions": {
                "fees_bps": fees,
                "slip_bps": SLIP_BPS,
                "buffer_bps": BUF_BPS
            }
        })
    return signals

def main():
    targets = []
    if FOCUS.exists():
        try:
            targets = json.loads(FOCUS.read_text()).get("targets", [])
        except Exception:
            targets = []
    signals = []
    if EVM_MAN.exists():
        evm_manifest = json.loads(EVM_MAN.read_text())
        prices = fetch_prices_univ2(evm_manifest)
        signals.extend(best_edges(prices, targets))
    if SOL_MAN.exists():
        sol_manifest = json.loads(SOL_MAN.read_text())
        _ = sol.fetch_pyth_prices(sol_manifest)
    payload = {"generated_at": int(time.time()), "signals": sorted(signals, key=lambda x: -x["edge_bps"])}
    OUT.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"wrote {OUT}")

if __name__ == "__main__":
    main()
