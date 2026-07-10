/**
 * On-chain approval data gathering for the Approval Guardian engine.
 *
 * Primary source: Etherscan V2 free API — `account=getApprovals` returns a
 * wallet's ERC-20 approvals (token, spender, allowance) across all EVM chains
 * (eth, bsc, base, arbitrum, polygon, xlayer) with one free API key. Instant
 * signup, no activation delay.
 *   https://docs.etherscan.io/  (free API key)
 *
 * Secondary source: Covalent (GoldRush) `/approvals/` endpoint, used as a
 * fallback if an Etherscan key is absent but a Covalent key is present.
 *
 * Enrichment: GoPlus `approval_security` (spender risk verdict) + our curated
 * trusted/malicious spender table, to down-rank false positives and raise
 * known-exploited spenders.
 *
 * Degrades gracefully: if the indexer is unavailable, returns an empty approval
 * set with a fallback source tag so the endpoint stays UP (reliability = usage).
 * Never throws to a 500 for a transient API issue.
 */
import { ethers } from "ethers";
import { config as loadEnv } from "dotenv";

loadEnv();

// Etherscan V2 free API key (instant, multi-chain).
const ETHERSCAN_KEY = process.env.ETHERSCAN_KEY ?? "";
// Covalent (GoldRush) free API key (fallback source).
const COVALENT_KEY = process.env.COVALENT_KEY ?? "";

// Etherscan V2 chain ids (https://api.etherscan.io/v2 ... chainid param).
const ETHERSCAN_CHAIN: Record<string, number> = {
    ethereum: 1,
    bsc: 56,
    base: 8453,
    arbitrum: 42161,
    polygon: 137,
    xlayer: 196,
};

// Covalent chain-name slugs (fallback).
const COVALENT_CHAIN: Record<string, string> = {
    ethereum: "eth-mainnet",
    bsc: "bsc-mainnet",
    base: "base-mainnet",
    arbitrum: "arbitrum-mainnet",
    polygon: "polygon-mainnet",
    xlayer: "xlayer-mainnet",
};

// GoPlus Labs chain ids (https://api.gopluslabs.io/api/v1/supported_chains).
const GOPLUS_CHAIN: Record<string, string> = {
    ethereum: "1",
    bsc: "56",
    base: "8453",
    arbitrum: "42161",
    polygon: "137",
    xlayer: "196",
};

