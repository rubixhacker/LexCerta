# CourtListener constraints for a LexCerta MVP

Research date: 2026-09-12. Decision ticket: [Establish CourtListener data, quota, and pilot-use constraints](https://github.com/rubixhacker/LexCerta/issues/26). Repository baseline: `7f5f3eaa6154a1834def2ebcd8af3c44d52bb38d`. This is planning evidence, not a launch authorization or a claim that a live service has passed evaluation.

## Recommended decision

Build an invitation-only pilot for developers integrating legal AI. Its promise is a deterministic answer to two limited questions: whether a supported citation resolves in CourtListener, and whether supplied text occurs in the retrieved opinion representation after documented normalization. Return provenance, freshness, completeness, and an explicit indeterminate outcome. Do not promise valid legal reasoning, correct pin cites, controlling authority, or good-law status.

Keep CourtListener as the sole runtime source. Prove the value of quote checking and conservative evidence reporting before adding another corpus, fuzzy matching, full-document uploads, billing, or a research UI. Product access and billing remain contingent on the external access gates below.

## Upstream access and permission gates

FLP's membership policy permits exploratory work and small pre-revenue, unfunded organizations. It excludes powering revenue-positive commercial services and internal operational tools for organizations. It also prohibits sharing keys across people or organizations. Being a free pilot does not by itself settle eligibility: the use and organization matter. [Membership API usage restrictions](https://free.law/membership/allowed-api-usage/)

The service terms cover REST and MCP access. They prohibit credential sharing, resale, pooling, transfers, and circumventing limits through multiple accounts or credential rotation; products and teams are directed to commercial agreements. They also require honest attribution, reject implied FLP endorsement of AI analysis, and warn that source reproductions can be inaccurate. These are constraints on using the service, distinct from the status of underlying legal documents. [CourtListener terms](https://wiki.free.law/c/terms/courtlistener/courtlistenercom-terms-of-service-and-policies)

Recommended gates:

| Stage | Required evidence before opening it |
| --- | --- |
| Offline implementation and public-data evaluation | Public fixture provenance and license manifest; no confidential customer material. |
| Owner-operated live evaluation | An eligible account and confirmed current limits; an explicit bounded acquisition manifest. This research did not inspect an account or spend CourtListener quota. |
| Shared free external pilot | Written FLP confirmation or an agreement covering the actual hosted multi-user use, organization eligibility, server credential arrangement, caching, and permitted output. Treat this as unresolved external permission, not as a legal conclusion that every free pilot requires a contract. |
| Paid launch | Preserve the project's requirement for a written FLP commercial arrangement before charging. Record allowed uses, quotas, price, cache/retention and redistribution terms, service expectations, termination, and source-removal handling. A membership purchase is not this agreement. |

BYO-token collection is not a shortcut around these gates. It introduces credential custody and does not establish that a hosted product's use is permitted. No outreach, account creation, terms acceptance, subscription purchase, or permission negotiation occurred in this research.

## API coverage and source contract

CourtListener describes more than nine million decisions from over two thousand courts. Its claim of over 99.9% coverage refers to precedential published US case law and is identified as its assessment as of 2023. It is not an independently measured LexCerta recall figure, a promise about unpublished decisions, or proof that a particular citation is indexed correctly. [Case-law coverage](https://wiki.free.law/c/courtlistener/help/data-coverage/case-law)

Citation lookup accepts either text or volume/reporter/page. It returns normalized citations, offsets, status, and matching clusters. Outcomes distinguish found, source miss, unknown reporter, ambiguity, and per-item throttling. It does not resolve statutes, journals, `id.`, `supra`, or references lacking volume/page. Its documented limits are 64,000 input characters, 250 lookups per request, and 60 valid citations/minute, in addition to ordinary API throttles. Field selection is unavailable on this endpoint. A `404` therefore supports only “not found in CourtListener,” not “fabricated.” [Citation lookup API](https://wiki.free.law/c/courtlistener/help/api/rest/v4/citation-lookup)

Website opinion URLs identify a cluster; the cluster's `sub_opinions` links identify individual opinions. FLP recommends `html_with_citations`. Other source representations include `html`, `plain_text`, `html_columbia`, `html_lawbox`, `xml_harvard`, and `html_anon_2020`; some derive from OCR. Separate opinions may be majority, concurrence, dissent, or combined. An original `download_url` can be stale. [Case-law APIs](https://wiki.free.law/c/courtlistener/help/api/rest/v4/case-law)

Preserve these exact MVP constraints:

- Accept a single volume–reporter–page citation from the current documented reporter allowlist. Preserve the suffix as uninterpreted input; do not silently advertise pin-cite checking. Reject neutral citations, WL/LEXIS, short forms, statutes, and other unsupported forms with the appropriate unsupported result. The [current parser](../../src/verification/citation.ts) is narrower than Eyecite and the upstream corpus.
- Request only trusted `https://www.courtlistener.com/api/rest/v4/` routes for citation lookup, usage, cluster, and opinion retrieval. Do not follow arbitrary user URLs, fetch court-site fallbacks, call RECAP purchase APIs, scrape search results, or traverse the citation graph.
- Select `html_with_citations`, then `html`, then `plain_text`, matching the [existing contract](../../src/verification/quote-normalization.ts). Unsupported-only or empty source representations produce indeterminate. Additional representation adapters need their own evidence before expansion.
- Keep a quote match case-sensitive and exact after the existing Unicode, typographic punctuation, HTML, and whitespace normalization. Do not silently allow ellipses, bracketed substitutions, paraphrases, OCR repair, or semantic similarity. Describe it as normalized text presence.
- Report the specific matching opinion and representation. A string found in a dissent, quoted passage, syllabus, or combined opinion is not evidence that the court adopted its proposition. A negative answer requires complete retrieval of all required sub-opinions; any missing, oversized, ambiguous, throttled, or unparseable evidence prevents a definitive negative.
- Return metadata and canonical source links; do not provide a full-text redistribution endpoint. Keep submitted quotes out of persistent application logs, metrics, error reporting, and caches.

## Quotas and realistic capacity

The default authenticated budget is 5 requests/minute, 50/hour, and 125/day, enforced concurrently on rolling windows. Membership tiers currently increase these limits; the highest listed individual tier is 25/minute, 300/hour, and 1,400/day. These are published defaults, not the account's verified entitlement. [REST API overview](https://wiki.free.law/c/courtlistener/help/api/rest/v4/rest-api-v47), [membership limits](https://free.law/membership/)

The usage API reports actual effective limits and remaining capacity for each scope and window. Citation lookups spend both general requests and citation units. Usage inspection has a separate fixed limit of 10/minute and 120/hour. Reset timestamps refer to rolling-window capacity; they are not midnight resets. The usage documentation spells the citation throttle timestamp `wait_until`, while the citation page spells it `wait_util`; retain tolerant parsing and test both forms, with invalid values failing safely. [Usage API](https://wiki.free.law/c/courtlistener/help/api/rest/v4/api-usage/)

Planning implication: a cold quote check costs approximately one citation request, one cluster request, and one request per required opinion, before any permitted retries. A 100-opinion cluster cannot be promised within the default minute/hour budget. Cache hits do not make unlimited admission safe because customers can always introduce new citations.

Set the pilot's rate and daily admission budgets from the verified upstream allowance, count retries, and reserve capacity for other uses of that account. For owner evaluation under the published free defaults, start below 3 upstream attempts/minute, 30/hour, and 80 per rolling day, further reduced by actual remaining capacity and at least 20 requests of daily reserve. These are recommended ceilings, not entitlements. Pace acquisition over days; return actionable indeterminate/rate-limited responses instead of waiting indefinitely or multiplying credentials. Do not buy access during implementation without separate purchasing authorization.

## Real source-size evidence

The [current body reader](../../src/courtlistener/response-body.ts) caps the entire upstream response at 65,536 bytes. The [case-law adapter](../../src/courtlistener/case-law-api.ts) also caps each source string at 65,536 JavaScript code units and currently fetches entire records. These are different units and neither is a representative-opinion qualification.

Harvard LIL publishes a [COLD Cases dataset](https://huggingface.co/datasets/harvard-lil/cold-cases) derived from CourtListener bulk data, with opinion text, metadata, opinion types, and OCR information under a CC0 label. Its [public sample](https://raw.githubusercontent.com/harvard-lil/cold-cases-export/main/sample.jsonl) provides bounded offline evidence without spending CourtListener API quota.

Measured on 2026-09-12 using Python's UTF-8 byte lengths:

| Sample measure | Observed value |
| --- | --- |
| File size | 12,907,287 bytes |
| File SHA-256 | `9a5299632169fcdc608ce268670a81abaf5c89a52b42de32a96ec59043c620be` |
| Cases / individual opinion texts | 1,000 / 1,076 |
| Opinion texts exceeding 65,536 UTF-8 bytes | 21 |
| Largest opinion text | 138,545 UTF-8 bytes |
| Example exceeding the limit | Cluster `612140`, citation `999 F.2d 1053`: 138,092 bytes of opinion text |

This sample demonstrates that real text alone can exceed the current entire-response limit before JSON escaping, HTML, parallel representations, or metadata. It does **not** estimate the live API failure rate, establish the maximum opinion size, or prove Cloud Run performance. The local temporary sample is not committed and contains no user submissions.

Decision: add field selection on cluster/opinion endpoints and measure actual serialized bodies for the frozen corpus. Start a candidate Cloud Run bound at 1 MiB per selected response and source representation, with aggregate fetch/CPU/memory/deadline budgets; qualify that candidate before adopting it. Retain a safe indeterminate result on overflow. If the corpus cannot meet the service gate, narrow the advertised support or requalify a revised bound; do not add an unbounded fallback. The 1 MiB value is a proposed engineering starting point, not a measured upstream maximum.

## A small evaluation gate

Use a frozen 60-case corpus: 20 Supreme Court, 20 federal appellate/district, and 20 state appellate/supreme decisions using supported reporters. Within it include at least 10 OCR-era cases, 10 with multiple sub-opinions, 10 post-2018 cases, and 10 whose source text exceeds 64 KiB; these characteristics can overlap. Keep 20 cases held out while tuning. Record every selection and replacement, including unavailable cases; do not remove difficult cases because they fail.

Use COLD's small public sample to seed historical cases, then add court-issued recent decisions and their CourtListener records through the approved bounded acquisition run. Harvard's CAP release is another public historical source; Harvard announced its full release in 2024. FLP also provides bulk snapshots, but downloading a complete corpus is unnecessary for this gate. [CAP release](https://lil.law.harvard.edu/blog/2024/03/29/new-endeavors-at-the-library-innovation-lab/), [FLP bulk data](https://wiki.free.law/c/courtlistener/help/api/bulk-data/bulk-legal-data)

For each case, record three evaluated requests: one supported citation, one exact quote, and one minimally altered quote confirmed absent from all selected normalized source text. This makes 180 real-case requests: 120 expected positives and 60 expected source-scoped negatives. Add 40 targeted fixture cases: eight positive normalization/parallel-citation/dissent-presence cases; eight source-scoped negatives with complete evidence; and 24 indeterminate cases (six unsupported, three ambiguous, three empty/unsupported source fields, three oversized/truncated, three partial retrieval, two quota failures, two stale negatives, and two source reversals). The full target is **220 vectors: 128 positives, 68 negatives, and 24 indeterminate**. Input-schema rejection tests remain separate from these outcome counts.

Freeze case identities and the held-out split before changing the implementation. Use a deterministic seed and record candidate exclusions; select by court/era/representation/size strata, not by whether the current service succeeds. Have an annotator review expected labels from the primary source text without seeing LexCerta's result. An agent may assist curation, but generated labels or upstream `404` alone are not gold answers. Record provenance, retrieval time, field choice, byte sizes, quote construction, expected outcome, and annotation rationale. Synthetic fixtures test failure behavior; they do not increase measured real-world coverage. This is a deliberately selected qualification corpus, not a probability sample of all US case law.

Keep collection affordable: cap acquisition at **300 non-usage upstream attempts**, including retries, over at least four days under the recommended default daily ceiling. Complete offline replay of captured permitted responses first, then one deployed cold run and one warm run over the same 180 real-case requests, reusing the approved source cache. Fit acquisition and cold-run attempts within that budget; if collecting the planned cases exhausts it, pause live collection and continue fixtures rather than silently buying a tier or exceeding it. Run the 40 injected failure vectors against the deployed-compatible fixture harness, not by manufacturing load or failures against CourtListener. This budget is a recommended execution bound and was not spent by this research.

Pilot technical gate:

1. Zero false verified results in the full frozen set; every altered/absent quote and incomplete retrieval must avoid an unsupported positive or definitive negative.
2. All 40 contract/failure fixtures pass. At least 57 of 60 real exact quotes and 57 of 60 supported real citations return the expected completed result; report all abstentions and per-stratum counts, with no hidden exclusions. These are small-sample release gates, not population accuracy claims.
3. Complete cold and warm runs on the deployed artifact using the same frozen inputs, with bounded upstream acquisition and sanitized evidence. Record latency, size, memory, retries, and costs. Source licensing, local tests, runtime evidence, and external-user value remain separate claims.
4. If a gate fails, fix a demonstrated defect or narrow the support promise and rerun the complete unchanged held-out set. Do not relabel errors as success or substitute convenient cases.

The authors' [LegalCiteBench paper](https://arxiv.org/abs/2605.10186) and [public repository](https://github.com/Sijia711/LegalCiteBench) supply additional citation-error task ideas. It studies closed-book LLM authority generation and verification, so it is not a ready-made quote-presence or API reliability benchmark. Do not make it a prerequisite for this small MVP.

## Differentiation, acquisition, and retention

FLP already hosts an MCP server with search, general retrieval, citation extraction, and citation verification. Its documentation describes normalized case information and good/bad/ambiguous citation outcomes, along with batched continuation. Therefore MCP connectivity or citation existence alone is weak differentiation. [Official MCP documentation](https://github.com/freelawproject/courtlistener-api-client/blob/main/MCP_README.md)

LexCerta's testable hypothesis is that integrators value normalized quote-presence checks, explicit incomplete-evidence handling, a narrow versioned result contract, and reproducible provenance enough to adopt it. This research establishes overlap, not demand. The pilot must show repeated developer use and useful outcomes beyond what the official connector supplies. Do not imply that strict stateless transport alone creates a business advantage or that the competitor cannot add quote checking.

Recommended product boundaries, subject to any stricter agreement:

- Acquire only requested opinions and the frozen evaluation manifest. No background crawler, ID enumeration, citation-network expansion, bulk warming, or automatic whole-database mirroring.
- Keep a demand-driven operational source cache, initially capped at 1,000 opinions or 256 MiB, whichever comes first. Expire raw source bodies no later than 30 days after acquisition; do not extend that lifetime merely on read. Reacquisition needs a fresh permitted upstream request. Enforce deletion in a real scheduled job and on the read path.
- A 30-day freshness interval is not a deletion policy. The existing source-cache policy and lifecycle scheduler must be reviewed for hard source-body expiry and orphan cleanup when porting to Cloud Run. Do not claim the current code already satisfies the recommendation.
- Keep metadata-only aggregate metrics and needed administrative records; no submitted quotes, briefs, raw upstream error bodies, or source full text in telemetry. Use a separate permission/provenance manifest for deliberately frozen public test excerpts rather than treating evaluation fixtures as an unlimited cache exception.
- Honor confirmed source removal/correction without continuing to serve suppressed text; retain only the minimum sanitized tombstone needed to prevent accidental refetch. Include ownership and expected removal response time in the upstream arrangement.

The consulted public docs offer bulk data separately and describe those files as free of known copyright restrictions. They do not establish a universal cache TTL, numerical anti-mirroring ceiling, or specific hosted redistribution grant. The limits above are deliberate MVP product decisions; written terms may require revision. Publicly available data and an API membership are not interchangeable authorizations.

## Resolution boundary

The technical and commercial planning recommendation is complete. No live account entitlement, external FLP permission, paid agreement, live CourtListener response-size distribution, deployed Cloud Run result, or customer retention has been established. Those remain execution evidence gates, not reasons to leave the product scope undecided.
