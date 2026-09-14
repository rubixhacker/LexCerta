# Use the official MCP server handler directly

LexCerta will mount the Web-standard handler from `@modelcontextprotocol/server` directly in the Cloudflare Worker and configure it to reject legacy requests. The `mcp-handler` adapter will be removed because its built-in 2025-era fallback conflicts with LexCerta's 2026-only protocol boundary, while the official handler exposes strict legacy rejection explicitly.
