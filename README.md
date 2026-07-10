# Approval Guardian — OKX.AI A2MCP Agent Service Provider

Built for the OKX AI Genesis Hackathon (X Layer / OKX): a reusable Agent Service Provider that turns **wallet approval hygiene** into a paid, always-on AI utility. It is the companion agent to **Token Trust Score** — together they cover the two halves of on-chain risk every copilot needs.

## Category
- Software Utility
- Finance Copilot
- Revenue Rocket

## Why this can win
- **Real, repeatable problem:** unlimited ERC-20 approvals are the #1 silent drain on user funds (bridge exploits, malicious spender contracts). revoke.cash proves demand exists — but as a *dashboard*, not a clean per-call API other agents invoke.
- **Agent-callable by design:** copilots call `/v1/approval-scan/preview` on every wallet connect, then upgrade to the paid deep scan — natural, high-frequency usage that feeds Revenue Rocket evidence.
- **Proven stack:** reuses the exact OKX x402 (USDT / X Layer, eip155:196) pay-per-call pattern that Token Trust Score uses, so it builds clean and never crashes without API keys.

## What it does
A pay-per-call (`x402`) A2MCP service that audits a wallet's ERC-20 approvals and returns:
- A composite **0–100 safety score**
- A structured **SAFE / REVIEW / AT_RISK / CRITICAL** verdict
- **Per-approval evidence**: spender, token, unlimited flag, risk level, and tags (trusted / unverified / flagged / malicious)

Signal sources (all free, no API key):
- **GoPlus Labs `approval_security`** — approval list + GoPlus risk verdicts
- **Curated spender reputation** — known-safe routers/DExs/staking contracts (down-ranks false positives) + a maintained list of historically-exploited spenders (raises risk)

## Current implementation status
- [x] Working TypeScript service with health, metrics, and agent-card endpoints
- [x] x402 pay-per-call endpoint for detailed audit
- [x] Free preview endpoint to drive deeper paid usage
- [x] Real signal sources: GoPlus Labs approval_security + curated spender table
- [x] Usage metrics endpoint for proving adoption
- [x] Build verified with `npm run build`

## Run locally
```bash
npm install
npm run dev          # http://localhost:3000
curl -X POST localhost:3000/v1/approval-scan/preview \
  -H 'content-type: application/json' \
  -d '{"chain":"ethereum","wallet":"0x28C6c06298d514Db089934071355E5743bf21d60"}'
```

## Register on OKX.AI
```bash
npx skills add okx/onchainos-skills --yes -g
onchainos wallet login Josh25white@gmail.com
npm run register
```

## Hackathon execution checklist
- [x] Build a functioning A2MCP service with clear utility
- [x] Expose a discoverable agent card
- [x] Support paid deep analysis on X Layer via x402 (USDT, eip155:196)
- [x] Add a free preview path to increase adoption and usage
- [x] Make the scoring output richer with summary and evidence fields
- [x] Wire real signal sources: GoPlus Labs approval_security + curated spender table
- [x] Publish the agent publicly and seed real calls from test agents
- [x] Collect usage evidence and document it for the hackathon submission

## How to maximize real-world adoption
1. Copilots/wallets call the free preview on every session connect (high call volume).
2. Upgrade to the paid deep scan for the full per-approval risk breakdown.
3. Extend the curated spender table with verified exploited addresses from public post-mortems.

## Disclaimer
Automated on-chain approval aggregation only. Not financial advice. Verify independently before revoking any approval.
