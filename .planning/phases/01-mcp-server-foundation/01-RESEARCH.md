# Phase 1: MCP Server Foundation - Research

**Researched:** 2026-02-13
**Domain:** MCP server scaffolding, Streamable HTTP transport, Zod validation, structured responses
**Confidence:** HIGH

## Summary

Phase 1 establishes a running MCP server with Streamable HTTP transport (primary), SSE fallback (backward compatibility), Zod input validation, a consistent JSON response envelope, stderr-only logging, and startup config validation. The MCP TypeScript SDK v1.26.0 provides everything needed out of the box -- McpServer with `registerTool` accepts Zod schemas directly, `StreamableHTTPServerTransport` handles HTTP POST/GET/DELETE, and Express provides the HTTP layer. The SDK bundles Express as a dependency.

The critical discovery is that the SDK v2 (pre-alpha, unpublished) has split into separate packages (`@modelcontextprotocol/server`, `@modelcontextprotocol/node`, `@modelcontextprotocol/express`), but v1.26.0 -- the current production release -- uses the monolithic `@modelcontextprotocol/sdk` with subpath imports. All code must target v1.26.0 patterns. The v2 `main` branch examples on GitHub show the new package structure, which is NOT yet published to npm. Do not follow those import paths.

**Primary recommendation:** Use `@modelcontextprotocol/sdk@^1.26.0` with Express, `StreamableHTTPServerTransport` for stateless Streamable HTTP, and a separate SSE endpoint pair for backward compatibility. Use `zod@^3.25` (not v4) for maximum compatibility and simpler imports.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@modelcontextprotocol/sdk` | ^1.26.0 | MCP server, transport, tool registration | Official SDK. Only production-ready TypeScript MCP implementation. Minimum safe version (CVE-2025-66414 patched in 1.25.1). |
| `zod` | ^3.25 | Schema validation for tool inputs and config | Peer dependency of SDK. SDK accepts `^3.25 \|\| ^4.0` but v3.25 avoids the `zod/v4` import complexity and is what the official build-server tutorial uses. |
| `express` | ^5.2.1 | HTTP framework | Bundled as SDK dependency. SDK examples all use Express. Required for `StreamableHTTPServerTransport.handleRequest(req, res, body)`. |
| TypeScript | ^5.7 | Language | Required by project constraints. Strict mode. |
| Node.js | 20 LTS+ | Runtime | Minimum per project constraints. |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `tsx` | latest | TypeScript execution without compile step | Local development: `tsx src/index.ts` |
| `@modelcontextprotocol/inspector` | latest | MCP debugging/testing UI | Manual testing of tool registration, request/response cycles |
| Vitest | ^4.0 | Unit/integration testing | All test files |
| Biome | latest | Lint + format | Code quality |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Express (bundled) | Hono (also bundled in SDK) | SDK bundles both. Express has more ecosystem support and examples. Hono is lighter and edge-native. For local dev server, Express is simpler. Switch to Hono only if deploying to Cloudflare Workers. |
| `zod@^3.25` | `zod@^4.0` with `import * as z from 'zod/v4'` | Zod v4 requires different import syntax and had past SDK compatibility issues (#1429, resolved). v3.25 is simpler and what the official tutorial uses. |
| `@modelcontextprotocol/sdk` v1.x | SDK v2 (pre-alpha) | v2 splits into `@modelcontextprotocol/server` + `@modelcontextprotocol/node` + `@modelcontextprotocol/express`. NOT published to npm yet. Do not use. |
| `mcp-handler` (Vercel adapter) | Direct SDK | `mcp-handler` is for Vercel deployment (Phase 6). For Phase 1 local server, use SDK directly. |

**Installation:**
```bash
# Core
npm install @modelcontextprotocol/sdk@^1.26 zod@^3.25

