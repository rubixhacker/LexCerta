# Require an exact normalized match for quote verification

At launch, `verify_quote` will return `verified` only when the requested quotation exactly matches source opinion text after safe normalization. It will not return fuzzy scores, candidate excerpts, or source text. A future fuzzy-verification capability requires a labeled evaluation corpus, a regression gate, and a new compatible tool contract before it may influence or accompany verification.

Safe normalization is limited to Unicode normalization, HTML and entity decoding, whitespace collapsing, typographic versus straight quotation marks, and equivalent dash characters. It does not interpret ellipses, bracketed substitutions, omitted citations, case changes, or reordered words as an exact match.

[ADR 0044](0044-compare-edited-quotation-segments-without-verifying-edits.md) adds a separate edited quotation comparison to draft review. Its manual-review findings preserve this exact-match requirement for verified quotations.
