/**
 * Registration helper for the OKX.AI A2MCP ASP "Approval Guardian".
 *
 * The current Onchain OS CLI (v4.2.2) flow is:
 *   1. onchainos wallet login <email>   (then `onchainos wallet verify <otp>`)
 *   2. onchainos agent upload --file <avatar.png>   (returns a CDN URL)
 *   3. onchainos agent create --role asp --name ... --description ... --picture <url> --service <JSON>
 *   4. onchainos agent activate --agent-id <id> --preferred-language en-US
 *
 * Because the --service JSON must be passed as a single argv element (no shell
 * word-splitting), the actual create call is done by scripts/do-register.cjs.
 * This TS file documents the flow and is kept for reference.
 *
 * NOTE: PAY_TO_ADDRESS in .env must be the 0x... EVM form of your X Layer
 * Agentic Wallet, NOT the XKO... branded format. x402 cannot use XKO prefixes.
 * Verified X Layer wallet: 0x7716ea8a6c001afe4bc77e277e902a2676e8d527
 */
import { execSync } from "node:child_process";

const PUBLIC_URL = process.env.PUBLIC_URL ?? "https://approval-guardian.onrender.com";

function run(cmd: string) {
    console.log(`$ ${cmd}`);
    execSync(cmd, { stdio: "inherit" });
}

// 1) Upload avatar (replace path with your logo), capture the returned URL.
// 2) Create the agent (delegated to do-register.cjs to avoid shell quoting issues).
run(`node scripts/do-register.cjs`);

// 3) Activate / submit for marketplace review (replace 5003 with the new id).
run(`onchainos agent activate --agent-id 5003 --preferred-language en-US`);

console.log(`\nRegistered Approval Guardian. Endpoint: ${PUBLIC_URL}/v1/approval-scan`);
