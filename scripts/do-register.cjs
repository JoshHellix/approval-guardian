// Registers Approval Guardian via onchainos CLI, passing the --service JSON
// as a real argv element (no shell word-splitting).
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const CLI = "C:\\Users\\dell\\onchainos-bin\\onchainos.exe";
const service = JSON.parse(fs.readFileSync("service-draft.json", "utf8"));

const args = [
    "agent", "create",
    "--role", "asp",
    "--name", "Approval Guardian",
    "--description",
    "Pay-per-call wallet approval-exposure auditor: scans ERC-20 approvals for " +
    "unlimited allowances, unverified spenders, and flagged/malicious contracts, " +
    "returning a composite 0-100 safety score with SAFE/REVIEW/AT_RISK/CRITICAL " +
    "verdict and per-approval evidence. Companion to Token Trust Score for full " +
    "on-chain risk coverage.",
    "--picture",
    "https://static.okx.com/cdn/web3/wallet/marketplace/headimages/agent/avatar/ad9e62da-1617-44d5-8286-5f534224d88f.png",
    "--service", JSON.stringify(service),
];

const out = execFileSync(CLI, args, { encoding: "utf8" });
console.log(out);
