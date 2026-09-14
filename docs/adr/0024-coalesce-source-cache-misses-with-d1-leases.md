# Coalesce source-cache misses with D1 leases

LexCerta will coalesce concurrent source-cache misses using short, expiring D1 fetch leases keyed by normalized citation or CourtListener opinion identifier. The first caller acquires the lease and performs the admitted upstream fetch; concurrent callers wait briefly and recheck the cache instead of duplicating the request. Successful fills write the source cache and release the lease, while lease expiry recovers from a failed Worker. Every unavoidable upstream request still requires CourtListener-budget admission.
