# Do not support direct browser-origin calls at launch

LexCerta's public MCP endpoint will support server-side and installed clients but will not emit permissive CORS headers or support direct browser-origin calls at launch. Operator-issued bearer keys must not be embedded in browser applications. Browser access may be introduced later only with OAuth or a backend-mediated credential flow and an explicit origin policy. This restriction does not affect ordinary remote MCP clients using HTTPS.