# Dev dependencies
npm install -D typescript@^5.7 @types/node tsx vitest @biomejs/biome @modelcontextprotocol/inspector
```

Note: Express is bundled inside `@modelcontextprotocol/sdk` as a dependency -- do NOT install it separately. Import from the SDK's subpath.

## Architecture Patterns

### Recommended Project Structure
```
src/
├── server.ts            # McpServer instantiation + tool registration
├── transport.ts         # Express app, Streamable HTTP + SSE route handlers
├── config.ts            # Zod-validated env config, loaded at startup
├── types.ts             # Shared types (response envelope, etc.)
├── tools/               # Tool handler modules (empty in Phase 1, placeholder for Phase 2+)
│   └── echo.ts          # Placeholder echo tool for testing
└── index.ts             # Entry point: validate config, create server, start listening
```

### Pattern 1: Stateless Streamable HTTP Transport (Primary)
**What:** Each POST to `/mcp` creates a fresh `StreamableHTTPServerTransport` with `sessionIdGenerator: undefined`, connects a new McpServer instance, handles the request, then cleans up. No session state between requests.
**When to use:** For simple API-style MCP servers. Perfect for serverless deployment later (Phase 6).
**Confidence:** HIGH -- verified from SDK example `simpleStatelessStreamableHttp.ts`

```typescript
// Source: modelcontextprotocol/typescript-sdk examples/server/src/simpleStatelessStreamableHttp.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response } from "express";
import { z } from "zod";

const getServer = () => {
    const server = new McpServer(
        { name: "lexcerta", version: "1.0.0" },
        { capabilities: { logging: {} } }
    );

    server.registerTool(
        "echo",
        {
            description: "Echo back the input (placeholder tool)",
            inputSchema: {
                message: z.string().describe("Message to echo")
            }
        },
        async ({ message }) => ({
            content: [{ type: "text", text: JSON.stringify({ valid: true, metadata: { echo: message }, error: null }) }]
        })
    );

    return server;
};

const app = express();
app.use(express.json());

app.post("/mcp", async (req: Request, res: Response) => {
    const server = getServer();
    try {
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined  // stateless
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        res.on("close", () => {
            transport.close();
            server.close();
        });
    } catch (error) {
        console.error("Error handling MCP request:", error);
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: "2.0",
                error: { code: -32603, message: "Internal server error" },
                id: null
            });
        }
    }
});

// Stateless: GET and DELETE return 405 Method Not Allowed
app.get("/mcp", (_req: Request, res: Response) => {
    res.writeHead(405).end(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed." },
        id: null
    }));
});

app.delete("/mcp", (_req: Request, res: Response) => {
    res.writeHead(405).end(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed." },
        id: null
    }));
});
```

### Pattern 2: SSE Backward Compatibility
**What:** Per the MCP spec's backward compatibility guide, servers supporting older clients should host both the old SSE endpoints (`GET /sse` for event stream, `POST /messages` for requests) alongside the new Streamable HTTP endpoint (`POST /mcp`). The SDK provides `SSEServerTransport` for this purpose.
**When to use:** Required by MCP-02 (SSE fallback). Old clients attempt GET on the URL first; if they get SSE, they use the legacy transport.
**Confidence:** HIGH -- verified from MCP specification 2025-03-26 backward compatibility section

```typescript
// Source: MCP spec backward compatibility + SDK SSEServerTransport
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

// Legacy SSE endpoints (for backward compatibility with pre-March 2025 clients)
app.get("/sse", async (_req: Request, res: Response) => {
    const server = getServer();
    const transport = new SSEServerTransport("/messages", res);
    await server.connect(transport);
    // Transport keeps connection open as SSE stream
});

app.post("/messages", async (req: Request, res: Response) => {
    // SSEServerTransport handles routing via session
    // Implementation depends on session management approach
});
```

### Pattern 3: Zod-Validated Startup Config
**What:** Define a Zod schema for all required environment variables. Parse `process.env` at server startup. If validation fails, log the error to stderr and exit with code 1. Server never starts with missing config.
**When to use:** Always -- required by DEPLOY-02 and DEPLOY-03.
**Confidence:** HIGH -- standard pattern

```typescript
// Source: standard pattern, verified against requirements DEPLOY-02, DEPLOY-03
import { z } from "zod";

