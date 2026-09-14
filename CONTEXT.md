# LexCerta

LexCerta supplies citation and quotation evidence to lawyers through their AI hosts, while protecting upstream evidence services.

## Language

**Customer**:
A person or organization authorized to use LexCerta. The initial paying Customer is an individual lawyer using Claude or ChatGPT.
_Avoid_: Client, user, account

**LexCerta subscription**:
Monthly paid access to LexCerta held by an individual lawyer, with an included subscription allowance.
_Avoid_: AI-host subscription, API key

**Subscription allowance**:
The review credits included in a LexCerta subscription, shared across the Customer's Claude and ChatGPT connections. It is separate from API key limits and the service-wide CourtListener budget.
_Avoid_: API key limit, CourtListener budget

**Review credit**:
The usage unit for reviewing one supplied draft or for the intermediate checks and final review within one drafting request, subject to published workload limits. Credits are included in the subscription allowance or purchased separately; the unit does not itself determine when a review is charged.
_Avoid_: Tool call, token, citation check

**Prepaid credits**:
Review credits bought through an explicit Customer purchase in addition to the monthly subscription allowance, usable across the Customer's Claude and ChatGPT connections.
_Avoid_: Automatic overage, subscription allowance

**Customer pilot**:
A limited evaluation of LexCerta in its intended Customers' actual AI workflows.
_Avoid_: Developer integration test, paid launch

**AI host**:
The AI application in which a Customer works and which invokes LexCerta on their behalf. Claude and ChatGPT are the initial target hosts.
_Avoid_: Customer, evidence source

**Draft verification**:
A Customer-requested review in which LexCerta identifies the case citations and quotations in a submitted draft, with item-by-item findings, supporting source links, unresolved items, and review coverage presented in the AI host.
_Avoid_: Legal approval, hallucination-free certification

**Verification during drafting**:
Evidence checks the AI host requests from LexCerta while creating a draft for the Customer.
_Avoid_: LexCerta document generation, general legal research

**Submitted draft**:
The version of a Customer's draft supplied to LexCerta for a particular draft verification.
_Avoid_: Evidence source, opinion text

**Technical retry**:
Another attempt to carry out the same draft verification after a technical interruption or failure, without a new Customer request for a review.
_Avoid_: Recheck, new review

**Recheck**:
A Customer's deliberate request for another draft verification of a revised or unchanged draft.
_Avoid_: Technical retry

**Review coverage**:
The extent to which a draft's relevant citations and quotations have been identified and addressed, reported as complete only when whole-draft coverage is established and partial otherwise. Coverage is separate from each item's verification outcome.
_Avoid_: All citations verified, source-search completeness

**Verification report**:
The Customer-facing record of a draft verification, containing item-by-item findings, draft locations, supporting source links, review coverage, unresolved items, the review date, and stated limitations.
_Avoid_: Legal opinion, approval certificate

**Reference test set**:
A collection of test drafts with lawyer-reviewed expected citation, quotation, pinpoint, and review-coverage findings for evaluating draft verification.
_Avoid_: Universal accuracy guarantee, Customer pilot

**LexCerta API key**:
A credential issued to a caller that authorizes use of LexCerta's verification service. It is distinct from credentials LexCerta uses to access upstream legal-data providers.
_Avoid_: CourtListener API key, MCP session ID, client token

**Supported MCP client**:
A server-side or installed machine client capable of invoking LexCerta's tools and protecting its access credentials; direct browser callers are outside the launch scope.
_Avoid_: Browser SDK, public frontend token

**Operator-issued key**:
A LexCerta API key created and delivered directly by the service operator rather than through a self-service account workflow.
_Avoid_: Manual token, admin key

**API key record**:
The authoritative record of an issued LexCerta API key, containing its non-reversible identifier and lifecycle information but never the plaintext credential.
_Avoid_: Raw key, secret record

**API key limit**:
A configurable usage allowance attached to one LexCerta API key. It is independent of both billable usage and the service-wide CourtListener budget.
_Avoid_: CourtListener budget, tool scope

**CourtListener budget**:
The authoritative, service-wide allowance for outbound CourtListener requests. It counts every request LexCerta actually sends, is independent of Customer usage limits, and is based only on limits confirmed by CourtListener.
_Avoid_: Per-customer quota, Worker-local rate limit, assumed quota

**Evidence source**:
The external legal-data collection searched to support a verification outcome. CourtListener is LexCerta's sole launch evidence source, and every response identifies that scope; `not_found` never means that an authority or quotation does not exist anywhere.
_Avoid_: Ground truth, universal search

**Evidence provenance**:
Metadata that lets a caller inspect the source, age, and completeness of a verification outcome without LexCerta returning legal text.
_Avoid_: Evidence payload, opinion excerpt

