# Use pre-shared bearer keys before OAuth

LexCerta's first public release will authenticate operator-issued keys through `Authorization: Bearer <key>`, reject missing or invalid credentials with HTTP 401, and never accept credentials in URLs. This intentionally defers the MCP authorization profile's OAuth 2.1 discovery and authorization-server flow until self-service accounts are introduced; retaining the Bearer header keeps the client-facing request shape compatible with that later migration.
