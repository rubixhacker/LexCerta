# Frozen source corpus

The identities and 20-case holdout were frozen on September 12, 2026, before
changing response bounds, normalization, or matching. The immutable tracker anchor
is [the source-corpus freeze](https://github.com/rubixhacker/LexCerta/issues/34#issuecomment-5648381977).
The implementation at freeze was `c0704c9fecffbbc23c808c92735dfe2d8c0bd344`.

This pack contains public source text and source-reviewed quote annotations. It
does **not** contain recorded CourtListener API responses or a product evaluation
pass. No selected case has yet been executed through LexCerta. The full execution
requirements remain in [Qualify evidence against a frozen real-source corpus](https://github.com/rubixhacker/LexCerta/issues/34).

## Source and scope

Harvard Library Innovation Lab publishes [COLD Cases](https://huggingface.co/datasets/harvard-lil/cold-cases)
with a CC0-1.0 license label. Its records derive from CourtListener bulk material.
The inputs are a commit-pinned public sample and eleven bounded public dataset
viewer pages. Their URLs, original byte lengths, acquisition times when recorded,
and hashes are in `inputs.lock.json`. They total 36,723,131 bytes. No CourtListener
API credential or quota was used.

The viewer reports `partial: true`: this covers part of the dataset, not a
representative random sample. Every acquired selected row has an empty
`truncated_cells` list. Viewer URLs do not pin a revision; the downloaded content
hashes are authoritative. Exact reproduction needs those captured input bytes,
not whatever the same URL returns later. The selected source archive is committed
so routine qualification needs no network access.

The viewer's filter index returned loading/corruption failures. After two failed
recent-date filters and bounded retries, direct `/rows` pages 0–999 supplied the
substantive Supreme Court candidates. `acquisition.json` records successful inputs,
logged failures, and the few early failures whose precise timestamp was not
recorded. Those are public dataset requests, not upstream API quota attempts.

## Selection, frozen before tuning

`scripts/freeze-corpus.mjs` reads only the locked inputs and never imports the
product. It considers 2,100 rows, with 834 eligible candidates. It records all
candidate exclusions, duplicates, and eligible cases omitted by the seeded
selection in `frozen/selection-audit.jsonl`.

Eligibility requires a supported canonical reporter citation, a declared court
stratum, valid distinct opinion IDs, nonempty text for all listed opinions, no
viewer truncation, and at least one opinion with 2,000 UTF-8 bytes. The last rule
was chosen before selection because the initial sample's Supreme Court records
were mostly one-line orders. There is no upper source-size eligibility cutoff.
Historical trial courts that the source places in broad appellate categories are
explicitly excluded. These choices deliberately test substantive document
handling; they are not estimates of all case-law coverage.

The seed is `lexcerta-mvp-corpus-2026-09-12-v1`. Selection first favors candidates
covering unmet overlap minima, then uses the seeded SHA-256 order to break ties,
subject to each court stratum's capacity. The holdout uses the same procedure
with a separate seed suffix and fixed court capacities. No product outcome enters
selection. Original case metadata remains unchanged, including the missing case
name on cluster 381885; its source heading identifies Yaretsky and Blum.

| Stratum | Full set | Holdout |
| --- | ---: | ---: |
| Supreme Court | 20 | 6 |
| Other federal appellate/district | 20 | 7 |
| State appellate/supreme | 20 | 7 |
| OCR flag in source metadata | 10 | 4 |
| Multiple listed opinions | 20 | 9 |
| Filed after 2018 | 10 | 4 |
| At least one opinion over 65,536 UTF-8 bytes | 10 | 5 |

The last four rows overlap. Recent cases are from 2019; newer-date filter failures
are recorded, and this pack makes no claim about 2020–2026 coverage. An OCR flag
reports source metadata, not an independent diagnosis of text quality. Multiple
listed opinions can include a combined text alongside individual opinions.

The gzip archive expands to 2,917,566 bytes with SHA-256
`8375df8bb49c95b4cbc7090e375359165c0a2079dd20171d033e5b73ccdf8faa`.
That hash includes identities, all selected source text, metadata, and the split.
Do not change it or replace a difficult case after observing results.

## Source-reviewed annotations

`annotations.json` records 60 exact source fragments and 60 one-word or one-number
alterations. The agent reviewed each candidate fragment without seeing any
LexCerta result and chose each alteration. Two citation-heavy candidate fragments
were replaced with substantive sentences before any replay. Every exact fragment
has a source opinion hash and UTF-8 byte span. An independent Python check of the
documented normalization confirmed each altered fragment absent from **all**
listed texts, and records every opinion in that completeness check. No human
review or assessment of legal propositions is claimed.

The 60 citation-positive expectations describe membership in the frozen COLD
records. Thirty-eight reporter citations also appear in the opinion headings;
22 rely on source citation metadata because the text is a slip opinion or lacks
that header. This evidence does not prove current CourtListener lookup behavior.
Generated API envelopes must be labelled simulated, and a replay of those
envelopes cannot be reported as real upstream citation accuracy.

These annotations provide the inputs for 180 real-source vectors: citation,
exact quote, and altered quote for each case. The 40 separately labelled synthetic
vectors, actual product replay, and 1 MiB/16 MiB/deadline qualification are still
implementation work. Keep the 20 holdout cases out of tuning runs; source-integrity
checks can examine their bytes without executing the product on them. The
committed integrity test independently rechecks normalized absence across all
opinions as well as the exact byte spans.

## Reproduction and remaining proof

From the repository root, with the exact captured input files available:

```sh
node scripts/freeze-corpus.mjs /path/to/captured-inputs /tmp/new-lexcerta-corpus
node --test scripts/corpus-fixtures.test.mjs
```

The freeze command refuses to overwrite an existing output directory. Compare
the uncompressed archive hash and manifest contents. Formatting changes to JSON
do not change the anchored archive. Routine source-integrity tests use only
committed data, verify all source hashes and quote spans, and do not open the
product holdout.

Next proof is a replay of the unchanged development cases plus all synthetic
failure vectors, followed by the unchanged holdout. Capture every failure and
abstention. A pass requires the adopted zero-false-result and completion gates.
Then acquire permitted actual API responses at verified account limits, bounded
by 300 non-usage attempts including retries over at least four days, and qualify
the same inputs in deployed cold and warm runs. Account eligibility, external
FLP permission, production approval, and real pilot use remain separate gates.