const ConfigSchema = z.object({
    COURTLISTENER_API_KEY: z.string().min(1, "COURTLISTENER_API_KEY is required"),
    PORT: z.coerce.number().default(3000),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
    const result = ConfigSchema.safeParse(process.env);
    if (!result.success) {
        console.error("Invalid configuration:");
        console.error(result.error.format());
        process.exit(1);
    }
    return result.data;
}
```

### Pattern 4: Consistent Response Envelope
**What:** All tool responses return a JSON string inside the MCP `content[].text` field, using a consistent envelope: `{ valid: boolean, metadata: object | null, error: object | null }`. This is a convention on top of the MCP SDK's content response format.
**When to use:** Every tool handler must format responses this way (MCP-04).
**Confidence:** HIGH -- application-level convention, not SDK-specific

```typescript
// Response envelope type
interface ToolResponseEnvelope {
    valid: boolean;
    metadata: Record<string, unknown> | null;
    error: { code: string; message: string; details?: unknown } | null;
}

// Helper to create consistent responses
function createToolResponse(envelope: ToolResponseEnvelope) {
    return {
        content: [{
            type: "text" as const,
            text: JSON.stringify(envelope)
        }]
    };
}

// Success example
createToolResponse({
    valid: true,
    metadata: { caseName: "Miranda v. Arizona", citation: "384 U.S. 436" },
    error: null
});

// Validation error example
createToolResponse({
    valid: false,
    metadata: null,
    error: { code: "VALIDATION_ERROR", message: "Invalid citation format", details: zodError.issues }
});
```

### Pattern 5: Stderr-Only Logging (MCP-05)
**What:** All logging must go to stderr. `console.log()` writes to stdout and would corrupt MCP JSON-RPC messages on stdio transport. Even though Streamable HTTP does not use stdout for protocol messages, maintaining stderr-only logging ensures the server works correctly with any transport.
**When to use:** Always. Use `console.error()` for all logging, or a logger configured for stderr.
**Confidence:** HIGH -- explicitly stated in MCP official docs and SDK examples

```typescript
// Simple approach: use console.error for all logging
console.error("Server started on port", port);
console.error("Tool registered:", toolName);

// Or wrap in a logger that enforces stderr
const logger = {
    info: (...args: unknown[]) => console.error("[INFO]", ...args),
    warn: (...args: unknown[]) => console.error("[WARN]", ...args),
    error: (...args: unknown[]) => console.error("[ERROR]", ...args),
    debug: (...args: unknown[]) => console.error("[DEBUG]", ...args),
};
```

### Anti-Patterns to Avoid
- **Using SDK v2 import paths:** Do NOT use `@modelcontextprotocol/server`, `@modelcontextprotocol/node`, or `@modelcontextprotocol/express`. These are from the unpublished v2 pre-alpha. Use `@modelcontextprotocol/sdk/server/mcp.js` etc.
- **Using `server.tool()` instead of `server.registerTool()`:** The v1 build-server tutorial shows `server.tool()` which is a shorthand. The official examples and v2 API use `server.registerTool()`. Both work on v1.26.0, but `registerTool` is the forward-compatible API.
- **Logging to stdout:** Never use `console.log()` in MCP server code. Use `console.error()`.
- **Installing Express separately:** Express is bundled inside the SDK. Import from Express directly (`import express from "express"`) -- it resolves from the SDK's dependency.
- **Stateful sessions for Phase 1:** Do not implement session management yet. Use `sessionIdGenerator: undefined` for stateless mode. Sessions add complexity that is not needed until multi-request workflows exist.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| MCP protocol handling | Custom JSON-RPC parser/router | `McpServer` from SDK | Protocol compliance, tool registration, capability negotiation all handled |
| Streamable HTTP transport | Custom HTTP+SSE handler | `StreamableHTTPServerTransport` | Handles POST/GET/DELETE, SSE streaming, session headers, content negotiation |
| SSE transport (legacy) | Custom SSE implementation | `SSEServerTransport` from SDK | Handles event stream, message routing, session management |
| Input validation | Custom validation logic | Zod schemas via `registerTool` inputSchema | SDK auto-validates before handler is called; returns proper JSON-RPC errors |
| JSON-RPC error responses | Custom error formatting | SDK error handling | SDK formats JSON-RPC -32602 (invalid params) errors automatically from Zod failures |

**Key insight:** The SDK handles nearly everything for Phase 1. The implementation work is wiring up Express routes, defining tool schemas, and formatting the application-level response envelope. Do not reimplement protocol-level concerns.

## Common Pitfalls

### Pitfall 1: Following v2 SDK Examples from GitHub Main Branch
**What goes wrong:** The `main` branch of `modelcontextprotocol/typescript-sdk` now targets v2 (pre-alpha). Examples import from `@modelcontextprotocol/server`, `@modelcontextprotocol/node`, `@modelcontextprotocol/express` -- packages that DO NOT EXIST on npm. Code will fail at install time.
**Why it happens:** Google/GitHub search returns main branch files first. The v2 README says "v1.x recommended for production until Q1 2026 stable release."
**How to avoid:** Always use v1.x import paths: `@modelcontextprotocol/sdk/server/mcp.js`, `@modelcontextprotocol/sdk/server/streamableHttp.js`, `@modelcontextprotocol/sdk/server/sse.js`. Pin SDK to `^1.26.0`.
**Warning signs:** `npm install` errors for `@modelcontextprotocol/server`. Import resolution failures.

### Pitfall 2: Zod v4 Import Confusion
**What goes wrong:** Zod v4 uses `import * as z from 'zod/v4'` instead of `import { z } from 'zod'`. The SDK internally uses `zod/v4` subpath. Mixing import styles causes type incompatibilities.
**Why it happens:** Zod v4 was a major breaking change. The SDK supports both v3.25+ and v4, but the import patterns differ.
**How to avoid:** Use `zod@^3.25` with `import { z } from "zod"`. This is what the official build-server tutorial uses and avoids all compatibility edge cases.
**Warning signs:** TypeScript errors about incompatible Zod types. `z.string()` not being recognized.

### Pitfall 3: stdout Logging Corrupting MCP Protocol
**What goes wrong:** `console.log()` writes to stdout. On stdio transport, this corrupts JSON-RPC messages. On HTTP transport it works fine locally but breaks if the server is ever used via stdio (e.g., Claude Desktop local config).
**Why it happens:** Default JavaScript logging habit.
**How to avoid:** Use `console.error()` exclusively. Grep codebase for `console.log` as a CI check.
**Warning signs:** MCP client reports "parse error" or "invalid JSON" when connecting.

### Pitfall 4: Missing DNS Rebinding Protection
**What goes wrong:** MCP spec requires Origin header validation to prevent DNS rebinding attacks. Without it, a malicious website could interact with a locally running MCP server. CVE-2025-66414 was exactly this vulnerability in SDK <1.25.1.
**Why it happens:** Local development servers often skip security headers.
**How to avoid:** Use SDK >=1.25.1 (which includes the fix). When adding CORS, restrict origins to known clients, not `*` (the SDK example uses `*` but warns it's "for demo purposes only").
**Warning signs:** Security scanner findings. Unexpected requests from unknown origins.

### Pitfall 5: Not Handling Express JSON Parsing
**What goes wrong:** Express 5 does not parse JSON bodies by default. POST requests arrive with `undefined` body.
**Why it happens:** Express 4 had `express.json()` as separate middleware; Express 5 continues this pattern.
**How to avoid:** Add `app.use(express.json())` before route handlers.
**Warning signs:** "Cannot read properties of undefined" errors on `req.body`.

## Code Examples

### Complete Minimal MCP Server (Phase 1 Target)

```typescript
// Source: Synthesized from SDK v1.26.0 examples + project requirements
// src/index.ts

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";

// --- Config validation (DEPLOY-02, DEPLOY-03) ---
const ConfigSchema = z.object({
    COURTLISTENER_API_KEY: z.string().min(1, "COURTLISTENER_API_KEY is required"),
    PORT: z.coerce.number().default(3000),
});

const config = ConfigSchema.safeParse(process.env);
if (!config.success) {
    console.error("Configuration error - server refusing to start:");
    console.error(config.error.format());
    process.exit(1);
}

// --- Response envelope helper (MCP-04) ---
interface ResponseEnvelope {
    valid: boolean;
    metadata: Record<string, unknown> | null;
    error: { code: string; message: string; details?: unknown } | null;
}

function envelope(data: ResponseEnvelope) {
    return {
        content: [{ type: "text" as const, text: JSON.stringify(data) }]
    };
}

// --- Server factory ---
function createServer() {
    const server = new McpServer(
        { name: "lexcerta", version: "0.1.0" },
        { capabilities: { logging: {} } }
    );

    // Placeholder echo tool for testing (MCP-03 validates input via Zod)
    server.registerTool(
        "echo",
        {
            description: "Echo input back in the standard response envelope (test tool)",
            inputSchema: {
                message: z.string().min(1).describe("Message to echo back")
            }
        },
        async ({ message }) => envelope({
            valid: true,
            metadata: { echo: message },
            error: null
        })
    );

    return server;
}

// --- Express app with Streamable HTTP (MCP-01) ---
const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
    const server = createServer();
    try {
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined  // stateless
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        res.on("close", () => { transport.close(); server.close(); });
    } catch (error) {
        console.error("MCP request error:", error);  // MCP-05: stderr only
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: "2.0",
                error: { code: -32603, message: "Internal server error" },
                id: null
            });
        }
    }
});

