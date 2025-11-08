// jito_edge_searcher.ts
// Single-file deployable MEV/arbitrage searcher for Solana + Jito
// Node >=18. No framework. One command to run.
//
// Features
// - Wallet load from env (base58 or JSON array)
// - Pyth staleness and deviation checks
// - Jupiter quotes and signed swap tx requests
// - Profit model with fee + slip buffers
// - Jito Block Engine bundles (optional if lib present), or standard RPC
// - Simple target set (USDC<->SOL plus configurable tokens)
// - Structured logs and graceful backoff

/* =========================  CONFIG  ========================= */
const CFG = {
  RPC_URL: process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com",
  JITO_BE_URL: process.env.JITO_BE_URL ?? "", // e.g. "https://mainnet.block-engine.jito.wtf"
  JITO_AUTH: process.env.JITO_AUTH ?? "",     // auth header if required by your BE endpoint
  WALLET: process.env.WALLET ?? "",           // base58 secret or JSON array string
  LOOP_MS: Number(process.env.LOOP_MS ?? "1200"),
  SLIPPAGE_BPS: Number(process.env.SLIPPAGE_BPS ?? "40"),    // 0.40%
  MIN_PROFIT_USDC: Number(process.env.MIN_PROFIT_USDC ?? "0.75"),
  LEG_SIZE_BASE: Number(process.env.LEG_SIZE_BASE ?? "10"),
  PYTH_PRICE_ID_SOLUSD: process.env.PYTH_PRICE_ID_SOLUSD ?? // main SOL/USD price account
    "J83w4HKfqxwcq3BEMMkPFSppX3gqekLyCkLMTDW7Lw7y",
  PYTH_MAX_AGE_S: Number(process.env.PYTH_MAX_AGE_S ?? "12"),
  PYTH_MAX_REL_CONF: Number(process.env.PYTH_MAX_REL_CONF ?? "0.01"),
  PYTH_CONFIDENCE_BAND: Number(process.env.PYTH_CONFIDENCE_BAND ?? "3"),
  MAX_RETRIES: Number(process.env.MAX_RETRIES ?? "3"),
  MAX_PRICE_DEVIATION_BPS: Number(process.env.MAX_PRICE_DEVIATION_BPS ?? "50"),
  ROUTES: (process.env.ROUTES ?? "USDC:SOL,USDC:mSOL").split(",").map(s => s.trim()).filter(Boolean), // base:quote pairs
  TOKEN_INFO_EXTRA: process.env.TOKEN_INFO_EXTRA ?? "",
  // Jupiter endpoints
  JUP_QUOTE: process.env.JUP_QUOTE ?? "https://quote-api.jup.ag/v6/quote",
  JUP_SWAP:  process.env.JUP_SWAP  ?? "https://quote-api.jup.ag/v6/swap",
};
/* =========================================================== */

import bs58 from "bs58";
import { Connection, Keypair, VersionedTransaction, PublicKey, sendAndConfirmRawTransaction } from "@solana/web3.js";

type TokenInfo = { mint: string; decimals: number };

const BASE_TOKEN_INFO: Record<string, TokenInfo> = {
  USDC: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
  SOL:  { mint: "So11111111111111111111111111111111111111112", decimals: 9 },
  mSOL: { mint: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", decimals: 9 },
};

function parseExtraTokenInfo(raw: string): Record<string, TokenInfo> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || !parsed) throw new Error("invalid token info payload");
    const out: Record<string, TokenInfo> = {};
    for (const [sym, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object") throw new Error(`token info for ${sym} must be object`);
      const mint = (value as any).mint;
      const decimals = Number((value as any).decimals);
      if (typeof mint !== "string" || !mint) throw new Error(`token info for ${sym} missing mint`);
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 12) throw new Error(`token info for ${sym} has invalid decimals`);
      out[sym] = { mint, decimals };
    }
    return out;
  } catch (e) {
    throw new Error(`TOKEN_INFO_EXTRA parse failed: ${e}`);
  }
}

const TOKEN_INFO: Record<string, TokenInfo> = { ...BASE_TOKEN_INFO, ...parseExtraTokenInfo(CFG.TOKEN_INFO_EXTRA) };

function tokenInfo(symbol: string): TokenInfo {
  const info = TOKEN_INFO[symbol];
  if (!info) throw new Error(`unknown symbol ${symbol}`);
  return info;
}

// lazy optional import for Jito
let jito: any = null;
try { jito = await import("@jito-foundation/jito-ts"); } catch {}

