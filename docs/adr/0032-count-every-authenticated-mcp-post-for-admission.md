# Count every authenticated MCP POST for admission

Every authenticated MCP `POST` will consume one API-key admission unit, including discovery, cache hits, unsupported methods, invalid parameters, and calls returning `not_found` or `indeterminate`. Unauthenticated requests and `GET /healthz` do not consume a Customer's allowance. This accounting exists to contain abuse, accidental loops, and service cost; any future billable-usage accounting will be maintained separately.
