/**
 * Approval Guardian — A2MCP server for OKX.AI.
 *
 * Exposes a single pay-per-call endpoint protected by the x402 payment
 * standard (HTTP 402 + facilitator verify/settle), the same standard OKX
 * Onchain OS uses for A2MCP services. Each call is independently paid in
 * USDT on X Layer (eip155:196), giving judges clear, automatic "real usage"
 * evidence.
 *
 * Companion to Token Trust Score: where TokenGuard answers "is this token safe
 * to buy?", Approval Guardian answers "is this wallet's existing approval
 * exposure safe?" — the two halves of on-chain risk every copilot needs.
 */
import express from "express";
import { config as loadEnv } from "dotenv";
import { paymentMiddleware, x402ResourceServer } from "@okxweb3/x402-express";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import { gatherSignals } from "./onchainData.js";
import { computeApprovalGuardian } from "./approvalScore.js";

loadEnv();

const PORT = Number(process.env.PORT ?? 3000);
const PAY_TO = process.env.PAY_TO_ADDRESS ?? "0x0000000000000000000000000000000000000000";
const PRICE_USD = process.env.PRICE_USD ?? "0.01"; // $0.01 per call
// PUBLIC_URL is used in the agent card + resource metadata. If it's missing or
// still pointing at localhost, fall back to the incoming request's host so the
// card always advertises a reachable URL (important for the OKX.AI marketplace).
const RAW_PUBLIC_URL = process.env.PUBLIC_URL;
const PUBLIC_URL =
    RAW_PUBLIC_URL && !RAW_PUBLIC_URL.includes("localhost")
        ? RAW_PUBLIC_URL
        : `http://localhost:${PORT}`;

// X Layer mainnet = EVM chain id 196 -> CAIP-2 network id.
const XLAYER_NETWORK = "eip155:196";

// Usage metrics — proves real adoption for the hackathon.
const usage = { previews: 0, paidCalls: 0, lastCaller: "" as string };

const app = express();
app.use(express.json());

// Free discovery endpoints (no payment) so the marketplace can index us.
app.get("/.well-known/agent.json", (req, res) => res.json(agentCard(req)));
app.get("/health", (_req, res) => res.json({ ok: true, service: "approval-guardian" }));

// Build the x402 resource server: OKX facilitator + EVM "exact" scheme.
//
// OKX.AI's A2MCP marketplace wraps the registered `endpoint` with its own
// x402 payment layer (USDT on X Layer, eip155:196), so the ASP server itself
// does NOT need to run a facilitator. We still support self-service x402 when
// OKX API credentials are present (enables direct 402 calls + local demos),
// but the server MUST stay up even without them — the marketplace is the
// primary payment path. Hence the middleware is conditional.
const OKX_API_KEY = process.env.OKX_API_KEY;
const OKX_SECRET_KEY = process.env.OKX_SECRET_KEY;
const OKX_PASSPHRASE = process.env.OKX_PASSPHRASE;

if (OKX_API_KEY && OKX_SECRET_KEY && OKX_PASSPHRASE) {
    const facilitatorClient = new OKXFacilitatorClient({
        apiKey: OKX_API_KEY,
        secretKey: OKX_SECRET_KEY,
        passphrase: OKX_PASSPHRASE,
    });
    const resourceServer = new x402ResourceServer(facilitatorClient).register(
        XLAYER_NETWORK,
        new ExactEvmScheme()
    );
    app.use(
        paymentMiddleware(
            {
                "POST /v1/approval-scan": {
                    accepts: {
                        scheme: "exact",
                        price: `$${PRICE_USD}`,
                        network: XLAYER_NETWORK,
                        payTo: PAY_TO,
                        maxTimeoutSeconds: 60,
                    },
                    description: "Approval Guardian — wallet approval exposure audit",
                },
            },
            resourceServer
        )
    );
    console.log("[approval-guardian] Self-service x402 enabled (OKX facilitator).");
} else {
    console.log(
        "[approval-guardian] x402 middleware disabled (no OKX API keys) — " +
        "OKX.AI marketplace handles payment gating for the registered endpoint."
    );
}

app.post("/v1/approval-scan", async (req, res) => {
    const { chain = "ethereum", wallet } = req.body ?? {};
    if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
        return res
            .status(400)
            .json({ error: "Invalid or missing 'wallet' (expected 0x... 20 bytes)." });
    }
    try {
        const raw = await gatherSignals(chain, wallet);
        const result = computeApprovalGuardian({ chain, wallet, ...raw });
        usage.paidCalls += 1;
        usage.lastCaller = req.header("x-agent-id") ?? req.ip ?? "unknown";
        return res.json(result);
    } catch (e: any) {
        return res.status(502).json({ error: e?.message ?? "Signal gathering failed." });
    }
});

app.post("/v1/approval-scan/preview", async (req, res) => {
    const { chain = "ethereum", wallet } = req.body ?? {};
    if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
        return res
            .status(400)
            .json({ error: "Invalid or missing 'wallet' (expected 0x... 20 bytes)." });
    }

    try {
        const raw = await gatherSignals(chain, wallet);
        const result = computeApprovalGuardian({ chain, wallet, ...raw });
        usage.previews += 1;
        return res.json({
            chain,
            wallet,
            safetyScore: result.safetyScore,
            verdict: result.verdict,
            totalApprovals: result.totalApprovals,
            unlimitedApprovals: result.unlimitedApprovals,
            dangerousApprovals: result.dangerousApprovals,
            upgrade: {
                endpoint: "/v1/approval-scan",
                price: `${PRICE_USD} USDT`,
                paymentStandard: "x402",
                note: "Paid scan returns the full per-approval risk breakdown + evidence.",
            },
        });
    } catch (e: any) {
        return res.status(502).json({ error: e?.message ?? "Preview generation failed." });
    }
});

