# Require a complete case-cluster search before returning quote not found

For a CourtListener case cluster containing multiple opinions, LexCerta will return `verified` as soon as an exact normalized quotation match is found in any opinion and will identify that opinion in provenance. It will return `not_found` only after every opinion in the cluster has been retrieved and searched successfully. If any required opinion is unavailable or the cluster exceeds the configured processing bound, the result is `indeterminate`; a partial cluster search never supports `not_found`.
