# Use the dedicated MCP host as the root endpoint

LexCerta's canonical MCP endpoint will be `https://mcp.lexcerta.ai/`. Using the root of a dedicated machine-facing hostname avoids the redundant `mcp.lexcerta.ai/mcp` path while leaving the `lexcerta.ai` apex available for a separate product website.
