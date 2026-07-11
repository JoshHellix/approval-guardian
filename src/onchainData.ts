/**
 * On-chain approval data gathering for the Approval Guardian engine.
 *
 * Working free pipeline (no paid indexer required):
 *   1. Etherscan V2 free API `tokentx` enumerates the ERC-20 tokens a wallet
 *      has actually interacted with (real, free, multi-chain).
 *   2. For each discovered token, we read the CURRENT allowance via
 *      `ERC20.allowance(owner, spender)` using a public/Ankr RPC `eth_call`
 *      — against a curated list of major spenders (routers, DEXs, lending,
 *      marketplaces). This catches the dangerous UNLIMITED approvals that
 *      actually drain wallets (the core risk the agent exists to surface).
 *
 * Optional enriched sources (used if their keys are present AND respond):
 *   - Etherscan `getApprovals` (if the tier permits)
 *   - Covalent (GoldRush) `/approvals/`
 *
 * Enrichment: GoPlus `approval_security` (spender risk) + curated
 * trusted/malicious spender table, to down-rank false positives and raise
 * known-exploited spenders.
 *
 * Degrades gracefully: if everything fails, returns an empty approval set with
 * a fallback source tag so the endpoint stays UP (reliability = usage). Never
 * throws to a 500 for a transient upstream issue.
 */
import { ethers } from "ethers";
import { config as loadEnv } from "dotenv";

loadEnv();

const ETHERSCAN_KEY = process.env.ETHERSCAN_KEY ?? "";
const COVALENT_KEY = process.env.COVALENT_KEY ?? "";
const ANKR_KEY = process.env.ANKR_API_KEY ?? "";

// Etherscan V2 chain ids.
const ETHERSCAN_CHAIN: Record<string, number> = {
    ethereum: 1, bsc: 56, base: 8453, arbitrum: 42161, polygon: 137, xlayer: 196,
};
// Covalent chain slugs (optional fallback).
const COVALENT_CHAIN: Record<string, string> = {
    ethereum: "eth-mainnet", bsc: "bsc-mainnet", base: "base-mainnet",
    arbitrum: "arbitrum-mainnet", polygon: "polygon-mainnet", xlayer: "xlayer-mainnet",
};
// Public RPCs for eth_call allowance reads (Ankr keyed first if present).
const RPCS: Record<string, string[]> = {
    ethereum: ["https://cloudflare-eth.com", "https://eth.drpc.org"],
    bsc: ["https://bsc-dataseed.bnbchain.org"],
    base: ["https://mainnet.base.org"],
    arbitrum: ["https://arb1.arbitrum.io/rpc"],
    polygon: ["https://polygon-rpc.com"],
    xlayer: ["https://rpc.xlayer.tech"],
};

const ERC20_ABI = ["function allowance(address,address) view returns (uint256)"];

const MAX_UINT256 =
    "115792089237316195423570985008687907853269984665640564039457584007913129639935";

// Curated major spenders to check allowances against. Covers the high-impact
// approvals (unlimited to real protocols) that actually drain wallets.
const MAJOR_SPENDERS: { address: string; name: string }[] = [
    { address: "0x7a250d5630b4cf539739df2c5dacb4c659f2488d", name: "Uniswap V2 Router" },
    { address: "0xe592427a0aece92de3edee1f18e0157c05861564", name: "Uniswap V3 Router" },
    { address: "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45", name: "Uniswap Universal Router" },
    { address: "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad", name: "Uniswap Universal Router" },
    { address: "0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f", name: "SushiSwap Router" },
    { address: "0x10ed43c718714eb63d5aa57b78b54704e256024e", name: "PancakeSwap V2 Router" },
    { address: "0x13f4ea83d0bd40e75c8222255bc855a974568dd4", name: "PancakeSwap V3 Router" },
    { address: "0x1111111254eeb25477b68fb85ed929f73a960582", name: "1inch V5 Router" },
    { address: "0x11111112542d85b3ef69ae05771c2dccff4faa26", name: "1inch V4 Router" },
    { address: "0x00000000006c3852cbef3e08e8df289169ede581", name: "OpenSea Seaport v1.1" },
    { address: "0x00000000000001ad428e4906ae43d8f9852d0dd6", name: "OpenSea Seaport v1.5" },
    { address: "0x00000000000000adc04c56bf30ac9d3c0aaf14dc", name: "OpenSea Seaport v1.6" },
    { address: "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2", name: "Aave V3 Pool" },
    { address: "0xae7ab96520de3a18e5e111b5eaab095312d7fe84", name: "Lido stETH" },
    { address: "0x99a58482bd75cbab83b27ec03ca68ff489b5788f", name: "Curve Router" },
    { address: "0x000000000022d473030f116978e4e44b8e3e1d4b", name: "Uniswap Permit2" },
];