**Verification scope**:
The jurisdictions, authority types, and citation formats for which LexCerta offers evidence checks. Authorities outside that scope remain accounted for in draft verification without being represented as verified.
_Avoid_: Review coverage, universal legal coverage

**Citation verification**:
Checking whether a supported case-law reporter citation can be supported by LexCerta's available legal-data sources. Exposed through the `verify_citation` tool.
_Avoid_: West citation verification

**Citation parsing**:
Recognizing a supported case-law reporter citation in `volume reporter page` form and converting its base citation into normalized components. A trailing pin cite or parenthetical is preserved as an uninterpreted suffix. Its outcome is either `parsed` or `unrecognized`; parsing alone does not verify that the cited authority exists.
_Avoid_: Citation verification, valid citation

**Citation resolution**:
Linking a short citation or reference to an earlier full citation when the submitted draft establishes one unambiguous authority. Missing or ambiguous references remain unresolved; resolution alone does not verify the authority or its pinpoint location.
_Avoid_: Citation parsing, citation verification

**Quote verification**:
Checking whether quoted text appears in any opinion associated with a citation after safe textual normalization. One exact match establishes `verified`; `not_found` requires every opinion in the case cluster to have been searched successfully. An incomplete or over-limit cluster search is `indeterminate`. Fuzzy similarity may identify a comparison candidate but does not establish verification without a separately calibrated policy. Exposed through the `verify_quote` tool.
_Avoid_: Quote integrity judgment

**Edited quotation comparison**:
A comparison of an edited quotation's unchanged text segments against a single source passage when the full quotation does not match exactly. Its findings require manual review and do not establish an exact quotation match or approval of the editorial changes.
_Avoid_: Verified edited quotation, fuzzy verification

**Pinpoint verification**:
Checking whether a matched quotation appears at the cited pinpoint page using reliable source pagination, with a separate confirmed, mismatched, or unverified finding. A quotation match alone does not confirm its pinpoint citation.
_Avoid_: Citation existence, quotation match

**Canonical opinion text**:
The evidence-source opinion representation selected for exact quote verification and identified in evidence provenance.
_Avoid_: Regex-stripped HTML, unspecified opinion text

**Verification outcome**:
The evidence status returned by citation or quote verification: `verified` when supporting evidence was found, `not_found` when the searched source contained no supporting record, or `indeterminate` when verification could not be completed. These outcomes do not by themselves establish fabrication, current legal status, or support for a draft's legal argument.
_Avoid_: Hallucination detected, valid boolean

**Tool contract**:
The versioned public meaning and shape of LexCerta's MCP tools and their outcomes.
_Avoid_: Endpoint version, silent breaking change

**Source cache**:
LexCerta's durable copy of retrieved legal-source data, reused subject to explicit freshness and retention policies.
_Avoid_: Permanent truth store, Worker-local LRU

**Source freshness**:
Whether cached legal-source data is within its revalidation window. Freshness is distinct from how long the source data is retained.
_Avoid_: Immutable forever, silent stale result

**Source contradiction**:
A fresh evidence-source observation that conflicts with retained positive evidence and must be resolved before LexCerta returns a conclusive outcome.
_Avoid_: Immediate negative overwrite, silent source change

**Operational telemetry**:
Sanitized measurements and events used to operate LexCerta without retaining Customer-submitted citations, quotation text, opinion text, plaintext credentials, or authorization headers.
_Avoid_: Payload log, request dump

## Additional runtime vocabulary

**Source observation**:
A dated observation of a citation or opinion from an identified evidence source.
_Avoid_: Legal truth

**Verified citation**:
A supported citation for which CourtListener provides matching case evidence. It makes no claim about the accuracy of a case name, pin cite, legal proposition, or subsequent treatment.
_Avoid_: Hallucination-free authority, good law

**Verified quotation**:
A quotation found exactly after safe normalization in an identified opinion representation. Presence does not establish that the text is a majority holding or supports the argument that quotes it.
_Avoid_: Verified argument, legally correct quotation

**Source-scoped miss**:
A complete supported search that found no matching evidence in CourtListener.
_Avoid_: Fabrication, hallucination detected, universal nonexistence

**Indeterminate check**:
A check that cannot establish a positive or complete negative result because evidence is incomplete, unsupported, unavailable, or exceeds supported limits.
_Avoid_: Invalid citation, fabricated quote

**Evidence freshness**:
Whether an observation remains inside its disclosed revalidation interval. Freshness describes retrieval age, not whether an opinion remains good law.

**Complete quote search**:
A search that inspected all required available opinion representations in the cited case cluster under the declared matching policy.
_Avoid_: Complete legal research

**Release candidate**:
An immutable service artifact that has passed its engineering and staging acceptance gates.
_Avoid_: Validated MVP
