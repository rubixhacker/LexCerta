# Phase 6: Production Deployment - Research

**Researched:** 2026-02-13
**Domain:** Vercel serverless deployment of MCP server via mcp-handler
**Confidence:** HIGH

## Summary

Deploying LexCerta to Vercel is straightforward thanks to the official `mcp-handler` package and the `mcp-on-vercel` template from Vercel Labs. The deployment pattern uses a single `api/server.ts` file that wraps `createMcpHandler`, with a `vercel.json` that rewrites all requests to that handler. No Next.js is required -- Vercel Functions with the plain `/api/` directory pattern uses the Node.js runtime by default, which means full compatibility with all existing LexCerta dependencies (cockatiel, lru-cache, fuzzball).

The key architectural insight is that `createMcpHandler` internally creates a `McpServer` instance (from the same `@modelcontextprotocol/sdk` LexCerta already uses) and passes it to a callback. This means the existing tool registration functions (`registerVerifyCitationTool`, `registerVerifyQuoteTool`, etc.) can be called directly inside the callback with no refactoring. The main work is: (1) creating an `api/server.ts` entry point for Vercel, (2) adding `vercel.json` with routing and function config, (3) ensuring the module-level singletons (client, cache) work correctly in the serverless context, and (4) preserving the existing `src/index.ts` for local development.

**Primary recommendation:** Use the Vercel Functions pattern (`api/server.ts` + `vercel.json` rewrite) with `mcp-handler` v1.0.7. Keep the existing Express-based `src/index.ts` for local development. Do NOT use Edge Runtime -- use the default Node.js runtime for full dependency compatibility.

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `mcp-handler` | ^1.0.7 | Vercel MCP adapter | Official Vercel adapter. Creates McpServer internally, handles Streamable HTTP + SSE fallback, session management, cleanup. Successor to deprecated `@vercel/mcp-adapter`. |
| `@modelcontextprotocol/sdk` | ^1.26 | MCP server framework | Already installed. `mcp-handler` peers with >=1.25.2. LexCerta uses 1.26. |
| `zod` | ^3.25 | Schema validation | Already installed. `mcp-handler` peers with zod ^3. |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `vercel` (CLI) | latest | Local dev/deploy | Dev dependency for `vercel dev` local testing of the Vercel deployment path. Optional -- can also deploy via `git push` to Vercel-connected repo. |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `mcp-handler` (Vercel Functions) | Direct `StreamableHTTPServerTransport` on Vercel | Hand-rolling transport setup, session cleanup, SSE fallback. `mcp-handler` handles all of this. No reason to DIY. |
| Vercel Functions (Node.js runtime) | Vercel Edge Functions | Edge Runtime lacks full Node.js API support. cockatiel, lru-cache may not work. Node.js runtime is the safe choice. |
| Vercel | Cloudflare Workers | Cloudflare has its own `createMcpHandler` in the Agents SDK, different API. LexCerta's dependencies (cockatiel) may not work in Workers runtime. Vercel is simpler for this stack. |

**Installation:**
```bash
npm install mcp-handler@^1.0.7
```

Note: `@modelcontextprotocol/sdk` and `zod` are already installed. `mcp-handler` will use them as peer dependencies.

## Architecture Patterns

### Recommended Project Structure

```
lexcerta/
├── api/
│   └── server.ts          # Vercel Functions entry point (mcp-handler)
├── src/
│   ├── index.ts            # Local dev entry point (Express, unchanged)
│   ├── server.ts           # McpServer factory (shared by both entry points)
│   ├── transport.ts        # Express transport (local dev only)
│   ├── config.ts           # Zod config loader (shared)
│   ├── tools/              # Tool handlers (shared)
│   ├── clients/            # CourtListener client (shared)
│   ├── cache/              # LRU caches (shared)
│   ├── resilience/         # Circuit breaker, rate limiter (shared)
│   └── ...
├── vercel.json             # Vercel routing + function config
├── package.json
└── tsconfig.json
```

### Pattern 1: Vercel Entry Point (`api/server.ts`)

**What:** A thin adapter file that bridges `mcp-handler`'s `createMcpHandler` to the existing `createServer` function.

**When to use:** This is the only file needed for Vercel deployment.

**Example:**
```typescript
// Source: Verified from mcp-handler v1.0.7 source + mcp-on-vercel template
import { createMcpHandler } from "mcp-handler";
import { loadConfig } from "../src/config.js";
import { registerTools } from "../src/server.js";

const config = loadConfig();

const handler = createMcpHandler(
  (server) => {
    // Re-use existing tool registration logic
    registerTools(server, config);
  },
  {
    serverInfo: { name: "lexcerta", version: "0.1.0" },
  },
  {
    basePath: "/api",
    maxDuration: 60,
  }
);

export { handler as GET, handler as POST, handler as DELETE };
```