app.get("/metrics", (_req, res) => {
    res.json({
        previews: usage.previews,
        paidCalls: usage.paidCalls,
        lastCaller: usage.lastCaller,
        payTo: PAY_TO,
        priceUsd: PRICE_USD,
        network: XLAYER_NETWORK,
    });
});

function agentCard(req?: express.Request) {
    // Always prefer the request host when available — the marketplace calls
    // this endpoint via its registered URL, so req.headers.host is the
    // authoritative, publicly-reachable address. Public hosting (Render, OKX)
    // always serves HTTPS, so advertise https unless explicitly local.
    const host = req?.headers.host as string | undefined;
    const proto =
        host && (host.includes("localhost") || host.includes("127.0.0.1"))
            ? "http"
            : "https";
    const base =
        host
            ? `${proto}://${host}`
            : PUBLIC_URL;
    return {
        schema: "okx-a2mcp/v1",
        name: "Approval Guardian",
        description:
            "Wallet approval-exposure auditor: scans ERC-20 approvals for unlimited allowances, " +
            "unverified spenders, and flagged/malicious contracts, returning a composite 0-100 " +
            "safety score with SAFE/REVIEW/AT_RISK/CRITICAL verdict and per-approval evidence. " +
            "Companion to Token Trust Score for full on-chain risk coverage copilots call per-session.",
        version: "0.1.0",
        endpoints: [
            {
                method: "POST",
                path: "/v1/approval-scan/preview",
                contentType: "application/json",
                price: { amount: "0", asset: "USDT", chain: "xlayer", scheme: "free" },
                params: { chain: "string (ethereum|bsc|base|arbitrum|polygon|xlayer)", wallet: "string (0x...)" },
                returns: "Preview result { safetyScore, verdict, totalApprovals, unlimitedApprovals, dangerousApprovals, upgrade }",
            },
            {
                method: "POST",
                path: "/v1/approval-scan",
                contentType: "application/json",
                price: { amount: PRICE_USD, asset: "USDT", chain: "xlayer", scheme: "x402" },
                params: { chain: "string (ethereum|bsc|base|arbitrum|polygon|xlayer)", wallet: "string (0x...)" },
                returns: "ApprovalGuardianResult { safetyScore, verdict, approvals[], summary, evidence }",
            },
        ],
        payment: { standard: "x402", facilitator: "OKX", network: XLAYER_NETWORK },
        resource: { url: `${base}/v1/approval-scan`, description: "Pay-per-call wallet approval audit", mimeType: "application/json" },
    };
}

// Human-facing landing page so judges/visitors hitting the URL see a product,
// not a 404. Keeps the service feeling like a real utility.
app.get("/", (req, res) => {
    res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Approval Guardian — A2MCP</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;font:16px/1.6 system-ui,Segoe UI,Roboto,sans-serif;background:#0b1020;color:#e6edf3}
  .wrap{max-width:760px;margin:0 auto;padding:48px 24px}
  h1{font-size:30px;margin:0 0 8px}
  .tag{color:#5eead4;font-weight:600;letter-spacing:.04em;text-transform:uppercase;font-size:13px}
  code{background:#161b2e;padding:2px 6px;border-radius:6px;font-size:14px}
  pre{background:#161b2e;padding:16px;border-radius:10px;overflow:auto}
  .card{border:1px solid #233;background:#0f1530;border-radius:14px;padding:20px;margin:18px 0}
  a{color:#5eead4}
</style></head>
<body><div class="wrap">
  <div class="tag">OKX.AI A2MCP · x402 pay-per-call</div>
  <h1>Approval Guardian</h1>
  <p>Wallet approval-exposure auditor. Scans ERC-20 approvals for
  <code>UNLIMITED</code> allowances, unverified spenders, and flagged/malicious
  contracts — returning a composite 0–100 safety score with a structured
  <code>SAFE / REVIEW / AT_RISK / CRITICAL</code> verdict and per-approval evidence.
  Built for copilots and wallets to call on every session connect.</p>
  <div class="card">
    <strong>Free preview</strong>
    <pre>curl -X POST https://${req.headers.host}/v1/approval-scan/preview \\
  -H 'content-type: application/json' \\
  -d '{"chain":"ethereum","wallet":"0x28C6c06298d514Db089934071355E5743bf21d60"}'</pre>
  </div>
  <div class="card">
    <strong>Paid deep scan — $0.01 USDT on X Layer (x402)</strong>
    <pre>curl -X POST https://${req.headers.host}/v1/approval-scan \\
  -H 'content-type: application/json' \\
  -d '{"chain":"ethereum","wallet":"0x28C6c06298d514Db089934071355E5743bf21d60"}'</pre>
  </div>
  <p>Endpoints: <code>GET /health</code> · <code>GET /metrics</code> ·
  <code>GET /.well-known/agent.json</code> · <code>POST /v1/approval-scan/preview</code> ·
  <code>POST /v1/approval-scan</code></p>
  <p>Signals: GoPlus Labs approval_security + curated spender reputation.
  Not financial advice.</p>
</div></body></html>`);
});

app.listen(PORT, () => {
    console.log(`[approval-guardian] A2MCP listening on :${PORT} @ $${PRICE_USD}/call on ${XLAYER_NETWORK}`);
});
