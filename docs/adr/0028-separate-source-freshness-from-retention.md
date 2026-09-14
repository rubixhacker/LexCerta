# Separate source freshness from retention

LexCerta will retain positive citation metadata and opinion text after their freshness window expires. Freshness expiration triggers revalidation rather than deletion, preserving evidence for the explicitly disclosed stale-positive fallback and avoiding unnecessary use of CourtListener's limited quota. Expired negative lookups will be purged because they cannot support later outcomes. Positive evidence will be removed only under an explicit storage-limit, legal-removal, or administrative policy.
