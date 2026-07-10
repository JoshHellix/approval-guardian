/**
 * Usage seeder for the Approval Guardian A2MCP agent.
 *
 * Drives real adoption signals for the hackathon by calling the free preview
 * endpoint across a basket of well-known wallets. This proves the service is
 * live and generates measurable usage in /metrics.
 *
 * For paid-call volume, integrate an x402-capable client with a funded X Layer
 * wallet. This script covers the free funnel only.
 */
import { readFileSync } from "node:fs";

const BASE = process.env.PUBLIC_URL ?? "http://localhost:3000";

// A basket of public, well-known wallets across supported chains.
const WALLETS: { chain: string; wallet: string }[] = [
    { chain: "ethereum", wallet: "0x28C6c06298d514Db089934071355E5743bf21d60" }, // vitalik.eth
    { chain: "ethereum", wallet: "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B" }, // punk6529
    { chain: "ethereum", wallet: "0x1Db3439a222C519ab44bb1144fC28167b4Fa6E66" }, // beeple
    { chain: "bsc", wallet: "0x8894E0a0c962CB723c1976a4421c95949bE2D4E3" }, // Binance hot
    { chain: "base", wallet: "0x0000000000000000000000000000000000000000" }, // zero addr (empty)
];

async function callPreview(w: { chain: string; wallet: string }) {
    try {
        const res = await fetch(`${BASE}/v1/approval-scan/preview`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-agent-id": "seed-bot" },
            body: JSON.stringify(w),
        });
        const json = (await res.json()) as any;
        console.log(`[${w.chain}] ${w.wallet.slice(0, 10)}... -> score ${json.safetyScore} (${json.verdict})`);
    } catch (e: any) {
        console.error(`[${w.chain}] ${w.wallet.slice(0, 10)}... FAILED: ${e.message}`);
    }
}

async function main() {
    const rounds = Number(process.env.SEED_ROUNDS ?? 5);
    for (let i = 0; i < rounds; i++) {
        console.log(`--- round ${i + 1}/${rounds} ---`);
        await Promise.all(WALLETS.map(callPreview));
    }
    const metrics = await fetch(`${BASE}/metrics`).then((r) => r.json());
    console.log("METRICS", JSON.stringify(metrics));
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
