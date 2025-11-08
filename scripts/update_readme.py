#!/usr/bin/env python3
import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
README_PATH = ROOT / "README.md"
SIGNALS_PATH = ROOT / "signals.json"
AUTO_START = "<!-- AUTO:START -->"
AUTO_END = "<!-- AUTO:END -->"
MAX_ROWS = 10


def load_signals():
    if not SIGNALS_PATH.exists():
        return {"generated_at": 0, "signals": []}
    try:
        data = json.loads(SIGNALS_PATH.read_text())
    except json.JSONDecodeError:
        return {"generated_at": 0, "signals": []}
    if "signals" not in data or not isinstance(data["signals"], list):
        data["signals"] = []
    return data


def format_timestamp(epoch: int) -> str:
    if not epoch:
        return "n/a"
    return datetime.fromtimestamp(epoch, tz=timezone.utc).isoformat()


def compute_rows(signals):
    rows = []
    for s in signals[:MAX_ROWS]:
        try:
            symbol = s.get("symbol", "-")
            buy = s.get("buy_venue") or "-"
            sell = s.get("sell_venue") or "-"
            edge_bps = float(s.get("edge_bps", 0.0))
            cents_per_k = edge_bps / 10000.0 * 1000.0 * 100.0
            ttl = int(s.get("ttl_seconds", 0) or 0)
            updated = format_timestamp(int(s.get("ts", 0) or 0))
            best_bid = float(s.get("best_bid", 0.0))
            best_ask = float(s.get("best_ask", 0.0))
        except (TypeError, ValueError):
            continue
        rows.append(
            "| {symbol} | {buy} | {sell} | {edge:.2f} | {cents:.2f} | {bid:.6f} | {ask:.6f} | {ttl} | {updated} |".format(
                symbol=symbol,
                buy=buy,
                sell=sell,
                edge=edge_bps,
                cents=cents_per_k,
                bid=best_bid,
                ask=best_ask,
                ttl=ttl,
                updated=updated,
            )
        )
    return rows


def build_snapshot():
    data = load_signals()
    header = f"Last refresh: `{format_timestamp(int(data.get('generated_at', 0) or 0))}` (UTC)"
    signals = data.get("signals", [])
    rows = compute_rows(signals)
    lines = [header, ""]
    if rows:
        lines.append("| Symbol | Buy@ | Sell@ | Edge (bps) | Edge (¢/$1k) | Best Bid | Best Ask | TTL (s) | Updated (UTC) |")
        lines.append("| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |")
        lines.extend(rows)
    else:
        lines.append("No signals available. Populate `signals.json` to refresh this snapshot.")
    return "\n".join(lines)


def replace_snapshot(readme_text: str, snapshot: str) -> str:
    if AUTO_START not in readme_text or AUTO_END not in readme_text:
        raise SystemExit("README missing AUTO markers")
    start_idx = readme_text.index(AUTO_START) + len(AUTO_START)
    end_idx = readme_text.index(AUTO_END)
    before = readme_text[:start_idx].rstrip()
    after = readme_text[end_idx + len(AUTO_END):]
    after = after.lstrip("\n")
    separator = "\n\n" if after else "\n"
    return f"{before}\n\n{snapshot}\n{AUTO_END}{separator}{after}"


def main():
    readme = README_PATH.read_text()
    snapshot = build_snapshot()
    updated = replace_snapshot(readme, snapshot)
    if updated != readme:
        README_PATH.write_text(updated)


if __name__ == "__main__":
    main()
