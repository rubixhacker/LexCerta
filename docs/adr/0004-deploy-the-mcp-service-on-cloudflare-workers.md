# Deploy the MCP service on Cloudflare Workers

LexCerta will deploy its framework-neutral TypeScript MCP service on Cloudflare Workers Paid, keeping DNS, TLS, routing, and compute under the Cloudflare account that already owns `lexcerta.ai`. Production qualification requires the complete workload to fit the fixed 128 MB memory limit, an acceptable worst-case opinion-normalization and exact-match CPU budget, and the `workerd` compatibility boundary; if any gate still fails after one bounded optimization attempt, the same server core will move to Google Cloud Run.
