# Version the tool contract, not the MCP endpoint

The first production release establishes public tool contract version `1`, included as `contractVersion: "1"` in every structured result. MCP server metadata exposes the semantic implementation version and `/healthz` exposes the build identifier. Existing tool schemas and outcome meanings receive only backward-compatible additions. Breaking semantics require a new tool name offered alongside the old tool during migration; the canonical MCP endpoint remains unversioned at `https://mcp.lexcerta.ai/`.