**Key insight from mcp-handler source code:** `createMcpHandler` internally does `new McpServer(serverInfo, mcpServerOptions)` and passes it to the callback. The callback `server` parameter is the exact same `McpServer` class from `@modelcontextprotocol/sdk/server/mcp.js`. This means existing `registerTool()` calls work unchanged.

### Pattern 2: Refactored `src/server.ts` for Dual Entry Points

**What:** Extract tool registration into a function that accepts an `McpServer` + `Config` but does NOT create the server. Let each entry point create its own server.

**Current code (`src/server.ts`):**
```typescript
export function createServer(config: Config): McpServer {
  const server = new McpServer(
    { name: "lexcerta", version: "0.1.0" },
    { capabilities: { logging: {} } },
  );
  // ... registers tools on server
  return server;
}
```

**Refactored approach:**
```typescript
// New: register tools on an already-created server
export function registerTools(server: McpServer, config: Config): void {
  const client = getClient(config);
  const cache = getCache();
  const opinionCache = getOpinionCache();
  registerEchoTool(server);
  registerParseCitationTool(server);
  registerVerifyCitationTool(server, client, cache);
  registerVerifyQuoteTool(server, client, cache, opinionCache);
}

// Keep for local dev (src/index.ts still creates its own McpServer)
export function createServer(config: Config): McpServer {
  const server = new McpServer(
    { name: "lexcerta", version: "0.1.0" },
    { capabilities: { logging: {} } },
  );
  registerTools(server, config);
  return server;
}
```

This way, `api/server.ts` calls `registerTools(server, config)` inside the `createMcpHandler` callback, and `src/index.ts` continues to use `createServer(config)` as before.

### Pattern 3: Vercel Routing via `vercel.json`

**What:** Route all requests to the single `api/server.ts` function.

**Example:**
```json
{
  "rewrites": [{ "source": "/(.+)", "destination": "/api/server" }],
  "functions": {
    "api/server.ts": {
      "maxDuration": 60
    }
  }
}
```