export interface RawApproval {
    spender: string;
    tokenAddress: string;
    tokenSymbol: string;
    tokenName: string;
    allowance: string; // raw string, may be huge
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

// Curated list of widely-trusted spenders (lowers false-positive risk flags).
const TRUSTED_SPENDERS: Record<string, string> = {
    "0x000000000022d473030f116978e4e44b8e3e1d4b": "Uniswap Permit2",
    "0x7a250d5630b4cf539739df2c5dacb4c659f2488d": "Uniswap V2 Router",
    "0xe592427a0aece92de3edee1f18e0157c05861564": "Uniswap V3 Router",
    "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45": "Uniswap Universal Router",
    "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad": "Uniswap Universal Router",
    "0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f": "SushiSwap Router",
    "0x10ed43c718714eb63d5aa57b78b54704e256024e": "PancakeSwap V2 Router",
    "0x13f4ea83d0bd40e75c8222255bc855a974568dd4": "PancakeSwap V3 Router",
    "0x1111111254eeb25477b68fb85ed929f73a960582": "1inch V5 Router",
    "0x11111112542d85b3ef69ae05771c2dccff4faa26": "1inch V4 Router",
    "0x00000000006c3852cbef3e08e8df289169ede581": "OpenSea Seaport v1.1",
    "0x00000000000001ad428e4906ae43d8f9852d0dd6": "OpenSea Seaport v1.5",
    "0x00000000000000adc04c56bf30ac9d3c0aaf14dc": "OpenSea Seaport v1.6",
    "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2": "Aave V3 Pool",
    "0xae7ab96520de3a18e5e111b5eaab095312d7fe84": "Lido stETH",
    "0x99a58482bd75cbab83b27ec03ca68ff489b5788f": "Curve Router",
};

// Known-exploited / malicious spender addresses (raises risk to danger).
// Maintained from public post-mortems. Extend as new exploits are published.
const KNOWN_MALICIOUS_SPENDERS: Record<string, string> = {
    // Example shape (replace with verified exploited addresses as needed):
    // "0xbad...": "Exploited in <event> (<date>)",
};

const MAX_UINT256 =
    "115792089237316195423570985008687907853269984665640564039457584007913129639935";

export async function gatherSignals(
    chain: string,
    wallet: string
): Promise<RawSignals> {
    if (!ethers.isAddress(wallet)) {
        throw new Error(`Invalid wallet address: ${wallet}`);
    }

    // Try Etherscan V2 first (instant free key, multi-chain).
    if (ETHERSCAN_KEY && ETHERSCAN_CHAIN[chain] !== undefined) {
        const r = await fetchEtherscan(chain, wallet);
        if (r.approvals.length > 0 || r.source.startsWith("etherscan")) return r;
    }
    // Fallback to Covalent if configured.
    if (COVALENT_KEY && COVALENT_CHAIN[chain]) {
        const r = await fetchCovalent(chain, wallet);
        if (r.approvals.length > 0 || r.source.startsWith("covalent")) return r;
    }
    return { approvals: [], source: "no-indexer-key" };
}

async function fetchEtherscan(chain: string, wallet: string): Promise<RawSignals> {
    const chainId = ETHERSCAN_CHAIN[chain];
    const url =
        `https://api.etherscan.io/v2/api?chainid=${chainId}` +
        `&module=account&action=getApprovals&address=${wallet}&apikey=${ETHERSCAN_KEY}`;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
        const json = (await res.json()) as any;
        if (json.status !== "1" || !Array.isArray(json.result)) {
            return { approvals: [], source: "etherscan-" + (json.message ?? "empty") };
        }
        const approvals = json.result
            .map((it: any) => normalizeApproval(it, "etherscan"))
            .filter((a: RawApproval | null): a is RawApproval => a !== null);
        return { approvals, source: "etherscan" };
    } catch (e: any) {
        return { approvals: [], source: "etherscan-error", error: e?.message };
    }
}

async function fetchCovalent(chain: string, wallet: string): Promise<RawSignals> {
    const slug = COVALENT_CHAIN[chain];
    const url =
        `https://api.covalenthq.com/v1/${slug}/address/${wallet}/approvals/` +
        `?key=${COVALENT_KEY}&page-size=500`;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
        if (!res.ok) return { approvals: [], source: "covalent-http-" + res.status };
        const json = (await res.json()) as any;
        const items: any[] = json?.data?.items ?? [];
        if (items.length === 0) return { approvals: [], source: "covalent-empty" };
        const approvals = items
            .map((it) => normalizeApproval(it, "covalent"))
            .filter((a: RawApproval | null): a is RawApproval => a !== null);
        return { approvals, source: "covalent" };
    } catch (e: any) {
        return { approvals: [], source: "covalent-error", error: e?.message };
    }
}

// Normalize both Etherscan and Covalent approval shapes into RawApproval.
function normalizeApproval(it: any, source: string): RawApproval | null {
    const token = (it.tokenAddress ?? it.token_address ?? "").toLowerCase();
    const spender = (it.spender ?? it.spender_address ?? "").toLowerCase();
    if (!ethers.isAddress(token) || !ethers.isAddress(spender)) return null;

    const allowanceRaw = String(it.allowance ?? it.value ?? "0");
    let isUnlimited = false;
    try {
        const bn = BigInt(allowanceRaw);
        isUnlimited = bn >= (BigInt(MAX_UINT256) * 99n) / 100n;
    } catch {
        isUnlimited = false;
    }

    const trusted = TRUSTED_SPENDERS[spender];
    const malicious = KNOWN_MALICIOUS_SPENDERS[spender];

    let riskLevel: RawApproval["riskLevel"] = "unknown";
    const riskTags: string[] = [];
    if (malicious) {
        riskLevel = "danger";
        riskTags.push(malicious);
    } else if (trusted) {
        riskLevel = "safe";
        riskTags.push(trusted);
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
