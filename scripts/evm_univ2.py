import requests
from decimal import Decimal

GET_RESERVES = "0x0902f1ac"

def eth_call(rpc, to, data):
    body = {"jsonrpc": "2.0", "id": 1, "method": "eth_call", "params": [{"to": to, "data": data}, "latest"]}
    r = requests.post(rpc, json=body, timeout=10)
    r.raise_for_status()
    return r.json()["result"]

def parse_res(result_hex):
    data = result_hex[2:].rjust(192, "0")
    r0 = int(data[0:64], 16)
    r1 = int(data[64:128], 16)
    ts = int(data[128:192], 16)
    return r0, r1, ts

def fetch_prices_univ2(manifest):
    rpc = manifest["rpc_url"]
    out = []
    for p in manifest.get("pairs", []):
        try:
            raw = eth_call(rpc, p["pair"], GET_RESERVES)
            r0, r1, ts = parse_res(raw)
            mid = float((Decimal(r1) / (10 ** p["token1"]["decimals"])) / (Decimal(r0) / (10 ** p["token0"]["decimals"])))
            out.append({
                "symbol": p["symbol"],
                "venue": p["venue"],
                "mid": mid,
                "ts": ts,
                "fees_bps_roundtrip": p.get("fees_bps_roundtrip", 30)
            })
        except Exception as e:
            out.append({"symbol": p.get("symbol", "?"), "venue": p.get("venue", "?"), "error": str(e)})
    return out
