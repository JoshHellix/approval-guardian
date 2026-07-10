/**
 * Approval Guardian scoring engine.
 *
 * Differentiator vs single-label approval scanners (e.g. revoke.cash dashboards):
 * instead of just listing approvals, we compute a composite 0-100 wallet
 * SAFETY score from per-approval risk signals and emit structured, evidence-backed
 * verdicts that downstream copilots / wallets call per-session and embed in
 * "before you transact" safety checks.
 *
 * All inputs are public, read-only on-chain data. No private keys, no revokes.
 */

export type Verdict = "SAFE" | "REVIEW" | "AT_RISK" | "CRITICAL";

export interface ApprovalRisk {
    spender: string;
    tokenSymbol: string;
    tokenName: string;
    allowance: string;
    isUnlimited: boolean;
    riskLevel: "safe" | "warning" | "danger" | "unknown";
    riskTags: string[];
    score: number; // 0..100 (100 = safest)
    detail: string;
}

export interface ApprovalGuardianResult {
    chain: string;
    wallet: string;
    safetyScore: number; // 0..100
    verdict: Verdict;
    totalApprovals: number;
    unlimitedApprovals: number;
    dangerousApprovals: number;
    approvals: ApprovalRisk[];
    summary: string;
    evidence: string[];
    dataSources: string[];
    generatedAt: string;
    disclaimer: string;
}

const DISCLAIMER =
    "Automated on-chain approval aggregation only. Not financial advice. " +
    "Scores reflect public data at call time and may change. Verify independently " +
    "before revoking any approval.";

const RISK_SCORE: Record<ApprovalRisk["riskLevel"], number> = {
    safe: 100,
    unknown: 60,
    warning: 35,
    danger: 0,
};

/**
 * Pure scoring function. Kept separate from I/O so it is trivially testable
 * and reusable by an A2A variant later.
 */
export function computeApprovalGuardian(input: {
    chain: string;
    wallet: string;
    approvals: {
        spender: string;
        tokenSymbol: string;
        tokenName: string;
        allowance: string;
        isUnlimited: boolean;
        riskLevel: ApprovalRisk["riskLevel"];
        riskTags: string[];
    }[];
    source?: string;
}): ApprovalGuardianResult {
    const approvals: ApprovalRisk[] = input.approvals.map((a) => {
        const base = RISK_SCORE[a.riskLevel];
        // Unlimited approvals amplify risk: cap safe/unknown scores lower.
        const score = a.isUnlimited ? Math.min(base, a.riskLevel === "safe" ? 85 : 40) : base;
        const detail = buildDetail(
            { spender: a.spender, tokenSymbol: a.tokenSymbol, isUnlimited: a.isUnlimited, riskLevel: a.riskLevel, riskTags: a.riskTags },
            score
        );
        return {
            spender: a.spender,
            tokenSymbol: a.tokenSymbol,
            tokenName: a.tokenName,
            allowance: a.allowance,
            isUnlimited: a.isUnlimited,
            riskLevel: a.riskLevel,
            riskTags: a.riskTags,
            score,
            detail,
        };
    });

    const total = approvals.length;
    const unlimited = approvals.filter((a) => a.isUnlimited).length;
    const dangerous = approvals.filter((a) => a.riskLevel === "danger").length;
    const warnings = approvals.filter((a) => a.riskLevel === "warning").length;

    // Composite safety score: average of per-approval scores, penalized for
    // unlimited exposure and danger count.
    const avg = total > 0 ? approvals.reduce((s, a) => s + a.score, 0) / total : 100;
    const penalty = dangerous * 12 + unlimited * 4 + warnings * 3;
    const safetyScore = Math.max(0, Math.min(100, Math.round(avg - penalty)));

    const verdict: Verdict =
        dangerous > 0
            ? "CRITICAL"
            : unlimited > 0 || warnings > 0
                ? "AT_RISK"
                : total > 0
                    ? "REVIEW"
                    : "SAFE";

    const summary = buildSummary(verdict, total, unlimited, dangerous);

    const evidence = [
        `Total active approvals: ${total}`,
        `Unlimited approvals: ${unlimited}`,
        `Dangerous (flagged) approvals: ${dangerous}`,
        ...approvals
            .filter((a) => a.riskLevel === "danger" || a.riskLevel === "warning" || a.isUnlimited)
            .slice(0, 8)
            .map((a) => `${a.tokenSymbol || "?"}/${shortAddr(a.spender)}: ${a.detail}`),
    ];

    return {
        chain: input.chain,
        wallet: input.wallet,
        safetyScore,
        verdict,
        totalApprovals: total,
        unlimitedApprovals: unlimited,
        dangerousApprovals: dangerous,
        approvals,
        summary,
        evidence,
        dataSources: sourceLabels(input.source),
        generatedAt: new Date().toISOString(),
        disclaimer: DISCLAIMER,
    };
}

function buildDetail(a: { spender: string; tokenSymbol: string; isUnlimited: boolean; riskLevel: ApprovalRisk["riskLevel"]; riskTags: string[] }, score: number): string {
    const parts: string[] = [];
    parts.push(`spender ${shortAddr(a.spender)}`);
    if (a.isUnlimited) parts.push("UNLIMITED allowance");
    else parts.push("limited allowance");
    if (a.riskTags.length) parts.push(`[${a.riskTags.join(", ")}]`);
    parts.push(`risk=${a.riskLevel} (${score}/100)`);
    return parts.join(" · ");
}

function buildSummary(verdict: Verdict, total: number, unlimited: number, dangerous: number): string {
    switch (verdict) {
        case "CRITICAL":
            return `Critical: ${dangerous} approval(s) flagged as dangerous — revoke or investigate before any transaction.`;
        case "AT_RISK":
            return `At risk: ${unlimited} unlimited and/or unverified approval(s) expose this wallet — review before transacting.`;
        case "REVIEW":
            return `Active approvals found but none flagged — periodic review recommended.`;
        case "SAFE":
            return `No active token approvals detected — minimal approval-attack surface.`;
    }
}

function shortAddr(a: string): string {
    if (!a || a.length < 10) return a;
    return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function sourceLabels(source?: string): string[] {
    if (!source) return [];
    const map: Record<string, string> = {
        goplus: "GoPlus Labs approval_security",
        "fallback-no-indexer": "Neutral fallback (chain not indexed)",
        "fallback-http": "Neutral fallback (indexer unavailable)",
        "goplus-empty": "GoPlus Labs (no approvals found)",
        "fallback-error": "Neutral fallback (fetch error)",
    };
    return [map[source] ?? source];
}
