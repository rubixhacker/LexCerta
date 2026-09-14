# Cut over without a legacy runtime fallback

Because LexCerta has no Customer traffic to migrate, production will cut over directly to the exact stateless MCP 2026-07-28 Worker artifact already validated in isolated staging. Rollback is limited to a previous known-good MCP 2026-07-28 Worker release; the persistent SSE transport and Vercel/Next.js implementation will never be a production fallback. Legacy code and deployment will be removed after the first verified production release, while the apex website and domain remain unaffected.
