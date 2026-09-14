# Connection preflight implementation plan

**Goal:** Make the first integration uncertainty observable through a bounded HTTP preflight, without representing a machine probe as Customer qualification.

**Architecture:** A standalone Node CLI calls the deployed MCP boundary. It records only allowlisted facts, never credentials, endpoint URLs, response bodies, or Customer content. It is independent of Worker/Node deployment and does not call CourtListener.

**Tech stack:** Existing Node, Zod, node:test, Biome.

**Spec:** `docs/product-scope.md`, especially Platform findings, Remaining account and qualification work; `/tmp/lexcerta-implementation-handoff-iqm5QU.md` Start implementation steps 1–4.

## Baseline and capability map

Stay on current `main` at `0af4be8`, preserving every pre-existing edit. Fetched and inspected Node checkpoint `65d5259`; it adds PostgreSQL, Node HTTP, and release machinery, but retains MCP 2026-07-28 only and operator-issued bearer admission. It is not merged into this dirty checkout. This slice uses neither runtime's internals and can be carried onto that checkpoint intact.

Existing individual citation/quotation tools do not implement draft inventory, coverage, short-reference resolution, edited comparisons, source pagination, DOCX/PDF intake, report delivery, or credit accounting. Node release fixtures do not qualify either AI host. OAuth account linking and host protocol support are the first integration frontier. Both hosts, all three formats, both workflows, transient handling, reference expectations, pilot participation, and directory approvals remain required. No published document limit or commercial value is invented here.

## First slice

Files: `scripts/connection-preflight.mjs` (CLI), `scripts/connection-preflight-http.mjs` (bounded transport), `scripts/worker-qualification-connection-preflight.test.mjs` (real HTTP and CLI tests), `operations/connection-preflight.md` (usage and evidence limits).

Public seams: command-line environment/exit code/JSON stdout and actual loopback HTTP requests. These follow the handoff's delegated routine engineering authority; do not restart the closed interview.

- [x] Write a failing real-HTTP test: a bearer-only endpoint produces an absent OAuth challenge finding while the synthetic `parse_citation` call succeeds.
- [x] Implement `runPreflight({endpoint, token, timeoutMs})`. Send an unauthenticated modern tools/list request, inspect 401 and the resource_metadata challenge, then an authenticated parse_citation request with fixed synthetic input. Validate response id, schema, exact normalized result, and isError. Do not infer citation existence from parsing.
- [x] Add metadata discovery: fetch only a same-origin advertised metadata URL, without bearer credentials; validate resource identity and HTTPS issuer URLs. Report cross-origin metadata as untested, not invalid (valid upstream configurations may use it).
- [x] Add CLI tests for sanitized diagnostics, rejected credential-bearing URLs, redirects, malformed/oversized bodies, timeouts, incorrect tool results, and successful metadata. All network operations have a deadline and a 64 KiB response bound, with no retries or redirects.
- [x] Run the CLI over an actual loopback HTTP fixture and retain allowlisted evidence. Never label the result host-qualified. Exit 0 means the implemented preflight checks passed only; exit 1 means unmet/untested preflight checks; exit 2 means invalid invocation.
- [x] Run the focused file throughout; run repository full test suite once at the end plus relevant format/lint checks. Document baseline failures separately.
- [x] Use code-review's separate standards and spec reviewers on the exact staged slice, resolve actionable findings, and commit only this slice to the current branch.

## Next implementation boundaries (not completed by this slice)

Reconcile ADR 0006 with the accepted individual account journey using OAuth; retain and qualify ADR 0001 rather than silently enabling legacy sessions. Observe login and tool selection in both hosts, then qualify full-file transfer with synthetic body/footnote/endnote fixtures for pasted text, DOCX, and text PDF. Implement transient inventory and conservative coverage, resolution and verification extensions, transient PDF delivery, and shared retry-safe review accounting. Run lawyer-reviewed reference cases before invitations; measure/publish intake limits. The Customer pilot and directory approvals require external evidence and preserve the existing source-permission/release gates.

## Executed evidence

September 14: focused CLI/HTTP suite passed (16 cases), including the real MCP handler; Biome check and repository typecheck passed. Full `npm test` passed 562 cases before two review regressions were added; the focused suite then passed both new cases. The standards review had no findings. The spec review caught malformed content blocks being accepted; validation was tightened to the parser's plain text result contract and the regression passed. A second regression prevents another authentication scheme's realm being interpreted as Bearer discovery. No host session, OAuth authorization, production endpoint, or CourtListener request was used.

The manual CLI run returned unauthenticated HTTP 401, parsing HTTP 200 with `passed`, and OAuth metadata `not_advertised`, leaving overall `passed: false`. This is the expected result for the real-handler fixture and cannot qualify either host. Prior unrelated dirty files, including the confirmed scope record, remain untouched and uncommitted; transporting this checkout still requires carrying those artifacts as warned by the handoff.

Final validation after the review fixes: full `npm test` passed all 564 tests (468 primary, 39 Worker qualification including 16 preflight cases, 2 telemetry, 39 admin, 16 deployment). Spec re-review closed with no remaining actionable findings; Standards had none. No implementation or qualification claim extends beyond this bounded slice.
