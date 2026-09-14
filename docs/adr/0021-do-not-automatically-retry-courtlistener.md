# Do not automatically retry CourtListener

LexCerta will make one attempt per CourtListener HTTP request at launch. Every actual request, including cluster and individual sub-opinion fetches, requires a separate reservation from the CourtListener budget immediately before transmission. Timeouts, `429`, and `5xx` responses produce an `indeterminate` tool result with sanitized retry guidance; the caller decides whether and when to retry. Any future automatic retry must admit and measure each attempt separately.
