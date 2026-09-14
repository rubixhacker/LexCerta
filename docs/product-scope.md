# LexCerta product scope

The user confirmed this consolidated product scope on September 13, 2026, closing the scope interview. This is the authoritative product-scope record and supersedes conflicting product requirements in earlier briefs and the developer-pilot route; implementation, qualification, and launch status require separate evidence.

## Accepted destination

LexCerta's intended product is a paid, hosted MCP service that connects to a Customer's existing AI workflow and checks whether cited cases and quotations have supporting source evidence.

The supported invocation contexts include reviewing a supplied draft and checking evidence while the AI host creates a draft at the Customer's request.

A Customer pilot is the first validation milestone toward that product. Self-service onboarding and billing follow validation; their exclusion from the pilot does not remove them from the product destination. This decision establishes intent, not evidence of a deployed service, Customer demand, or readiness to accept payment.

The user accepted this definition on September 13, 2026. The distinction preserves the commercial destination while allowing the initial pilot to test the verification workflow.

## Accepted Customer and target hosts

The first Customers are lawyers using Claude or ChatGPT, as clarified by the user on September 13, 2026. Both are target AI hosts. See [ADR 0039](adr/0039-serve-lawyers-through-claude-and-chatgpt.md).

This clarification replaces the developer-Customer recommendation and the earlier developer-pilot wording. Product validation must observe lawyers connecting and using LexCerta in their existing AI host. Developer integration checks establish technical readiness but cannot establish that Customer outcome.

The user raised publication as apps for both hosts as a possible distribution requirement and subsequently accepted the milestone distinction below. Supported account plans require qualification, and the sequence of that work remains part of implementation planning.

## Accepted pilot and public distribution

On September 13, 2026, the user accepted approved directory listings in both Claude and ChatGPT as a public-launch requirement. The invited lawyer Customer pilot uses custom connections and can validate the workflow before directory publication. See [ADR 0039](adr/0039-serve-lawyers-through-claude-and-chatgpt.md).

Public launch requires approval and a published listing in each host's directory. Either platform's review can delay that milestone; a listing in only one host does not satisfy the accepted requirement. Both AI hosts remain in scope.

Custom connections must still demonstrate the actual lawyer workflow and satisfy the host's account, workspace, authentication, and connection requirements. Directory approval does not replace functional qualification, and these distribution milestones do not waive source-permission or release-approval gates.

## Accepted Customer pilot participation and usage

On September 13, 2026, the user accepted a two-week pilot with at least three participating lawyers and the following requirements:

- Both Claude and ChatGPT are represented, with at least one lawyer using each host.
- Each lawyer completes three draft reviews on separate days during the two-week pilot.
- Those three uses include at least one review of a supplied draft and at least one drafting request with LexCerta verification; the third use may follow either workflow.
- Setup help is allowed, but counted reviews are completed without operator guidance.
- Each lawyer reports whether the verification reports were useful in their work.

Counted reviews must follow the accepted lawyer workflow and report-delivery requirements. A guided demonstration or an operator executing the review for the lawyer does not count as independent use.

The user accepted including both workflows on September 13, 2026 without increasing the three-use requirement or the two-week duration. Each lawyer may stay in their preferred AI host; the cohort must still cover both Claude and ChatGPT.

These criteria establish the required participation, repeated use, and Customer feedback. Feedback must be recorded as given, rather than assumed positive from the activity counts; the pilot does not by itself establish willingness to pay or verification accuracy. The reference-test gate below and the remaining technical qualification requirements apply separately.

## Accepted reference-test gate before the pilot

On September 13, 2026, the user accepted passing a lawyer-reviewed reference test set as a requirement before inviting Customer pilot participants. The set must cover both Claude and ChatGPT, pasted text, DOCX, and text-based PDF, and the promised citation, quotation, pinpoint, and review-coverage checks.

Results must match the lawyer-reviewed expectations, including expected positive findings and expected unresolved or partial results. Any incorrect positive finding, or missed item in a report labelled complete, blocks the pilot until fixed. Returning unresolved findings for every item does not pass when the expected findings include established matches.

Passing establishes bounded evidence for the tested cases and qualified behavior, not a universal accuracy guarantee. This requirement does not authorize retention of Customer drafts as test fixtures or change the accepted boundary between source verification and legal assessment.

## Accepted initial commercial model

