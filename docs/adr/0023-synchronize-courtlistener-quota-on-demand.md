# Synchronize CourtListener quota on demand

LexCerta will refresh CourtListener quota from the API usage endpoint on demand: before the first upstream request when no confirmed state exists, at most once every 15 minutes while traffic is active, and immediately after an unexpected `429`. The coordinator persists the last confirmed limits and rolling usage state, continues conservatively from that state if a refresh fails, and fails closed with `indeterminate` if limits have never been confirmed. No idle alarm exists solely to poll quota.
