# Requirements: LexCerta

**Defined:** 2026-02-13
**Core Value:** Every legal citation returned by the system is verified against authoritative sources -- no hallucinated cases pass through.

## v1.1 Requirements

Requirements for Launch & Monetization milestone. Each maps to roadmap phases.

### Infrastructure

- [x] **INFRA-01**: Project converts to Next.js App Router with MCP endpoint at app/api/mcp/[transport]/route.ts
- [ ] **INFRA-02**: Supabase database schema deployed with tables for accounts, API keys, usage records, and credit balances
- [x] **INFRA-03**: Existing MCP tools (parse, verify, quote) continue working after migration

### Authentication

- [ ] **AUTH-01**: User can sign up with email and password
- [ ] **AUTH-02**: User can log in with email and password
- [ ] **AUTH-03**: User can sign in with Google OAuth
- [ ] **AUTH-04**: User can create a named API key and copy it once at creation
- [ ] **AUTH-05**: User can revoke an API key immediately
- [ ] **AUTH-06**: User can manage multiple API keys per account (up to 5)
- [ ] **AUTH-07**: MCP endpoint rejects requests without a valid API key (Bearer token)

### Billing

- [ ] **BILL-01**: User can subscribe to Solo plan ($20/mo) via Stripe Checkout
- [ ] **BILL-02**: User receives 500 weighted credits on subscription payment
- [ ] **BILL-03**: User can purchase credit pack ($50/1,000 credits) via Stripe Checkout
- [ ] **BILL-04**: Purchased credits never expire
- [ ] **BILL-05**: Stripe webhooks process subscription lifecycle events and provision credits
- [ ] **BILL-06**: User can manage billing via Stripe Customer Portal (cancel, update payment, invoices)

### Metering

- [ ] **METR-01**: Each MCP tool call records usage with weighted cost (parse=0, verify=1, quote=1)
- [ ] **METR-02**: User can see remaining credits on dashboard
- [ ] **METR-03**: Paid tools return structured error when credits exhausted, prompting to buy more
- [ ] **METR-04**: User can see usage breakdown by tool type for current billing period

### Dashboard

- [ ] **DASH-01**: Dashboard shows simple default view (credits remaining, buy more, Claude Desktop setup)
- [ ] **DASH-02**: Dashboard has developer view with API keys, per-key usage, per-tool breakdown
- [ ] **DASH-03**: Claude Desktop integration guide generates copy-paste config with user's API key
- [ ] **DASH-04**: User receives 50 free trial credits on signup (no payment required)

## Future Requirements

Deferred to post-launch. Tracked but not in current roadmap.

### Usage Insights

- **USAGE-01**: Usage history chart (7d/30d trend)
- **USAGE-02**: Per-key usage tracking in dashboard
- **USAGE-03**: Usage alerts via email at 75%/90%/100% thresholds

### Access Control

- **ACCS-01**: API key scoping (restrict keys to specific tools)
- **ACCS-02**: Team/organization accounts with shared billing

## Out of Scope

| Feature | Reason |
|---------|--------|
| Custom billing portal UI | Stripe Customer Portal handles this; weeks of PCI-adjacent work avoided |
| Team/organization accounts | Massive RBAC complexity; wait for validated demand from paying customers |
| Usage-based pricing (pay-per-call) | Unpredictable revenue; subscription + credit packs is simpler for both sides |
| Multiple subscription tiers | No usage data yet; design tiers after 3-6 months of real usage patterns |
| Real-time usage streaming | WebSocket infra overkill; page refresh sufficient for billing dashboard |
| Admin panel | Supabase Studio + Stripe Dashboard sufficient for early-stage |
| Per-key rate limiting | Credit balance is natural rate limit; global CourtListener limiter prevents upstream abuse |
| Custom SDK/client library | MCP protocol IS the SDK; document config, don't wrap it |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| INFRA-01 | Phase 7 | Complete |
| INFRA-02 | Phase 8 | Pending |
| INFRA-03 | Phase 7 | Complete |
| AUTH-01 | Phase 8 | Pending |
| AUTH-02 | Phase 8 | Pending |
| AUTH-03 | Phase 8 | Pending |
| AUTH-04 | Phase 9 | Pending |
| AUTH-05 | Phase 9 | Pending |
| AUTH-06 | Phase 9 | Pending |
| AUTH-07 | Phase 9 | Pending |
| BILL-01 | Phase 11 | Pending |
| BILL-02 | Phase 11 | Pending |
| BILL-03 | Phase 11 | Pending |
| BILL-04 | Phase 11 | Pending |
| BILL-05 | Phase 11 | Pending |
| BILL-06 | Phase 11 | Pending |
| METR-01 | Phase 10 | Pending |
| METR-02 | Phase 10 | Pending |
| METR-03 | Phase 12 | Pending |
| METR-04 | Phase 10 | Pending |
| DASH-01 | Phase 12 | Pending |
| DASH-02 | Phase 12 | Pending |
| DASH-03 | Phase 12 | Pending |
| DASH-04 | Phase 8 | Pending |

**Coverage:**
- v1.1 requirements: 24 total
- Mapped to phases: 24
- Unmapped: 0

---
*Requirements defined: 2026-02-13*
*Last updated: 2026-02-13 after roadmap creation*