app.get("/mcp", (_req, res) => {
    res.writeHead(405).end(JSON.stringify({
        jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null
    }));
});

app.delete("/mcp", (_req, res) => {
    res.writeHead(405).end(JSON.stringify({
        jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null
    }));
});

// --- Start ---
const PORT = config.data.PORT;
app.listen(PORT, () => {
    console.error(`LexCerta MCP server listening on port ${PORT}`);  // MCP-05: stderr
});
```

### SSE Fallback Endpoints (MCP-02)

```typescript
// Source: SDK SSEServerTransport + MCP spec backward compatibility guide
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

// Store active SSE transports for message routing
const sseTransports = new Map<string, SSEServerTransport>();

// Legacy SSE endpoint: client opens GET to receive event stream
app.get("/sse", async (_req, res) => {
    console.error("SSE client connected (legacy transport)");
    const server = createServer();
    const transport = new SSEServerTransport("/messages", res);
    sseTransports.set(transport.sessionId, transport);

    res.on("close", () => {
        sseTransports.delete(transport.sessionId);
        server.close();
    });

    await server.connect(transport);
});

// Legacy message endpoint: client POSTs JSON-RPC messages here
app.post("/messages", async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const transport = sseTransports.get(sessionId);
    if (!transport) {
        res.status(400).json({ error: "Unknown session" });
        return;
    }
    await transport.handlePostMessage(req, res, req.body);
});
```

### Testing with MCP Inspector

```bash
# Start server
COURTLISTENER_API_KEY=test-key tsx src/index.ts

