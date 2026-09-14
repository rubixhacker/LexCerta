# Support only stateless MCP 2026-07-28

LexCerta will support only MCP protocol version `2026-07-28`, using its stateless per-request model. Older protocol versions, the initialization handshake, protocol-level sessions, and the legacy HTTP+SSE transport will not be retained; LexCerta has no customers or active client contracts to migrate, so accepting the clean break keeps the public contract unambiguous without carrying an unused compatibility layer.
