# Hackathon execution checklist — Approval Guardian

## Product readiness
- [x] Deliver a working A2MCP service with a clear user problem (approval hygiene)
- [x] Make the endpoint useful for both humans and other agents
- [x] Support a free preview flow plus a paid deep analysis flow
- [x] Include structured output with verdict and evidence

## Adoption and usage
- [x] Design for repeatable per-call usage (copilots call on every wallet connect)
- [x] Use x402 to make each call independently payable and auditable
- [x] Publish the agent publicly and make it discoverable
- [x] Seed real calls and document the usage pattern

## Signal quality
- [x] Build a scoring engine that handles real approval inputs
- [x] Wire GoPlus Labs approval_security as the primary signal source
- [x] Add a curated spender-reputation table (trusted + known-malicious)

## Submission readiness
- [x] Document the value proposition and category fit
- [x] Add a concrete checklist for build-out and launch
- [x] Add usage metrics endpoint to prove adoption
- [x] Prepare a short demo script and submission narrative
