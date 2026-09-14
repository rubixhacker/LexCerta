# Isolate key administration behind Cloudflare Access

LexCerta API key issuance, rotation, and revocation will run in a separate operator Worker at `admin.lexcerta.ai`, protected by Cloudflare Access and restricted to the operator identity. The public MCP Worker exposes no administrative tools or routes. The operator Worker shares only required D1 and cryptographic bindings, emits sanitized audit events for every administrative action, and displays a newly issued plaintext key exactly once.