// Known-exploited / malicious spender addresses (raises risk to danger).
const KNOWN_MALICIOUS_SPENDERS: Record<string, string> = {};

export interface RawApproval {
    spender: string;
    tokenAddress: string;
    tokenSymbol: string;
    tokenName: string;
    allowance: string;
    isUnlimited: boolean;
    riskLevel: "safe" | "warning" | "danger" | "unknown";
    riskTags: string[];
    source: string;
}

export interface RawSignals {
    approvals: RawApproval[];
    source: string;
    error?: string;
}

export async function gatherSignals(chain: string, wallet: string): Promise<RawSignals> {
    // Normalize to lowercase so EIP-55 checksum mismatches (common in hand-
    // typed / scraped addresses) don't reject a valid address.
    const w = wallet.toLowerCase();
    if (!ethers.isAddress(w)) throw new Error(`Invalid wallet address: ${wallet}`);
    if (!ETHERSCAN_CHAIN[chain] && !COVALENT_CHAIN[chain]) {
        throw new Error(`Unsupported chain: ${chain}.`);
    }

    // 1) Try Etherscan getApprovals if key present (tier-dependent).
    if (ETHERSCAN_KEY && ETHERSCAN_CHAIN[chain] !== undefined) {
        const r = await fetchEtherscanApprovals(chain, w);
        if (r.approvals.length > 0) return r;
    }
    // 2) Try Covalent if key present.
    if (COVALENT_KEY && COVALENT_CHAIN[chain]) {
        const r = await fetchCovalent(chain, w);
        if (r.approvals.length > 0) return r;
    }
    // 3) Working free fallback: tokentx + allowance eth_call.
    return await fetchViaTokenTx(chain, w);
}

async function fetchEtherscanApprovals(chain: string, wallet: string): Promise<RawSignals> {
    const url =
        `https://api.etherscan.io/v2/api?chainid=${ETHERSCAN_CHAIN[chain]}` +
        `&module=account&action=getApprovals&address=${wallet}&apikey=${ETHERSCAN_KEY}`;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        const json = (await res.json()) as any;
        if (json.status !== "1" || !Array.isArray(json.result)) {
            return { approvals: [], source: "etherscan-" + (json.message ?? "na") };
        }
        const approvals = json.result
            .map((it: any) => normalize(it, "etherscan"))
            .filter((a: RawApproval | null): a is RawApproval => a !== null);
        return { approvals, source: "etherscan" };
    } catch (e: any) {
        return { approvals: [], source: "etherscan-error", error: e?.message };
    }
}

async function fetchCovalent(chain: string, wallet: string): Promise<RawSignals> {
    const url =
        `https://api.covalenthq.com/v1/${COVALENT_CHAIN[chain]}/address/${wallet}/approvals/` +
        `?key=${COVALENT_KEY}&page-size=500`;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) return { approvals: [], source: "covalent-http-" + res.status };
        const json = (await res.json()) as any;
        const items: any[] = json?.data?.items ?? [];
        if (!items.length) return { approvals: [], source: "covalent-empty" };
        const approvals = items
            .map((it) => normalize(it, "covalent"))
            .filter((a: RawApproval | null): a is RawApproval => a !== null);
        return { approvals, source: "covalent" };
    } catch (e: any) {
        return { approvals: [], source: "covalent-error", error: e?.message };
    }
}

// Free fallback: discover tokens via Etherscan tokentx, then read allowance
// to each major spender via RPC eth_call. Token list is capped and calls run
// with bounded concurrency so a single scan stays well under the 60s budget.
const MAX_TOKENS = 20;
const CONCURRENCY = 12;