On September 13, 2026, the user accepted individual lawyers as the initial buyers, with one monthly LexCerta subscription usable across Claude and ChatGPT. Usage draws from one shared subscription allowance across both AI hosts.

Firm-wide purchasing, seat management, and team administration are deferred. The intended paid journey is one lawyer subscribing, connecting their preferred AI host, and reviewing drafts. Subscription price, allowance size, and cancellation and refund terms will be settled after the Customer pilot and before paid launch.

The subscription allowance is distinct from API-key admission limits and the service-wide CourtListener budget. The existing requirement for a written Free Law Project arrangement before accepting payment remains in force.

## Accepted purchasing and billing location

On September 13, 2026, the user accepted LexCerta's website as the place to subscribe, purchase additional review credits, and manage billing. Claude and ChatGPT connect to an existing LexCerta account; lawyers review drafts and receive verification reports inside their chosen AI host. See [ADR 0045](adr/0045-handle-purchases-on-the-lexcerta-website.md).

The same LexCerta subscription and available credits serve both AI-host connections. The website's commercial role does not add a separate website draft-review workflow or retained report history to the accepted scope.

The ChatGPT plugin must respect OpenAI's documented commerce boundary: it may explain an unavailable entitlement and link to an informational page, but must not sell subscriptions or credits, promote upgrades, or link to a page that initiates a purchase. Detailed account linking and checkout implementation remain follow-ups; this decision does not establish directory approval.

## Accepted subscription usage unit

On September 13, 2026, the user accepted draft reviews as the subscription usage unit: one review credit per submitted draft, within published document-size and citation limits. The shared subscription allowance is expressed in review credits.

This establishes the Customer-facing unit; charging and repeated-review rules are defined below. Checks within one drafting request are grouped under the accepted drafting-charge rule. Numeric intake and workload limits remain to be established through qualification. Internal tool calls and upstream requests retain their separate operational accounting.

## Accepted review-charging condition

On September 13, 2026, the user accepted deducting a review credit only when a complete-coverage verification report is successfully delivered. Failed or partial reviews consume no credit, including source outages that prevent checks.

A completed review still consumes a credit when it finds missing citations or mismatched quotations. The credit pays for the completed checking, not for a favorable finding. Review coverage remains separate from each item's verification outcome.

Complete coverage alone does not override the no-charge rule for service failures: accounting for every item as unresolved because of a source outage does not make that review chargeable. These charging rules do not alter verification findings or operational request accounting.

## Accepted charging for drafting

On September 13, 2026, the user accepted at most one review credit for a drafting request, covering its intermediate evidence checks and final whole-draft review within published workload limits. Internal revisions and technical retries add no extra charge.

The credit is deducted only when the final complete-coverage verification report is delivered under the existing completion and delivery conditions. Failed or partial verification, including source outages that prevent checks, remains uncharged. The number of internal tool calls or intermediate draft versions does not multiply the Customer's credit charge.

A later, deliberately requested recheck remains a new review under the accepted recheck policy. Numeric workload limits still require qualification and publication; grouping checks under one credit does not promise unlimited processing for a drafting request.

## Accepted retries and rechecks

On September 13, 2026, the user accepted a deliberate recheck as a new review, whether the Customer supplies a revised draft or requests a fresh check of an unchanged draft. It consumes one review credit only when the accepted completion and delivery conditions are met.

Technical retries belong to the original review and must never cause a second charge. A retry that completes a previously uncharged review may result in that review's first charge under the same completion conditions. A repeated tool attempt alone does not establish a deliberate Customer request for a recheck.

This distinction applies across both AI hosts and does not authorize retention of Customer draft or report content. The mechanism for recognizing the same review across retries remains an implementation follow-up.

## Accepted additional-credit purchases

On September 13, 2026, the user accepted optional prepaid purchases of additional review credits when the monthly subscription allowance runs out. Each purchase requires the Customer's explicit choice; there are no automatic overage charges or automatic purchases of extra credits.

Prepaid credits are usable across the Customer's Claude and ChatGPT connections. The same completion, delivery, failure, and retry charging rules apply regardless of whether a credit came from the monthly allowance or a separate purchase.

This gives a lawyer facing a deadline a way to continue reviewing without waiting for renewal. Purchases take place on LexCerta's website; detailed checkout design, pricing, purchase quantities, and treatment after subscription cancellation remain open decisions.

## Accepted credit carry-forward and consumption order

