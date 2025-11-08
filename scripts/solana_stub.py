import requests
import time

def rpc_call(rpc, method, params):
    r = requests.post(rpc, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, timeout=10)
    r.raise_for_status()
    return r.json()["result"]

def fetch_pyth_prices(manifest):
    rpc = manifest.get("rpc_url", "")
    out = []
    for feed in manifest.get("pyth_prices", []):
        try:
            acc = rpc_call(rpc, "getAccountInfo", [feed["account"], {"encoding": "base64"}])
            out.append({"symbol": feed["symbol"], "slot": acc.get("context", {}).get("slot"), "ts": int(time.time())})
        except Exception as e:
            out.append({"symbol": feed["symbol"], "error": str(e)})
    return out