# In another terminal, use MCP Inspector to connect
npx @modelcontextprotocol/inspector --url http://localhost:3000/mcp
```

### tsconfig.json

```json
{
    "compilerOptions": {
        "target": "ES2022",
        "module": "Node16",
        "moduleResolution": "Node16",
        "outDir": "./build",
        "rootDir": "./src",
        "strict": true,
        "esModuleInterop": true,
        "skipLibCheck": true,
        "forceConsistentCasingInFileNames": true
    },
    "include": ["src/**/*"],
    "exclude": ["node_modules"]
}
```

### package.json essentials

```json
{
    "name": "lexcerta",
    "version": "0.1.0",
    "type": "module",
    "scripts": {
        "dev": "tsx src/index.ts",
        "build": "tsc",
        "start": "node build/index.js",
        "test": "vitest",
        "lint": "biome check src/",
        "format": "biome format --write src/"
    }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| SSE transport (`GET /sse` + `POST /messages`) | Streamable HTTP (`POST /mcp` + optional `GET /mcp` for SSE) | MCP spec 2025-03-26 | SSE deprecated but supported for backward compat |
| `@modelcontextprotocol/sdk` monolith | Split packages (`@modelcontextprotocol/server` etc.) | v2 pre-alpha (Q1 2026 target) | NOT published yet -- use v1.x |
| `server.tool()` shorthand | `server.registerTool()` | SDK evolution | Both work in v1.26.0; `registerTool` is forward-compatible |
| `zod@3` only | `zod@^3.25 \|\| ^4.0` | SDK 1.17.6+ | SDK supports both; v3.25 is simpler for new projects |
| `@vercel/mcp-adapter` | `mcp-handler` | Renamed/deprecated | Use `mcp-handler` for Vercel deployment (Phase 6) |

**Deprecated/outdated:**
- `SSEServerTransport` as primary transport: Use for backward compat only, not as the main transport
- `@vercel/mcp-adapter`: Deprecated, re-exports from `mcp-handler`
- SDK v2 import paths (`@modelcontextprotocol/server`): Not published, pre-alpha only
- `server.tool()`: Works but `registerTool()` is the canonical API going forward

## Open Questions

1. **Express import resolution from SDK dependency**
   - What we know: SDK v1.26.0 bundles `express@^5.2.1` as a direct dependency. The SDK examples import Express directly.
   - What's unclear: Whether importing `express` directly works reliably when it is only a transitive dependency (not in the project's own `package.json`). Node.js module resolution should find it, but this is fragile.
   - Recommendation: If import fails, add `express@^5` as a direct project dependency. This is safe since the SDK already depends on it. LOW risk.