On September 13, 2026, the user accepted resetting monthly included credits at subscription renewal, with unused included credits not carried into the next billing period. Separately purchased prepaid credits carry forward across renewals; renewal does not reset that balance.

Monthly included credits are consumed before prepaid credits, preserving separately purchased credits for usage beyond the monthly allowance. This ordering applies to the Customer's usage across both AI hosts and retains the accepted completion and retry charging rules.

This decision addresses renewal and consumption order. Treatment of unused prepaid credits after subscription cancellation remains open.

## Accepted timing for remaining commercial details

On September 13, 2026, the user accepted settling the remaining commercial details after the lawyer Customer pilot and before paid launch. Pilot evidence on operating costs and repeat usage will inform subscription and prepaid-credit prices and included and purchased credit quantities.

Cancellation and refund terms, including treatment of unused prepaid credits after cancellation, must be finalized before accepting payment. These details are deferred decisions, not omitted product requirements. The accepted subscription model, charging conditions, retry protection, prepaid-purchase rule, and renewal behavior remain the baseline.

This timing does not waive the existing requirement for a written Free Law Project arrangement before accepting payment or any source-permission requirements applicable to the pilot.

## Accepted review of a supplied draft

On September 13, 2026, the user accepted an explicit draft-verification request as the first useful Customer interaction:

> Check the case citations and quotations in this draft.

The lawyer makes this request in Claude or ChatGPT. The AI host invokes LexCerta and presents the items checked, supporting source links, and unresolved items in the conversation. This remains a workflow the Customer pilot must demonstrate.

The workflow establishes an explicit request and the visible findings. The handoff of the full draft from the AI host remains to be qualified. Existing source-scoped verification outcomes continue to govern the meaning of each finding.

## Accepted verification during drafting

On September 13, 2026, the user added the requirement that the AI host can call LexCerta when asked to create a draft. A drafting request is therefore a supported invocation context; the lawyer need not first supply a finished draft and separately request its verification. See [ADR 0046](adr/0046-support-verification-during-drafting.md).

Claude or ChatGPT creates the draft and invokes LexCerta for citation and quotation evidence checks as part of that task. The accepted source scope, meaning of findings, and transient handling of Customer content continue to apply. A whole-draft coverage claim still requires checking the relevant submitted version under the accepted coverage rules; individual calls made during drafting do not establish that claim.

The drafting sequence and final-review requirement are defined below, and intermediate checks are included under the accepted charging rule for drafting. Every pilot lawyer must exercise this workflow as well as reviewing a supplied draft. The existing per-tool contracts do not by themselves establish that either host will select and use LexCerta correctly during drafting; this interaction needs qualification in both hosts.

## Accepted drafting sequence and final review

On September 13, 2026, the user accepted checking evidence while the AI host writes, followed by a whole-draft check of the final version before handing it over. The AI host checks proposed citations and quotations, revises or flags unresolved material, and then submits the final whole draft for review.

The Customer receives the resulting draft with its verification summary and PDF report. The final review must correspond to the exact draft delivered; findings for an earlier version must not be presented as covering later changes. Individual checks made during writing cannot substitute for this final review.

If verification cannot finish, the returned draft must be clearly identified as only partially checked, with unresolved work visible. A complete review still does not mean that every item verified, and the accepted source-verification and legal-assessment boundaries continue to apply.

## Accepted review coverage

On September 13, 2026, the user accepted whole-draft coverage reporting as a launch requirement. See [ADR 0040](adr/0040-require-whole-draft-coverage-accounting.md).

The report must account for citations and quotations item by item. A review may be called complete only when there is evidence that the draft's relevant citations and quotations were identified and addressed; otherwise it must be marked partial. Unsupported or unresolved items remain visible in the report.

Review coverage and verification outcomes are separate: accounting for every item does not mean that every item verified. Successful checks on a subset of a draft do not establish whole-draft coverage.

## Accepted draft processing and retention

On September 13, 2026, the user agreed that LexCerta receives the full draft and identifies its citations and quotations itself, using transient processing with no retained draft content. See [ADR 0041](adr/0041-process-full-drafts-transiently-for-coverage.md).

LexCerta builds an inventory tied to the submitted draft and reconciles the identified items against the verification findings. A list of citations selected by the AI host alone does not satisfy this processing boundary. Receiving a draft does not itself establish extraction completeness; the accepted coverage requirement still applies.