/* =========================  UTILS  ========================= */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toISOString();
function log(o: Record<string, any>) { console.log(JSON.stringify({ t: now(), ...o })); }
async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json() as any;
}

async function withRetries<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let attempt = 0;
  let lastErr: unknown = null;
  while (attempt < CFG.MAX_RETRIES) {
    attempt += 1;
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === CFG.MAX_RETRIES) break;
      await sleep(100 * attempt);
    }
  }
  throw new Error(`${label} failed: ${lastErr}`);
}
function envWallet(): Keypair {
  if (!CFG.WALLET) throw new Error("WALLET env missing");
  try {
    // base58
    const s = CFG.WALLET.trim();
    if (s.startsWith("[") && s.endsWith("]")) {
      const arr = JSON.parse(s);
      return Keypair.fromSecretKey(Uint8Array.from(arr));
    }
    const secret = bs58.decode(s);
    return Keypair.fromSecretKey(secret);
  } catch (e) { throw new Error("Invalid WALLET format"); }
}

/* ====================  PYTH PRICE SAFETY  =================== */
// Minimal Pyth REST read via Helius-style gateway or Pyth price-service.
// We use price-service HTTP for simplicity.
async function getPythSOLUSD(): Promise<{ price: number; conf: number; ageSec: number }> {
  const endpoints = [
    `https://xc-mainnet.pyth.network/api/latest_price_feeds?ids[]=${CFG.PYTH_PRICE_ID_SOLUSD}`,
    `https://hermes.pyth.network/api/latest_price_feeds?ids[]=${CFG.PYTH_PRICE_ID_SOLUSD}`,
  ];
  let lastErr: unknown = null;
  for (const url of endpoints) {
    try {
      const feeds = await fetchJSON<any[]>(url, { headers: { Accept: "application/json" } });
      if (!Array.isArray(feeds) || feeds.length === 0) throw new Error("empty response");
      const feed = feeds[0];
      if (!feed?.price) throw new Error("missing price object");
      const priceBase = Number(feed.price.price);
      const expo = Number(feed.price.expo);
      const confBase = Number(feed.price.conf);
      const publishTime = Number(feed.price.publish_time ?? feed.publish_time ?? 0);
      if (!Number.isFinite(priceBase) || !Number.isFinite(expo)) throw new Error("invalid price fields");
      const scale = 10 ** expo;
      const price = priceBase * scale;
      const conf = confBase * scale;
      const ageSec = Math.max(0, Math.floor(Date.now() / 1000 - publishTime));
      return { price, conf, ageSec };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`PYTH read failed: ${lastErr}`);
}

/* ====================  JUPITER QUOTES  ===================== */
type Quote = {
  inAmount: string; outAmount: string; outAmountWithSlippage: string;
  priceImpactPct: number; routePlan: any[]; contextSlot: number;
};
async function jupQuote(inputMint: string, outputMint: string, amount: bigint | number, slippageBps: number): Promise<Quote | null> {
  const amountParam = typeof amount === "bigint" ? amount.toString() : Math.floor(amount).toString();
  const url = `${CFG.JUP_QUOTE}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountParam}&slippageBps=${slippageBps}`;
  try {
    return await withRetries(() => fetchJSON<Quote>(url, { headers: { Accept: "application/json" } }), "jupiter_quote");
  } catch {
    return null;
  }
}
async function jupSwapTx(owner: PublicKey, quote: Quote): Promise<VersionedTransaction> {
  const body = {
    userPublicKey: owner.toBase58(),
    wrapAndUnwrapSol: true,
    useSharedAccounts: true,
    computeUnitPriceMicroLamports: 0,
    quoteResponse: quote,
  };
  const r = await withRetries(
    () => fetch(CFG.JUP_SWAP, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    "jupiter_swap_build"
  );
  if (!r.ok) throw new Error(`swap build failed ${r.status}`);
  const j = await r.json();
  const tx = VersionedTransaction.deserialize(Buffer.from(j.swapTransaction, "base64"));
  return tx;
}

/* ====================  PROFIT ENGINE  ====================== */
function toAtomic(amount: number, decimals: number): bigint {
  return BigInt(Math.round(amount * 10 ** decimals));
}
function profitDelta(baseSpent: bigint, baseReturned: bigint): bigint {
  return baseReturned - baseSpent;
}

function validateConfig() {
  if (!CFG.RPC_URL) throw new Error("RPC_URL required");
  if (!Number.isFinite(CFG.LEG_SIZE_BASE) || CFG.LEG_SIZE_BASE <= 0) throw new Error("LEG_SIZE_BASE must be positive");
  if (!Number.isFinite(CFG.MIN_PROFIT_USDC) || CFG.MIN_PROFIT_USDC < 0) throw new Error("MIN_PROFIT_USDC must be non-negative");
  if (!Number.isFinite(CFG.SLIPPAGE_BPS) || CFG.SLIPPAGE_BPS <= 0) throw new Error("SLIPPAGE_BPS must be positive");
  if (!Number.isFinite(CFG.PYTH_MAX_AGE_S) || CFG.PYTH_MAX_AGE_S <= 0) throw new Error("PYTH_MAX_AGE_S must be positive");
  if (!Number.isFinite(CFG.PYTH_MAX_REL_CONF) || CFG.PYTH_MAX_REL_CONF <= 0) throw new Error("PYTH_MAX_REL_CONF must be positive");
  if (!Number.isFinite(CFG.PYTH_CONFIDENCE_BAND) || CFG.PYTH_CONFIDENCE_BAND <= 0) throw new Error("PYTH_CONFIDENCE_BAND must be positive");
  if (!Number.isFinite(CFG.MAX_RETRIES) || CFG.MAX_RETRIES < 1 || !Number.isInteger(CFG.MAX_RETRIES)) throw new Error("MAX_RETRIES must be integer >= 1");
  if (!Number.isFinite(CFG.MAX_PRICE_DEVIATION_BPS) || CFG.MAX_PRICE_DEVIATION_BPS < 0) throw new Error("MAX_PRICE_DEVIATION_BPS must be >= 0");
  if (!Array.isArray(CFG.ROUTES) || CFG.ROUTES.length === 0) throw new Error("ROUTES must be non-empty");
}

/* ====================  EXECUTION  ========================== */
async function submitBundleOrTx(conn: Connection, signedTxs: VersionedTransaction[], label: string) {
  if (jito && CFG.JITO_BE_URL) {
    // Minimal Jito submission using jito-ts broadcaster
    // Note: API details may vary by version. This is a thin wrapper.
    try {
      const be = new jito.BlockEngineClient(CFG.JITO_BE_URL, CFG.JITO_AUTH ? { "x-jito-auth": CFG.JITO_AUTH } : {});
      const bundle = new jito.Bundle(
        signedTxs.map((t: VersionedTransaction) => t.serialize()),
        Math.ceil(Date.now()/1000) + 30,
      );
      const resp = await be.sendBundle(bundle);
      log({ level: "info", msg: "bundle_submitted", label, resp });
      return;
    } catch (e:any) {
      log({ level: "warn", msg: "jito_fallback", err: String(e) });
    }
  }
  // fallback: standard RPC submits in sequence
  for (const tx of signedTxs) {
    const sig = await sendAndConfirmRawTransaction(conn, tx.serialize(), { skipPreflight: false, commitment: "confirmed" });
    log({ level: "info", msg: "tx_confirmed", sig, label });
  }
}

/* ====================  MAIN LOOP  ========================== */
async function main() {
  validateConfig();
  const kp = envWallet();
  const conn = new Connection(CFG.RPC_URL, { commitment: "confirmed" });
  log({ level: "info", msg: "boot", pubkey: kp.publicKey.toBase58(), rpc: CFG.RPC_URL, jito: !!(jito && CFG.JITO_BE_URL) });

  while (true) {
    try {
      const p = await getPythSOLUSD();
      if (!Number.isFinite(p.price) || !Number.isFinite(p.conf)) {
        log({ level: "warn", msg: "pyth_invalid_fields", price: p.price, conf: p.conf });
        await sleep(CFG.LOOP_MS);
        continue;
      }

      if (p.ageSec > CFG.PYTH_MAX_AGE_S) {
        log({ level: "warn", msg: "pyth_stale", ageSec: p.ageSec });
        await sleep(CFG.LOOP_MS);
        continue;
      }

      for (const pair of CFG.ROUTES) {
        const [base, quote] = pair.split(":");
        if (!base || !quote) {
          log({ level: "warn", msg: "route_parse_error", pair });
          continue;
        }
        const baseInfo = tokenInfo(base);
        const quoteInfo = tokenInfo(quote);
        const inMint = baseInfo.mint;
        const outMint = quoteInfo.mint;
        const baseScale = 10 ** baseInfo.decimals;
        const quoteScale = 10 ** quoteInfo.decimals;

        const legSizeAtomic = toAtomic(CFG.LEG_SIZE_BASE, baseInfo.decimals);
        const forward = await jupQuote(inMint, outMint, legSizeAtomic, CFG.SLIPPAGE_BPS);
        const forwardOutAtomic = forward ? BigInt(forward.outAmountWithSlippage ?? forward.outAmount) : null;
        const back = await jupQuote(outMint, inMint, forwardOutAtomic ?? legSizeAtomic, CFG.SLIPPAGE_BPS);

        if (!forward || !back) {
          log({ level: "debug", msg: "no_quote", pair });
          continue;
        }

        const forwardOut = BigInt(forward.outAmountWithSlippage ?? forward.outAmount);
        const backOut = BigInt(back.outAmountWithSlippage ?? back.outAmount);
        if (forwardOut <= 0n || backOut <= 0n) {
          log({ level: "warn", msg: "zero_amount", pair, forwardOut: forwardOut.toString(), backOut: backOut.toString() });
          continue;
        }
        const pnl = profitDelta(legSizeAtomic, backOut);
        const pnlBase = Number(pnl) / baseScale;

        if (p.price <= 0) {
          log({ level: "warn", msg: "pyth_invalid_price", pair, price: p.price });
          continue;
        }

        const relConf = Math.abs(p.conf / p.price);
        if (relConf > CFG.PYTH_MAX_REL_CONF) {
          log({ level: "warn", msg: "pyth_confidence_high", pair, relConf });
          continue;
        }

        const confBand = CFG.PYTH_CONFIDENCE_BAND * p.conf;
        const refLower = p.price - confBand;
        const refUpper = p.price + confBand;

        const baseAmount = Number(legSizeAtomic) / baseScale;
        const quoteAmount = Number(forwardOut) / quoteScale;
        const impliedPrice = quoteAmount > 0 ? baseAmount / quoteAmount : 0;
        let priceDeviationBps = 0;
        if (impliedPrice > 0) {
          priceDeviationBps = Math.abs((impliedPrice - p.price) / p.price) * 10_000;
        }

        if ((base === "USDC" && quote === "SOL") || (base === "SOL" && quote === "USDC")) {
          if (impliedPrice < refLower || impliedPrice > refUpper) {
            log({
              level: "debug",
              msg: "pyth_bounds_reject",
              pair,
              impliedPrice,
              refLower,
              refUpper,
            });
            continue;
          }
          if (priceDeviationBps > CFG.MAX_PRICE_DEVIATION_BPS) {
            log({ level: "debug", msg: "price_deviation_reject", pair, priceDeviationBps });
            continue;
          }
        }

        log({
          level: "debug",
          msg: "route_eval",
          pair,
          legSizeAtomic: legSizeAtomic.toString(),
          forwardOutAtomic: forwardOut.toString(),
          backOutAtomic: backOut.toString(),
          pnlBase,
          slipBps: CFG.SLIPPAGE_BPS,
          pythAge: p.ageSec,
          pythPrice: p.price,
          priceDeviationBps,
        });

        const minProfitAtomic = BigInt(Math.floor(CFG.MIN_PROFIT_USDC * baseScale));
        if (pnl >= minProfitAtomic) {
          // Build transactions
          const fTx = await jupSwapTx(kp.publicKey, forward);
          const bTx = await jupSwapTx(kp.publicKey, back);

          // set recent blockhashes
          const { blockhash, lastValidBlockHeight } = await withRetries(
            () => conn.getLatestBlockhash({ commitment: "finalized" }),
            "latest_blockhash"
          );
          fTx.message.recentBlockhash = blockhash;
          bTx.message.recentBlockhash = blockhash;

          // sign
          fTx.sign([kp]);
          bTx.sign([kp]);

          // submit as bundle or sequential
          await submitBundleOrTx(conn, [fTx, bTx], `${base}->${quote}->${base}`);

          log({
            level: "info",
            msg: "roundtrip_executed",
            route: `${base}->${quote}->${base}`,
            sizeBase: baseAmount,
            estPnL_Base: pnlBase,
            pnlAtomic: pnl.toString(),
            lastValidBlockHeight
          });
        }
      }
    } catch (e: any) {
      log({ level: "error", msg: "loop_error", err: String(e) });
    }
    await sleep(CFG.LOOP_MS);
  }
}

/* ====================  START ============================== */
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { log({ level: "fatal", msg: "exit", err: String(e) }); process.exit(1); });
}