2. **SSE fallback implementation completeness**
   - What we know: The MCP spec describes backward compatibility. The SDK provides `SSEServerTransport`. The `mcp-handler` Vercel package handles both transports.
   - What's unclear: The exact SSEServerTransport API for v1.26.0 -- the example file `sseAndStreamableHttpCompatibleServer.ts` does not exist in the repository (404). The SSE transport API may have changed between versions.
   - Recommendation: Implement SSE fallback using the well-documented `SSEServerTransport` constructor pattern (`new SSEServerTransport("/messages", res)`). Verify with MCP Inspector's SSE mode. MEDIUM risk -- may need API adjustment.

3. **Zod validation error propagation**
   - What we know: SDK auto-validates tool inputs against Zod schemas before calling the handler. Invalid inputs should return a JSON-RPC error response.
   - What's unclear: The exact error format the SDK returns for Zod failures (is it a standard JSON-RPC -32602 error? Does it include Zod issue details?). This matters for Success Criterion 3.
   - Recommendation: Write a test that sends invalid input and inspect the actual response. The SDK handles this internally -- we just need to verify the behavior, not build it. LOW risk.

## Sources

### Primary (HIGH confidence)
- [MCP TypeScript SDK v1.26.0 npm](https://www.npmjs.com/package/@modelcontextprotocol/sdk) -- version, dependencies, exports verified via `npm view`
- [MCP Specification: Transports (2025-03-26)](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports) -- Streamable HTTP spec, SSE backward compatibility, session management
- [MCP Official: Build a Server tutorial](https://modelcontextprotocol.io/docs/develop/build-server) -- TypeScript server setup, tool registration with Zod, logging guidance
- [SDK simpleStatelessStreamableHttp.ts](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/simpleStatelessStreamableHttp.ts) -- stateless Streamable HTTP reference implementation (raw source verified via curl)
- [SDK simpleStreamableHttp.ts](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/simpleStreamableHttp.ts) -- stateful Streamable HTTP with session management (raw source verified via curl)

### Secondary (MEDIUM confidence)
- [Koyeb: Deploy Remote MCP Servers with Streamable HTTP](https://www.koyeb.com/tutorials/deploy-remote-mcp-servers-to-koyeb-using-streamable-http-transport) -- v1.x Express setup pattern with StreamableHTTPServerTransport verified
- [Vercel mcp-handler GitHub](https://github.com/vercel/mcp-handler) -- `createMcpHandler` API, SSE backward compat, Vercel deployment
- [Why MCP Deprecated SSE for Streamable HTTP](https://blog.fka.dev/blog/2025-06-06-why-mcp-deprecated-sse-and-go-with-streamable-http/) -- transport migration rationale

### Tertiary (LOW confidence)
- [SDK v2 README](https://github.com/modelcontextprotocol/typescript-sdk) -- v2 pre-alpha status, split package architecture (not published, but informs future direction)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - SDK version, Zod compatibility, Express bundling all verified via npm
- Architecture: HIGH - Patterns verified against official SDK examples (raw source fetched)
- Pitfalls: HIGH - v2 import confusion, Zod compatibility, stdout logging all documented in official sources
- SSE fallback: MEDIUM - SSEServerTransport API for v1.26.0 not fully verified (example file 404)

**Research date:** 2026-02-13
**Valid until:** 2026-03-15 (SDK v2 may publish to npm, changing recommendations)
