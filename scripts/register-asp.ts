/**
 * Registration helper for the OKX.AI A2MCP ASP "Approval Guardian".
 *
 * The documented onboarding flow uses the Onchain OS CLI (installed via
 * `npx skills add okx/onchainos-skills --yes -g`). This script shells out to
 * that CLI so registration is reproducible and version-controlled.
 *
 * Prereqs (run once, interactively):
 *   1. npx skills add okx/onchainos-skills --yes -g
 *   2. Log in to Agentic Wallet:  onchainos wallet login Josh25white@gmail.com
 *
 * Then:  npm run register
 *
 * NOTE: PAY_TO_ADDRESS in .env must be the 0x... EVM form of your X Layer
 * Agentic Wallet, NOT the XKO... branded format. x402 cannot use XKO prefixes.
 * Verified X Layer wallet: 0x7716ea8a6c001afe4bc77e277e902a2676e8d527
 */
import { execSync } from "node:child_process";

const SERVICE_NAME = "Approval Guardian";
// PAY_TO must match the X Layer address of the logged-in Agentic Wallet.
const SERVICE_DESC =
    "Pay-per-call wallet approval-exposure audit: scans ERC-20 approvals for unlimited allowances, " +
    "unverified spenders, and flagged contracts; returns a 0-100 safety score with SAFE/REVIEW/AT_RISK/CRITICAL verdict.";
const PUBLIC_URL = process.env.PUBLIC_URL ?? "http://localhost:3000";

function run(cmd: string) {
    console.log(`$ ${cmd}`);
    execSync(cmd, { stdio: "inherit" });
}

// Register as A2MCP ASP. The CLI reads service metadata from the agent card.
run(
    `onchainos agent register-a2mcp ` +
    `--name "${SERVICE_NAME}" ` +
    `--description "${SERVICE_DESC}" ` +
    `--endpoint "${PUBLIC_URL}/v1/approval-scan" ` +
    `--agent-card "${PUBLIC_URL}/.well-known/agent.json" ` +
    `--price-usdc 0.01`
);

// Submit for marketplace listing (24h review per docs).
run(`onchainos agent set-public`);