**Source:** Verified from `vercel-labs/mcp-on-vercel` template (https://github.com/vercel-labs/mcp-on-vercel).

The rewrite sends ALL paths (including `/mcp`, `/sse`, `/messages`) to the single `api/server.ts` function. `mcp-handler` handles internal routing between Streamable HTTP and SSE endpoints based on the request method and path.

### Pattern 4: Environment Variables on Vercel

**What:** Vercel environment variables are available via `process.env` in Node.js runtime functions, identical to local development.

**How to configure:**
1. Vercel Dashboard > Project Settings > Environment Variables
2. Add `COURTLISTENER_API_KEY` as a secret (encrypted at rest)
3. Scope to Production/Preview/Development as needed

**Key detail:** The existing `loadConfig()` function using `ConfigSchema.safeParse(process.env)` works unchanged on Vercel. No code changes needed for DEPLOY-02.

### Anti-Patterns to Avoid

- **Using Edge Runtime:** Do NOT export `export const runtime = "edge"` in `api/server.ts`. Edge Runtime has limited Node.js API support. cockatiel uses `setTimeout`/`clearTimeout` extensively and lru-cache uses features that may not be available. The default Node.js runtime is correct.
- **Creating Next.js just for deployment:** The `api/server.ts` + `vercel.json` pattern works without any framework. Do not introduce Next.js as a dependency.
- **Duplicating tool registration:** Do not copy-paste tool registration into `api/server.ts`. Extract and share from `src/server.ts`.
- **Using deprecated `@vercel/mcp-adapter`:** This package re-exports from `mcp-handler`. Use `mcp-handler` directly.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Streamable HTTP transport on Vercel | Custom transport handler with session management | `mcp-handler` `createMcpHandler` | Handles transport negotiation, SSE fallback, session cleanup, timeout management, memory leak prevention |
| Request routing (MCP vs SSE vs health) | Express-style routing in serverless | `vercel.json` rewrites + `mcp-handler` internal routing | `mcp-handler` routes internally between Streamable HTTP (POST) and SSE (GET) endpoints |
| Vercel-specific response adaptation | Custom `Response` to `ServerResponse` bridging | `mcp-handler` `server-response-adapter.ts` | Bridges Web Fetch API `Request`/`Response` to Node.js `IncomingMessage`/`ServerResponse` that the MCP SDK expects |

**Key insight:** `mcp-handler` exists precisely to solve the impedance mismatch between Vercel's serverless function model (Web Fetch API: `Request` -> `Response`) and the MCP SDK's expectation of Node.js HTTP primitives (`IncomingMessage`/`ServerResponse`). This is the primary value of the library.

## Common Pitfalls

### Pitfall 1: Module-Level Singletons in Serverless

**What goes wrong:** In the current `src/server.ts`, the `sharedClient`, `sharedCache`, and `sharedOpinionCache` are module-level singletons. In Vercel's serverless model, each function invocation MAY get a new cold start (no state) or MAY reuse a warm instance (state persists).

**Why it happens:** Vercel Functions with Fluid Compute reuse instances when possible, but there is no guarantee. The mcp-handler source confirms it creates a new `McpServer` instance per request, but module-level variables survive across requests in warm instances.

**How to avoid:** The current singleton pattern is actually CORRECT for this use case. Module-level singletons will persist across warm invocations (sharing rate limiter state, circuit breaker state, and cache), and will be re-created on cold starts. This is the desired behavior -- identical to how they work in the long-running Express server. No change needed.

**Warning signs:** If you see cache miss rates spike, it means cold starts are clearing state. This is expected and acceptable -- citations will be re-fetched from CourtListener.

### Pitfall 2: tsconfig `rootDir` Conflict

**What goes wrong:** The current `tsconfig.json` has `"rootDir": "./src"`. Adding `api/server.ts` outside `src/` would cause TypeScript compilation errors because `api/` is not under `rootDir`.

**Why it happens:** TypeScript enforces that all source files live under `rootDir` when it is set.

**How to avoid:** Either (a) change `rootDir` to `"."`, (b) add a separate `tsconfig.vercel.json` for the API entry point, or (c) use Vercel's built-in TypeScript compilation (Vercel compiles `api/*.ts` files automatically without needing them in your tsconfig). Option (c) is simplest -- Vercel has its own build pipeline for files in `api/`.

**Warning signs:** TypeScript errors like "File 'api/server.ts' is not under 'rootDir'".

### Pitfall 3: Import Paths in `api/server.ts`

**What goes wrong:** `api/server.ts` needs to import from `../src/server.js`. Vercel compiles `api/` files with its own pipeline, but the import paths must be resolvable.

**Why it happens:** Vercel Functions in the `api/` directory are compiled independently. They need to reference source files via relative imports that Vercel's bundler can resolve.

**How to avoid:** Use relative imports from `api/server.ts` to `src/` modules. Vercel's built-in bundler (based on esbuild/nft) will trace and bundle all dependencies. Test with `vercel dev` locally.

**Warning signs:** Runtime errors like "Cannot find module '../src/server.js'" in Vercel deployment logs.

### Pitfall 4: Forgetting DELETE Export

**What goes wrong:** MCP clients may send DELETE requests to terminate sessions. If `api/server.ts` does not export the handler for DELETE, these requests will return 404.

**Why it happens:** The Vercel template exports `handler as GET, handler as POST, handler as DELETE`. Easy to miss DELETE.

**How to avoid:** Always export all three: `export { handler as GET, handler as POST, handler as DELETE }`.

**Warning signs:** MCP clients logging "session termination failed" errors.

### Pitfall 5: maxDuration Too Low

**What goes wrong:** Quote verification involves multiple CourtListener API calls (citation lookup + opinion fetch + text comparison). If `maxDuration` is too low, the function times out mid-verification.

**Why it happens:** Default Vercel Function timeout varies by plan (10s Hobby, 60s Pro, 900s Enterprise). CourtListener API calls can take 2-5 seconds each, and quote verification chains multiple calls.

**How to avoid:** Set `maxDuration: 60` in both `vercel.json` and the `createMcpHandler` config. This requires at least a Vercel Pro plan (Hobby plan caps at 10s).

**Warning signs:** Functions returning 504 Gateway Timeout errors on quote verification calls.

## Code Examples

### Complete `api/server.ts` for Vercel Deployment

```typescript
// Source: Derived from vercel-labs/mcp-on-vercel template + LexCerta server.ts
import { createMcpHandler } from "mcp-handler";
import { loadConfig } from "../src/config.js";
import { registerTools } from "../src/server.js";

const config = loadConfig();

const handler = createMcpHandler(
  (server) => {
    registerTools(server, config);
  },
  {
    serverInfo: { name: "lexcerta", version: "0.1.0" },
    capabilities: { logging: {} },
  },
  {
    basePath: "/api",
    maxDuration: 60,
  }
);

export { handler as GET, handler as POST, handler as DELETE };
```

### Complete `vercel.json`

```json
{
  "rewrites": [{ "source": "/(.+)", "destination": "/api/server" }],
  "functions": {
    "api/server.ts": {
      "maxDuration": 60
    }
  }
}
```

### MCP Client Configuration (for testing)

```json
{
  "mcpServers": {
    "lexcerta": {
      "url": "https://lexcerta.vercel.app/api/server/mcp"
    }
  }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `@vercel/mcp-adapter` | `mcp-handler` | July 2025 (v1.0.0) | Package renamed. Import path changed. |
| SSE-only transport on Vercel | Streamable HTTP primary, SSE fallback | March 2025 (MCP spec update) | `mcp-handler` handles both automatically |
| Custom Express server on Vercel | `api/server.ts` with `createMcpHandler` | 2025 | No need for Express in production. `mcp-handler` handles HTTP directly via Fetch API adapter |
| Separate build step for Vercel | Vercel auto-compiles `api/*.ts` | Always (Vercel feature) | No custom build configuration needed |

**Deprecated/outdated:**
- `@vercel/mcp-adapter`: Renamed to `mcp-handler` in v1.0.0 (July 2025). Still works (re-exports from mcp-handler) but should not be used directly.
- SSE as primary transport: Deprecated in MCP spec March 2025. `mcp-handler` supports it as fallback only.

## Open Questions

1. **Vercel plan tier for `maxDuration`**
   - What we know: Hobby plan limits to 10s, Pro allows 60s, Enterprise allows 900s. Quote verification may need up to 15-20s for multi-API-call chains.
   - What's unclear: Whether the user has Vercel Pro or needs to work within Hobby plan limits.
   - Recommendation: Plan for 60s maxDuration (Pro tier). Document that Hobby plan may timeout on quote verification.

2. **Custom domain (lexcerta.ai) configuration**
   - What we know: PROJECT.md mentions `lexcerta.ai` on Cloudflare. Vercel supports custom domains.
   - What's unclear: Whether custom domain setup is in scope for this phase.
   - Recommendation: Use `*.vercel.app` domain for this phase. Custom domain is a separate concern.

3. **Health check endpoint**
   - What we know: Current Express server has `/health`. `mcp-handler` rewrites all paths to the MCP handler.
   - What's unclear: Whether a separate health check is needed on Vercel (Vercel has built-in health monitoring).
   - Recommendation: Skip custom health check. Vercel's monitoring is sufficient for v1. The MCP endpoint itself serves as a health indicator.

## Sources

### Primary (HIGH confidence)
- [mcp-handler GitHub](https://github.com/vercel/mcp-handler) - Source code reviewed: `src/handler/index.ts` confirms `createMcpHandler` creates `McpServer` internally and passes to callback
- [mcp-handler v1.0.7 source: handler/index.ts](https://raw.githubusercontent.com/vercel/mcp-handler/main/src/handler/index.ts) - Verified `ServerOptions` type includes `serverInfo` for name/version
- [mcp-handler v1.0.7 source: handler/mcp-api-handler.ts](https://github.com/vercel/mcp-handler/blob/main/src/handler/mcp-api-handler.ts) - Verified `new McpServer(serverInfo, mcpServerOptions)` call, Config type definition
- [vercel-labs/mcp-on-vercel template](https://github.com/vercel-labs/mcp-on-vercel) - Complete working template: `api/server.ts`, `vercel.json`, `package.json`, `tsconfig.json` verified
- [Vercel MCP deployment docs](https://vercel.com/docs/mcp/deploy-mcp-servers-to-vercel) - Official deployment guide with code examples
- [mcp-handler releases](https://github.com/vercel/mcp-handler/releases) - v1.0.7 latest (Jan 9, 2026), pins SDK to >=1.25.2

### Secondary (MEDIUM confidence)
- [Vercel Functions docs](https://vercel.com/docs/functions) - Node.js runtime is default for `/api/` directory, Fluid Compute details
- [Vercel Functions runtimes](https://vercel.com/docs/functions/runtimes) - Edge vs Node.js runtime comparison, Edge API limitations
- [Vercel environment variables](https://vercel.com/docs/environment-variables) - `process.env` access, secret management, per-environment scoping
- [Building efficient MCP servers (Vercel blog)](https://vercel.com/blog/building-efficient-mcp-servers) - 50% CPU reduction with Streamable HTTP, Fluid Compute benefits
- [MCP with Vercel Functions template](https://vercel.com/templates/other/model-context-protocol-mcp-with-vercel-functions) - Official template reference

### Tertiary (LOW confidence)
- None. All findings verified with primary/secondary sources.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - `mcp-handler` API verified from source code, template verified from official Vercel Labs repo
- Architecture: HIGH - Dual entry point pattern (local dev + Vercel) is well-understood, `createMcpHandler` callback receives same `McpServer` class
- Pitfalls: HIGH - Module-level singletons, tsconfig rootDir, import paths all verified against actual codebase and Vercel docs

**Research date:** 2026-02-13
**Valid until:** 2026-03-13 (stable - mcp-handler v1.x is mature, Vercel Functions are stable)
