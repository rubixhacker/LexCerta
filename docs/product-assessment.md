# Product assessment

September 12, 2026, during MVP implementation.

LexCerta has a plausible narrow use: an integration can check whether a supported U.S. citation exists in CourtListener and whether particular wording appears in the associated opinion text. The useful product is the reliable distinction between evidence, a source-scoped miss and an incomplete check. An MCP endpoint by itself is not a defensible advantage.

The evidence model is the strongest part of the code. It preserves provenance, distinguishes failed searches from negative results, handles contradictory source observations and limits quote normalization so it cannot silently rewrite meaning. Those protections are appropriate for a service whose consumers may otherwise overstate a tool result.

The product is not a legal-reasoning system. It does not establish good-law status, the correctness of a legal proposition or pin cite, the court's holding, or whether a matched quote came from a dissent or another quoted source. Marketing must make those limits visible. A green verification badge without the scope and source would overpromise what the implementation proves.

Launch readiness is not yet established. The Node stateless MCP boundary and pinned client are locally qualified, and obsolete runtimes have been removed. PostgreSQL/GCS adapters have real-database and SDK fixture tests, but the replacement Cloud Run service has not completed deployed qualification. The frozen 60-case public-source corpus and 40 synthetic contract cases pass offline, including the unchanged holdout; upstream responses are simulated, so current CourtListener coverage is still unobserved. Bounded source processing passes a local one-CPU, 1-GiB concurrency-eight workload. Deployed actual-response coverage, operational privacy, restore recovery, upstream permission and independent pilot use remain explicit work. The older test suite was useful engineering evidence; it was never customer or production proof.

The largest business uncertainty is whether this limited check saves an integrator enough work to justify adopting and paying for another dependency. No independent recurring-use evidence has been established in this qualification. The hosted multi-user pilot also depends on written Free Law Project permission; paid access requires the agreed commercial arrangement. Those are prerequisites to the proposed product, not details to postpone until after public onboarding.

My recommendation is a small integration pilot: three tools, manually issued expiring keys, one qualified client and at most three organizations. Defer dashboards, billing, broad citation formats and general legal answers. Prove real-corpus behavior, let an external integrator onboard from the documentation, and require recurring use before expanding. If users mainly want case treatment or proposition checking, this MVP will not satisfy that demand; we should learn that before building the surrounding SaaS.