Customer draft content, including extracted Customer text, must not persist in LexCerta's storage, logs, traces, or backups after processing. This is a LexCerta handling requirement, not a claim about an AI host's separate retention policy or an implemented guarantee. Existing source-cache policies continue to govern independently retrieved evidence-source data.

## Accepted launch input formats

On September 13, 2026, the user accepted pasted text, Word `.docx`, and text-based PDFs for the first release. Review includes footnotes and endnotes as well as body text.

Scanned documents and images requiring OCR are deferred. Unreadable sections must be explicitly reported and prevent a complete-coverage claim. A supported file extension alone does not establish that its contents were fully transferred or extracted.

## Accepted document-limit policy

On September 13, 2026, the user accepted establishing document limits from end-to-end testing of the full upload-to-report workflow in both AI hosts and publishing supported limits before the Customer pilot. Numeric limits remain to be established by those measurements.

Drafts exceeding the supported limits are rejected with a clear explanation and consume no review credit. LexCerta must not silently truncate an oversized draft or automatically split it into multiple chargeable reviews. These limits apply alongside the accepted input-format and review-coverage requirements.

## Accepted launch verification scope

On September 13, 2026, the user accepted U.S. federal and state case law, using supported citation formats and available CourtListener evidence, as the launch verification scope. See [ADR 0042](adr/0042-limit-launch-verification-to-us-case-law.md).

Statutes, regulations, foreign authorities, and secondary sources remain visible in the inventory but are labelled **outside the supported verification scope**. That classification accounts for an item without claiming to verify it. Within supported scope, source-scoped `not_found` and `indeterminate` retain their existing meanings; a source gap alone does not reclassify a case as an unsupported authority.

This scope aligns with CourtListener's [American case-law collection](https://wiki.free.law/c/courtlistener/help/data-coverage/case-law). It does not promise that every U.S. decision is available or that every citation format is supported. The supported-format contract and corpus evidence must remain explicit.

## Accepted meaning of findings

On September 13, 2026, the user accepted source existence and quotation matching as the launch verification claims. The report distinguishes **citation found** from **quotation matched** and explicitly states that **current legal status and support for the draft's argument were not assessed**. See [ADR 0043](adr/0043-separate-source-verification-from-legal-assessment.md).

A quotation can match a dissent or a subsequently overruled decision. Such a match establishes textual evidence only; it does not establish that the cited passage is controlling law, remains good law, or supports the proposition for which the draft cites it. Those assessments are separate capabilities outside the launch workflow.

## Accepted edited-quotation handling

On September 13, 2026, the user accepted an additional comparison for quotations containing ellipses or bracketed edits when the full quotation does not match exactly. LexCerta checks unchanged text segments against a single source passage and reports **edited quotation—manual review required**. See [ADR 0044](adr/0044-compare-edited-quotation-segments-without-verifying-edits.md).

The report identifies which segment matches were established and which remain unresolved. **Quotation matched** remains reserved for a full exact match after safe normalization. Segment matches do not certify that an omission or substitution preserves the source's meaning, and a failed segment search does not establish fabrication.

This extends draft review while preserving the existing exact-match verification rule. The comparison needs its own observable result contract and evaluation evidence before implementation can be described as supporting the accepted workflow; it does not authorize fuzzy scores or returned source excerpts.

## Accepted short-citation resolution

On September 13, 2026, the user accepted resolving short citations such as `Id. at 123` and abbreviated case references using earlier citations in the submitted draft, when its context establishes one unambiguous authority.

The report links a resolved short reference to its full citation. Missing or ambiguous references remain visible as unresolved and require manual review. Resolving a reference identifies which authority to check; it does not itself establish that the authority exists or that a pinpoint location is correct.

This is draft-level behavior in addition to the existing individual full-citation parser. A source lookup for a resolved reference remains subject to the accepted verification scope and evidence outcomes.

## Accepted pinpoint verification

On September 13, 2026, the user accepted a separate launch check of whether a matched quotation appears at the cited pinpoint page, when reliable source pagination is available.

The report distinguishes a **confirmed**, **mismatched**, or **unverified** pinpoint from the citation and quotation findings. If pagination cannot be established, retain the quotation finding and report **pinpoint not verified**. A quotation found elsewhere in an opinion does not by itself confirm the cited page, and missing pagination evidence does not establish a mismatch.

This check requires evidence mapping the source passage to the cited pagination; a PDF viewer's page index alone is insufficient. The current individual-citation parser only preserves pin cites, so source-pagination support and the new behavior remain to be implemented and qualified.

