# Roadmap: LexCerta

## Milestones

- v1.0 MVP -- Phases 1-6 (shipped 2026-02-13)
- v1.1 Launch & Monetization -- Phases 7-12 (in progress)

## Phases

<details>
<summary>v1.0 MVP (Phases 1-6) -- SHIPPED 2026-02-13</summary>

- [x] Phase 1: MCP Server Foundation (2/2 plans) -- completed 2026-02-13
- [x] Phase 2: Citation Parsing (1/1 plans) -- completed 2026-02-13
- [x] Phase 3: Citation Verification & Error Handling (2/2 plans) -- completed 2026-02-13
- [x] Phase 4: Caching (1/1 plans) -- completed 2026-02-13
- [x] Phase 5: Quote Verification (2/2 plans) -- completed 2026-02-13
- [x] Phase 6: Production Deployment (1/1 plans) -- completed 2026-02-13

</details>

### v1.1 Launch & Monetization (In Progress)

**Milestone Goal:** Turn LexCerta from an open MCP server into a paid service with user accounts, API key auth, usage metering, and Stripe billing on lexcerta.ai.

- [ ] **Phase 7: Next.js Migration** - Convert to Next.js App Router, preserve existing MCP tools
- [ ] **Phase 8: Supabase Backend & Auth** - Database schema, user accounts, signup/login
- [ ] **Phase 9: API Key Management** - Key CRUD, MCP endpoint authentication middleware
- [ ] **Phase 10: Usage Metering** - Weighted tool call recording, usage display
- [ ] **Phase 11: Stripe Billing** - Subscriptions, credit packs, webhooks, customer portal
- [ ] **Phase 12: Credit Enforcement & Dashboard** - Credit gating, overage handling, polished dashboard

## Phase Details

### Phase 7: Next.js Migration
**Goal**: Existing MCP server runs inside a Next.js App Router project with no functional regressions
**Depends on**: v1.0 complete
**Requirements**: INFRA-01, INFRA-03
**Success Criteria** (what must be TRUE):
  1. Project builds and deploys as a Next.js App Router application on Vercel
  2. MCP clients can call parse_citation, verify_west_citation, and verify_quote_integrity at the new /api/mcp endpoint and get identical results to v1.0
  3. Streamable HTTP transport works for MCP requests (SSE backward compat via mcp-handler)
  4. Top-level /api directory is removed; all routes live under app/api/
**Plans**: 2 plans

Plans:
- [ ] 07-01-PLAN.md — Install Next.js, update configs, create App Router + MCP route handler, remove old api/
- [ ] 07-02-PLAN.md — Deploy to Vercel, verify MCP tools work at new endpoint (checkpoint)

### Phase 8: Supabase Backend & Auth
**Goal**: Users can create accounts and log into a protected dashboard on lexcerta.ai
**Depends on**: Phase 7
**Requirements**: INFRA-02, AUTH-01, AUTH-02, AUTH-03, DASH-04
**Success Criteria** (what must be TRUE):
  1. Supabase database has tables for accounts, api_keys, usage_records, subscriptions, and credit_purchases with Row Level Security policies
  2. User can sign up with email/password and receives 50 free trial credits automatically
  3. User can log in with email/password or Google OAuth and reach a protected dashboard
  4. Unauthenticated visitors are redirected to the login page when accessing dashboard routes
**Plans**: TBD

Plans:
- [ ] 08-01: TBD

### Phase 9: API Key Management
**Goal**: Users can create API keys on the dashboard and MCP clients authenticate with them
**Depends on**: Phase 8
**Requirements**: AUTH-04, AUTH-05, AUTH-06, AUTH-07
**Success Criteria** (what must be TRUE):
  1. User can create a named API key on the dashboard and copy the raw key exactly once at creation
  2. User can see all their API keys (up to 5) with name, prefix, and created date, and revoke any key immediately
  3. MCP endpoint rejects requests missing a valid Bearer token with a structured error response
  4. MCP endpoint accepts requests with a valid Bearer token and routes them to the existing tools
**Plans**: TBD

Plans:
- [ ] 09-01: TBD

### Phase 10: Usage Metering
**Goal**: Every MCP tool call is recorded with weighted cost and users can see their usage
**Depends on**: Phase 9
**Requirements**: METR-01, METR-02, METR-04
**Success Criteria** (what must be TRUE):
  1. Each MCP tool call records a usage entry with the correct weighted cost (parse=0, verify=1, quote=1) to the usage_records table
  2. User can see remaining credits on the dashboard (subscription credits + purchased credits - usage)
  3. User can see a per-tool usage breakdown for the current billing period on the dashboard
**Plans**: TBD

Plans:
- [ ] 10-01: TBD

### Phase 11: Stripe Billing
**Goal**: Users can subscribe to the Solo plan and purchase credit packs through Stripe
**Depends on**: Phase 10
**Requirements**: BILL-01, BILL-02, BILL-03, BILL-04, BILL-05, BILL-06
**Success Criteria** (what must be TRUE):
  1. User can subscribe to the Solo plan ($20/mo) via Stripe Checkout and receives 500 credits upon payment
  2. User can purchase a credit pack ($50/1,000 credits) via Stripe Checkout and the credits never expire
  3. Stripe webhooks correctly process subscription lifecycle events (checkout completed, invoice paid, subscription canceled) and provision/revoke credits in Supabase
  4. User can access Stripe Customer Portal from the dashboard to cancel subscription, update payment method, and view invoices
**Plans**: TBD

Plans:
- [ ] 11-01: TBD

### Phase 12: Credit Enforcement & Dashboard
**Goal**: Paid tools are gated on credit balance and the dashboard provides a polished user experience
**Depends on**: Phase 11
**Requirements**: METR-03, DASH-01, DASH-02, DASH-03
**Success Criteria** (what must be TRUE):
  1. Paid MCP tools (verify, quote) return a structured error with a purchase prompt when credits are exhausted; parse_citation (0 credits) always works
  2. Dashboard default view shows credits remaining, a buy-more button, and Claude Desktop setup instructions
  3. Dashboard developer view shows API keys, per-key usage stats, and per-tool breakdown
  4. Claude Desktop integration guide generates a copy-paste JSON config pre-filled with the user's API key
**Plans**: TBD

Plans:
- [ ] 12-01: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 7 -> 8 -> 9 -> 10 -> 11 -> 12

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. MCP Server Foundation | v1.0 | 2/2 | Complete | 2026-02-13 |
| 2. Citation Parsing | v1.0 | 1/1 | Complete | 2026-02-13 |
| 3. Citation Verification & Error Handling | v1.0 | 2/2 | Complete | 2026-02-13 |
| 4. Caching | v1.0 | 1/1 | Complete | 2026-02-13 |
| 5. Quote Verification | v1.0 | 2/2 | Complete | 2026-02-13 |
| 6. Production Deployment | v1.0 | 1/1 | Complete | 2026-02-13 |
| 7. Next.js Migration | v1.1 | 0/? | Not started | - |
| 8. Supabase Backend & Auth | v1.1 | 0/? | Not started | - |
| 9. API Key Management | v1.1 | 0/? | Not started | - |
| 10. Usage Metering | v1.1 | 0/? | Not started | - |
| 11. Stripe Billing | v1.1 | 0/? | Not started | - |
| 12. Credit Enforcement & Dashboard | v1.1 | 0/? | Not started | - |

---
*Roadmap created: 2026-02-13*
*Last updated: 2026-02-13*