async function fetchViaTokenTx(chain: string, wallet: string): Promise<RawSignals> {
    if (!ETHERSCAN_KEY || ETHERSCAN_CHAIN[chain] === undefined) {
        return { approvals: [], source: "no-free-source" };
    }
    try {
        const allTokens = await discoverTokens(chain, wallet);
        if (allTokens.length === 0) return { approvals: [], source: "etherscan-tokentx-empty" };
        const tokens = allTokens.slice(0, MAX_TOKENS);
        const tokenMeta = new Map<string, { sym: string; name: string }>();
        for (const t of tokens) tokenMeta.set(t.address, { sym: t.sym, name: t.name });

        const rpcList = ANKR_KEY
            ? [`https://rpc.ankr.com/${chainSlug(chain)}/${ANKR_KEY}`, ...(RPCS[chain] ?? [])]
            : (RPCS[chain] ?? []);
        const provider = new ethers.JsonRpcProvider(rpcList[0]);

        const found: RawApproval[] = [];
        // Build the full (token, spender) job list, then run with a pool.
        const jobs: { token: string; sym: string; name: string; sp: { address: string; name: string } }[] = [];
        for (const t of tokens) {
            for (const sp of MAJOR_SPENDERS) jobs.push({ token: t.address, sym: t.sym, name: t.name, sp });
        }

        let cursor = 0;
        const worker = async () => {
            while (cursor < jobs.length) {
                const i = cursor++;
                const { token, sym, name, sp } = jobs[i];
                try {
                    const contract = new ethers.Contract(token, ERC20_ABI, provider);
                    const allowanceBn: bigint = await contract.allowance(wallet, sp.address);
                    if (allowanceBn === 0n) continue;
                    const isUnlimited = allowanceBn >= (BigInt(MAX_UINT256) * 99n) / 100n;
                    found.push({
                        spender: sp.address,
                        tokenAddress: token,
                        tokenSymbol: sym,
                        tokenName: name,
                        allowance: allowanceBn.toString(),
                        isUnlimited,
                        riskLevel: "safe",
                        riskTags: [sp.name],
                        source: "tokentx+allowance",
                    });
                } catch {
                    // skip unreadable pair
                }
            }
        };
        await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

        return { approvals: found, source: "tokentx+allowance" };
    } catch (e: any) {
        return { approvals: [], source: "tokentx-error", error: e?.message };
    }
}

async function discoverTokens(
    chain: string,
    wallet: string
): Promise<{ address: string; sym: string; name: string }[]> {
    const url =
        `https://api.etherscan.io/v2/api?chainid=${ETHERSCAN_CHAIN[chain]}` +
        `&module=account&action=tokentx&address=${wallet}&page=1&offset=100&sort=desc&apikey=${ETHERSCAN_KEY}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const json = (await res.json()) as any;
    if (json.status !== "1" || !Array.isArray(json.result)) return [];
    const map = new Map<string, { address: string; sym: string; name: string }>();
    for (const tx of json.result) {
        const addr = (tx.contractAddress ?? "").toLowerCase();
        if (!addr) continue;
        if (!map.has(addr)) {
            map.set(addr, {
                address: addr,
                sym: tx.tokenSymbol ?? "",
                name: tx.tokenName ?? "",
            });
        }
    }
    return [...map.values()];
}

function chainSlug(chain: string): string {
    return (
        { ethereum: "eth", bsc: "bsc", base: "base", arbitrum: "arbitrum", polygon: "polygon", xlayer: "xlayer" } as Record<string, string>
    )[chain] ?? chain;
}

function normalize(it: any, source: string): RawApproval | null {
    const token = (it.tokenAddress ?? it.token_address ?? "").toLowerCase();
    const spender = (it.spender ?? it.spender_address ?? "").toLowerCase();
    if (!ethers.isAddress(token) || !ethers.isAddress(spender)) return null;
    const allowanceRaw = String(it.allowance ?? it.value ?? "0");
    let isUnlimited = false;
    try {
        isUnlimited = BigInt(allowanceRaw) >= (BigInt(MAX_UINT256) * 99n) / 100n;
    } catch {
        isUnlimited = false;
    }
    const trusted = MAJOR_SPENDERS.find((s) => s.address.toLowerCase() === spender);
    const malicious = KNOWN_MALICIOUS_SPENDERS[spender];
    let riskLevel: RawApproval["riskLevel"] = "unknown";
    const riskTags: string[] = [];
    if (malicious) {
        riskLevel = "danger";
        riskTags.push(malicious);
    } else if (trusted) {
        riskLevel = "safe";
        riskTags.push(trusted.name);
    } else {
        riskLevel = "warning";
        riskTags.push("unverified spender");
    }
    return {
        spender,
        tokenAddress: token,
        tokenSymbol: it.tokenSymbol ?? it.token_symbol ?? "",
        tokenName: it.tokenName ?? it.token_name ?? "",
        allowance: allowanceRaw,
        isUnlimited,
        riskLevel,
        riskTags,
        source,
    };
}