## Accepted report delivery

On September 13, 2026, the user accepted a concise summary in the AI-host conversation plus a downloadable PDF verification report. The report contains:

- Complete or partial review coverage and any unreadable sections.
- Each item's location in the submitted draft and its findings.
- Resolved full citations, supporting source links, and pinpoint results.
- Items requiring manual review, the review date, and stated limitations.

The Customer can save the returned report with their matter files. LexCerta generates and returns it transiently, without retaining its contents as report history. The report remains subject to the accepted handling of Customer draft content and the existing metadata-only source-provenance boundary.

## Platform findings and design follow-ups

Official documentation checked September 13, 2026:

- ChatGPT supports testing a custom MCP connection in developer mode, subject to account and workspace policy. Public distribution uses reviewed plugins, including MCP-only plugins. [Testing](https://developers.openai.com/plugins/deploy/connect-chatgpt), [publication](https://developers.openai.com/plugins/deploy/submission).
- OpenAI's plugin rules allow access through an existing paid account but prohibit selling digital subscriptions or credits and promoting upgrades through the plugin. An entitlement limitation may be explained and linked to an informational page; checkout and purchase-starting links are prohibited. The purchasing flow must account for this restriction. [Plugin monetization guidelines](https://developers.openai.com/plugins/app-guidelines#commerce-and-monetization).
- Claude supports adding a custom remote MCP connector by URL, independently of directory publication. [Custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp), [directory submission](https://claude.com/docs/connectors/building/submission).
- Claude documents the same MCP runtime for custom and directory connectors; review, discoverability, and distribution differ. Custom install links support connection without a public listing. [Directory versus custom connectors](https://claude.com/docs/connectors/building/directory-vs-custom).
- OpenAI expects OAuth 2.1 for authenticated MCP servers. The existing [bearer-key decision](adr/0006-use-pre-shared-bearer-keys-before-oauth.md) therefore needs reconciliation with the intended Customer connection flow. [OpenAI authentication](https://developers.openai.com/plugins/build/auth).
- ChatGPT documents explicit tool file inputs that deliver a file identifier and download URL. This provides a documented intake path to qualify with actual documents. [File inputs](https://developers.openai.com/plugins/reference#define-file-inputs).
- Claude documents PDF and DOCX uploads to conversations. This review has not established how a remote LexCerta connector receives the complete uploaded file; that host-to-service transfer remains unverified. [Claude uploads](https://support.claude.com/en/articles/8241126-upload-files-to-claude).

These documents establish integration paths, not verified LexCerta compatibility. Authentication, tool selection, and useful verification results must be observed in each target host. The [stateless-only protocol decision](adr/0001-support-only-stateless-mcp-2026-07-28.md) also requires compatibility evidence from those hosts. Using Claude or ChatGPT in a browser is distinct from a browser calling LexCerta directly; the existing credential-protection and direct-browser restrictions remain applicable.

## Remaining intake qualification

Numeric document limits must be measured and published under the accepted document-limit policy. Each host needs a verified path for delivering the accepted input formats; host-side attachment support alone does not establish that the remote MCP service receives the complete document. The existing individual-item MCP contract requires extension to implement whole-draft review and qualification for use during drafting.

## Remaining account and qualification work

Host account and workspace eligibility must be documented from the platforms' requirements and qualified workflows. Detailed onboarding must realize the accepted self-service destination and existing-account connection flow; sequencing is implementation-planning work. The accepted reference-test gate requires a concrete reviewed set and executed qualification evidence for the supported workflows. Numeric limits and the other deferred commercial details retain their accepted qualification and decision timing.

The user confirmed the accumulated product decisions as the shared scope on September 13, 2026. Remaining qualification work is not evidence of implemented support, and any inability to meet an accepted requirement must be surfaced rather than silently narrowing the scope.

## Related records

- [Domain glossary](../CONTEXT.md)
- [Verification boundary](adr/0012-remain-a-narrow-verification-service-over-courtlistener-rest.md)
- [MVP route at the handoff checkpoint](https://github.com/rubixhacker/LexCerta/blob/65d5259929a7e862fb1f4a8b768d4964938af9f2/docs/mvp-route.md) and its [canonical decision index](https://github.com/rubixhacker/LexCerta/issues/23). Their developer-pilot audience and acceptance criteria need reconciliation with this clarification; existing source-permission and release-approval gates remain in force.
