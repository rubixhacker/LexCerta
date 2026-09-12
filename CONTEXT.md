# LexCerta evidence verification

LexCerta helps legal-AI integrators inspect whether a supported citation or quotation has evidence in CourtListener. Evidence describes what a source contains and the limits of that observation.

## Language

**Pilot integrator**:
An external person or organization evaluating LexCerta inside a legal-AI drafting or review workflow.
_Avoid_: Validated customer, paying customer (until supported by evidence)

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

**Pilot MVP**:
A production-qualified service that an external pilot integrator can onboard to and use repeatedly for the declared evidence workflow.
_Avoid_: Product-market fit, proven business
