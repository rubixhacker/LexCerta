# Phase 7: Next.js Migration - Research

**Researched:** 2026-02-13
**Domain:** Next.js App Router migration for existing MCP serverless function
**Confidence:** HIGH

## Summary

This phase converts the existing standalone Vercel serverless function (`api/server.ts` with `mcp-handler`) into a Next.js App Router project. The MCP server logic in `src/` remains untouched; only the entry point moves from a root-level `api/` directory into Next.js's `app/api/` route handler convention.

The migration is well-supported: `mcp-handler` v1.0.7 was designed for Next.js App Router and already uses the exact `createMcpHandler` + named export pattern that App Router route handlers expect. The current `api/server.ts` already exports `{ handler as GET, handler as POST, handler as DELETE }` -- this is identical to the Next.js route handler convention. The main work is project restructuring (adding `next.config.ts`, updating `tsconfig.json`, creating `app/` directory, moving the handler file) and removing the now-unnecessary `vercel.json` rewrites.

Next.js 15.5.x is the target version (15.5.12 is the latest patch). The prior v1.1 stack research recommends v15 over v16 due to breaking changes in v16 (middleware renamed to proxy, sync request APIs removed, Turbopack default) that add risk without benefit for this migration. `mcp-handler` requires `next>=13.0.0` as a peer dependency, so v15 is fully compatible.

**Primary recommendation:** Install `next@^15.5.12 react@^19 react-dom@^19`, create `app/api/mcp/[transport]/route.ts` with the existing `createMcpHandler` call (basePath changes from `/api` to `/api/mcp`), add a minimal `app/layout.tsx` and `app/page.tsx`, update `tsconfig.json` for Next.js, create `next.config.ts`, delete the top-level `api/` directory and simplify `vercel.json`, then verify all three MCP tools work identically.

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| next | ^15.5.12 | Full-stack framework, App Router | Latest stable v15 LTS. v16 introduces breaking changes (proxy rename, async-only APIs) not needed for API-only migration. mcp-handler peer dep satisfied (>=13). |
| react | ^19.0 | Required peer dependency of Next.js 15 | App Router requires React 19. No UI rendering needed in Phase 7 but the dependency is mandatory. |
| react-dom | ^19.0 | Required peer dependency of Next.js 15 | Peer dependency of `next`. |
| mcp-handler | ^1.0.7 (existing) | MCP protocol handler for Vercel/Next.js | Already installed. Designed for Next.js App Router `[transport]` route pattern. No version change needed. |
| @modelcontextprotocol/sdk | 1.25.2 (existing) | MCP protocol implementation | Already installed. Pinned to 1.25.2 by mcp-handler peer dependency. Latest SDK is 1.26.0 but mcp-handler pins to exactly 1.25.2. Do NOT upgrade until mcp-handler updates its peer dep. |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @types/react | ^19 | TypeScript definitions for React | Dev dependency. Required because Next.js App Router files import React types even for API-only routes. |
| @types/react-dom | ^19 | TypeScript definitions for ReactDOM | Dev dependency. Peer of @types/react. |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Next.js 15.5.x | Next.js 16.1.6 | v16 is latest but has breaking changes: `middleware` renamed to `proxy`, sync `cookies()`/`headers()` removed, Turbopack default (may conflict with existing build). Supabase SSR not ecosystem-tested against v16. Upgrade path exists for later phases. |
| Moving api/server.ts into app/ | Keeping api/ alongside app/ | Vercel routing conflicts between root-level `api/` and Next.js `app/api/` are documented (GitHub vercel/vercel#12676). The catch-all rewrite in `vercel.json` would intercept all Next.js routes. Must fully migrate to app/. |

### What to Remove

| Current | Why Remove |
|---------|-----------|
| `api/server.ts` (top-level) | Replaced by `app/api/mcp/[transport]/route.ts`. Root-level `api/` causes Vercel routing conflicts with Next.js App Router. |
| `vercel.json` rewrites | Next.js handles all routing. The catch-all rewrite `"source": "/(.+)"` would intercept dashboard pages and other API routes added in later phases. |
| `vercel.json` buildCommand: "" | Next.js needs its build step (`next build`). Empty build command was correct for standalone serverless function, wrong for Next.js. |
| `src/index.ts` (Express entry) | Local dev moves to `next dev`. Express-based transport (`src/transport.ts`) is replaced by mcp-handler for production. Keep `src/transport.ts` for potential local dev testing via `tsx` but it is no longer the primary entry point. |
| `@types/express` devDep | Express is no longer used for the primary server. Can be removed if `src/transport.ts` is removed; otherwise keep as devDep. |

**Installation:**
```bash
# Core framework (NEW)
npm install next@^15.5.12 react@^19 react-dom@^19

# Dev dependencies (NEW)
npm install -D @types/react@^19 @types/react-dom@^19
```

## Architecture Patterns

### Recommended Project Structure (Post-Migration)

```
lexcerta/
  app/                              # NEW -- Next.js App Router
    layout.tsx                      # Minimal root layout (required by Next.js)
    page.tsx                        # Minimal placeholder page
    api/
      mcp/
        [transport]/route.ts        # MCP server handler (MOVED from /api/server.ts)
  src/                              # EXISTING -- unchanged
    server.ts                       # registerTools, createServer (unchanged)
    config.ts                       # loadConfig (unchanged)
    tools/                          # Tool handlers (unchanged)
    parser/                         # Citation parser (unchanged)
    clients/                        # CourtListener client (unchanged)
    cache/                          # LRU caches (unchanged)
    resilience/                     # Circuit breaker, rate limiter (unchanged)
    __tests__/                      # Existing tests (unchanged)
    transport.ts                    # Express transport (keep for local dev, no longer primary)
    index.ts                        # Express entry (keep for local dev, no longer primary)
    logger.ts                       # Logger (unchanged)
    types.ts                        # Types (unchanged)
  next.config.ts                    # NEW -- Next.js configuration
  tsconfig.json                     # MODIFIED -- Next.js compatible settings
  vercel.json                       # SIMPLIFIED -- remove rewrites, remove buildCommand
  biome.json                        # EXISTING -- unchanged
  package.json                      # MODIFIED -- new deps, new scripts
```

### Pattern 1: MCP Route Handler in App Router

**What:** Move the existing `api/server.ts` handler into `app/api/mcp/[transport]/route.ts` with updated basePath.

**When to use:** This is the primary migration pattern.

**Current code (`api/server.ts`):**
```typescript
import { createMcpHandler } from "mcp-handler";
import { loadConfig } from "../src/config.js";
import { registerTools } from "../src/server.js";

const handler = createMcpHandler(
  (server) => {
    const config = loadConfig();
    registerTools(server, config);
  },
  {
    serverInfo: { name: "lexcerta", version: "0.1.0" },
    capabilities: { logging: {} },
  },
  {
    basePath: "/api",
    maxDuration: 60,
    verboseLogs: true,
  },
);

export { handler as GET, handler as POST, handler as DELETE };
```

**Migrated code (`app/api/mcp/[transport]/route.ts`):**
```typescript
// Source: mcp-handler GitHub README + current api/server.ts
import { createMcpHandler } from "mcp-handler";
import { loadConfig } from "../../../../src/config.js";
import { registerTools } from "../../../../src/server.js";

const handler = createMcpHandler(
  (server) => {
    const config = loadConfig();
    registerTools(server, config);
  },
  {
    serverInfo: { name: "lexcerta", version: "0.1.0" },
    capabilities: { logging: {} },
  },
  {
    basePath: "/api/mcp",  // CHANGED: was "/api", now "/api/mcp"
    maxDuration: 60,
    verboseLogs: true,
  },
);

export { handler as GET, handler as POST, handler as DELETE };
```

**Key changes:**
1. `basePath` changes from `"/api"` to `"/api/mcp"` -- this must match the directory path where `[transport]` lives
2. Import paths change due to deeper nesting (or use path aliases after tsconfig update)
3. Everything else stays identical -- same `createMcpHandler` API, same exports

**MCP endpoint URL changes:**
- Old: `https://lexcerta.vercel.app/api/mcp` (via catch-all rewrite to `/api/server`)
- New: `https://lexcerta.vercel.app/api/mcp/mcp` (direct Next.js route, `[transport]` resolves to `mcp`)

Wait -- the mcp-handler `[transport]` dynamic segment captures the transport type. With `basePath: "/api/mcp"`:
- Streamable HTTP: clients connect to `/api/mcp/mcp` (POST)
- SSE: clients connect to `/api/mcp/sse` (GET)

This is correct per mcp-handler README. The `basePath` tells mcp-handler where it is mounted; the `[transport]` segment selects the protocol.

### Pattern 2: Path Aliases for Clean Imports

**What:** Use tsconfig path aliases so route handlers can import from `src/` cleanly.

**Example:**
```json
// tsconfig.json
{
  "compilerOptions": {
    "paths": {
      "@/*": ["./src/*"]
    }
  }
}
```

Then the route handler becomes:
```typescript
import { loadConfig } from "@/config";
import { registerTools } from "@/server";
```

This is cleaner than `../../../../src/config.js` and is the standard Next.js pattern.

### Pattern 3: Minimal Root Layout (API-Only Phase)

**What:** Next.js App Router requires `app/layout.tsx`. For Phase 7 (no UI), create a minimal one.

```typescript
// app/layout.tsx
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

```typescript
// app/page.tsx
export default function Home() {
  return <main><h1>LexCerta</h1><p>Legal citation verification MCP server.</p></main>;
}
```

These are placeholders. Later phases (dashboard, auth) will expand them.

### Pattern 4: Singleton Preservation via globalThis

**What:** The existing `src/server.ts` uses module-level singletons (`sharedClient`, `sharedCache`). Next.js dev mode (HMR) re-executes modules, potentially resetting these singletons.

**Source:** v1.1 PITFALLS.md, Pitfall 8

```typescript
// Pattern for Next.js-safe singletons (if needed)
const globalForLexCerta = globalThis as unknown as {
  courtlistenerClient: CourtListenerClient | undefined;
  citationCache: CitationCache | undefined;
};

export const client = globalForLexCerta.courtlistenerClient ??= new CourtListenerClient(...);
```

**Recommendation for Phase 7:** Do NOT refactor singletons yet. The current module-level pattern works in production (serverless instances persist modules within a single invocation lifetime). The `globalThis` pattern is only needed if cache hit rates drop in dev mode. Test first, refactor only if needed.

### Anti-Patterns to Avoid

- **Keeping both `api/` and `app/api/` directories:** Causes Vercel routing collisions. The root-level `api/` must be deleted after the handler moves to `app/api/`. See PITFALLS.md Pitfall 1.
- **Keeping the catch-all rewrite in vercel.json:** The rewrite `"source": "/(.+)", "destination": "/api/server"` intercepts ALL requests including Next.js pages. Must be removed.
- **Upgrading @modelcontextprotocol/sdk beyond 1.25.2:** mcp-handler v1.0.7 pins its peer dependency to exactly `1.25.2`. npm/pnpm will warn about peer dep mismatch if you install 1.26.0. Keep pinned until mcp-handler updates.
- **Using `next.config.mjs` with `output: 'export'`:** This creates a static export. LexCerta needs serverless functions for the MCP endpoint. Do NOT set `output: 'export'`.
- **Adding `src/` to the Next.js `app` directory:** The existing `src/` contains server-side MCP logic, not Next.js pages. It stays at the root. The `app/` directory is separate.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| MCP transport handling | Custom Streamable HTTP / SSE handler | `mcp-handler` `createMcpHandler` | Already handles transport negotiation, session management, SSE fallback. Tested with Vercel serverless. |
| Route handler exports | Custom request/response adapters | Next.js named exports (GET, POST, DELETE) | mcp-handler already returns a handler compatible with Next.js route handler exports. Zero adaptation needed. |
| Build configuration | Custom Webpack/esbuild setup | `next build` (Webpack in v15) | Next.js handles TypeScript compilation, bundling, and Vercel deployment artifacts. |
| API routing | Express router or custom routing | Next.js file-system routing | `app/api/mcp/[transport]/route.ts` handles all MCP routes via the `[transport]` dynamic segment. |

**Key insight:** This migration requires almost no new code. It is a restructuring operation: move files, update config, verify behavior.

## Common Pitfalls

### Pitfall 1: Vercel Routing Collision (CRITICAL)

**What goes wrong:** The current `vercel.json` rewrites ALL paths to `/api/server`. This catch-all intercepts Next.js pages and new API routes, causing 404s or MCP protocol errors on non-MCP routes.
**Why it happens:** Vercel processes rewrites before framework routing.
**How to avoid:** Delete the catch-all rewrite and `buildCommand: ""` from `vercel.json`. Let Next.js handle all routing. Migrate the MCP endpoint into `app/api/` BEFORE adding any other routes.
**Warning signs:** 404s on `/`, HTML responses where JSON-RPC expected, routes working locally but failing in production.
**Confidence:** HIGH -- documented in Vercel GitHub issue #12676 and confirmed by current `vercel.json` analysis.

### Pitfall 2: tsconfig.json Incompatibility

**What goes wrong:** The current `tsconfig.json` uses `"module": "Node16"` and `"moduleResolution": "Node16"` with `"rootDir": "./src"`. Next.js requires different settings: `"module": "ESNext"` (or `"NodeNext"`), `"moduleResolution": "bundler"`, and the `include` array must cover both `app/` and `src/`.
**Why it happens:** The current config was designed for standalone TypeScript compilation (`tsc`). Next.js uses its own bundler (Turbopack in dev, Webpack in v15 build) and expects bundler-compatible module resolution.
**How to avoid:** Update `tsconfig.json` to the Next.js recommended settings. Key changes:
  - `"module": "ESNext"` and `"moduleResolution": "bundler"`
  - Remove `"rootDir": "./src"` (Next.js files are in `app/`, not `src/`)
  - Remove `"outDir": "./build"` (Next.js outputs to `.next/`)
  - Add `"jsx": "preserve"` (required for `.tsx` files in `app/`)
  - Add `"plugins": [{ "name": "next" }]`
  - Add `"incremental": true`
  - Update `"include"` to `["src/**/*", "app/**/*", "next-env.d.ts"]`
**Warning signs:** TypeScript errors on `import` statements, "Cannot find module" errors for `.js` extensions in imports.
**Confidence:** HIGH -- verified against Next.js 16 installation docs (which apply to v15 as well).

### Pitfall 3: .js Extension in Existing Imports

**What goes wrong:** All existing `src/` imports use `.js` extensions (e.g., `import { loadConfig } from "./config.js"`). This is correct for `"moduleResolution": "Node16"` but may cause issues with `"moduleResolution": "bundler"`.
**Why it happens:** The project was built for Node.js native ESM which requires explicit `.js` extensions. Bundler-mode module resolution resolves extensions automatically.
**How to avoid:** Test that all existing imports resolve correctly after tsconfig changes. Bundler-mode generally tolerates `.js` extensions pointing to `.ts` files. If issues arise, the `.js` extensions can be kept -- bundler resolution handles this.
**Warning signs:** Module resolution errors during `next build`.
**Confidence:** MEDIUM -- bundler mode typically handles `.js` extensions but edge cases may exist with deeply nested imports.

### Pitfall 4: Package.json Module Type

**What goes wrong:** The project has `"type": "module"` in `package.json`. Next.js projects typically do NOT set this because the framework handles module format internally.
**Why it happens:** `"type": "module"` was set for standalone Node.js ESM execution. Next.js uses its own module system.
**How to avoid:** Test with `"type": "module"` first. If build errors occur related to CommonJS/ESM interop (particularly with `mcp-handler` which is `"type": "commonjs"`), remove `"type": "module"` from `package.json`. Next.js and the bundler handle ESM/CJS interop.
**Warning signs:** "require is not defined in ES module scope" or "Cannot use import statement outside a module" errors.
**Confidence:** MEDIUM -- depends on how Next.js bundler handles the interaction. Needs testing.

### Pitfall 5: MCP Client URL Change

**What goes wrong:** MCP clients configured to connect to the old endpoint URL stop working after migration because the endpoint path changes.
**Why it happens:** Old URL: `https://domain/api/mcp` (via catch-all rewrite). New URL: `https://domain/api/mcp/mcp` (direct route, `[transport]` = `mcp`).
**How to avoid:** Document the URL change. The new endpoint for Streamable HTTP is `/api/mcp/mcp`. For SSE, it is `/api/mcp/sse`. Update any MCP client configurations (Claude Desktop, etc.) to use the new URL.
**Warning signs:** MCP clients returning connection errors after deployment.
**Confidence:** HIGH -- deterministic from the route structure.

### Pitfall 6: Vitest Configuration After Next.js

**What goes wrong:** Existing tests in `src/__tests__/` may break if the tsconfig changes affect vitest's module resolution.
**Why it happens:** Vitest uses its own module resolution (via Vite). The tsconfig changes for Next.js may not automatically apply to vitest.
**How to avoid:** Create or update `vitest.config.ts` to explicitly configure paths and module resolution. The existing tests do not test Next.js components, so they should not need the `@vitejs/plugin-react` or jsdom environment. Verify all 13 existing test files pass after migration.
**Warning signs:** Import errors in test files, "Cannot find module" in vitest output.
**Confidence:** MEDIUM -- vitest is already configured and working; changes depend on tsconfig interaction.

## Code Examples

### next.config.ts

```typescript
// Source: Next.js official docs + project requirements
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // No custom webpack config needed
  // No output: 'export' -- we need serverless functions
  // No basePath -- serving from root domain
};

export default nextConfig;
```

### Updated tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "preserve",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "incremental": true,
    "noEmit": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "allowJs": true,
    "plugins": [{ "name": "next" }],
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src/**/*", "app/**/*", "next-env.d.ts", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

**Key changes from current tsconfig:**
- `module`: `Node16` -> `ESNext`
- `moduleResolution`: `Node16` -> `bundler`
- Removed: `rootDir`, `outDir`
- Added: `jsx`, `incremental`, `noEmit`, `isolatedModules`, `resolveJsonModule`, `allowJs`, `plugins`, `paths`
- `include` expanded to cover `app/`, `next-env.d.ts`, `.next/types/`

### Updated package.json scripts

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "dev:mcp": "tsx src/index.ts",
    "test": "vitest",
    "lint": "biome check src/ app/",
    "format": "biome format --write src/ app/"
  }
}
```

### Simplified vercel.json

```json
{
  "functions": {
    "app/api/mcp/[transport]/route.ts": {
      "maxDuration": 60
    }
  }
}
```

Or potentially just delete `vercel.json` entirely -- Next.js on Vercel auto-detects the framework and `maxDuration` can be set via route segment config:

```typescript
// app/api/mcp/[transport]/route.ts
export const maxDuration = 60;
```

### .gitignore additions

```
.next
next-env.d.ts
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Standalone `api/` Vercel functions | Next.js App Router route handlers | Next.js 13.2 (2023) | Route handlers in `app/api/` are the standard. Root-level `api/` is the legacy Vercel Functions pattern. |
| SSE-only MCP transport | Streamable HTTP (primary) + SSE (fallback) | MCP SDK 1.25+ / mcp-handler 1.0+ | mcp-handler handles both transports via `[transport]` dynamic route. |
| `vercel.json` rewrites for routing | Next.js file-system routing | Always for Next.js projects | `vercel.json` is unnecessary for routing when Next.js handles it. |
| `tsc` compilation to `build/` | Next.js bundler (Webpack v15 / Turbopack v16) | With Next.js adoption | `next build` handles all compilation. No separate `tsc` step. |
| `"module": "Node16"` in tsconfig | `"moduleResolution": "bundler"` | Next.js 13.4+ | Bundler resolution is the Next.js standard. |

**Deprecated/outdated:**
- Root-level `api/` directory for Vercel Functions is the legacy pattern; Next.js App Router `app/api/` is current.
- `buildCommand: ""` in `vercel.json` is only valid for non-framework Vercel deployments.

## Open Questions

1. **`"type": "module"` in package.json compatibility with Next.js + mcp-handler**
   - What we know: Current project uses `"type": "module"`. mcp-handler is `"type": "commonjs"`. Next.js handles ESM/CJS interop internally.
   - What's unclear: Whether `"type": "module"` causes issues with `next build` or `next dev` when importing from mcp-handler.
   - Recommendation: Test with it first. If build errors occur, remove it. Next.js does not require `"type": "module"`.

2. **Exact vitest.config.ts changes needed**
   - What we know: Vitest works currently with Node16 module resolution. Changing to bundler resolution may affect test module loading.
   - What's unclear: Whether vitest needs a separate tsconfig or explicit config to maintain compatibility.
   - Recommendation: Run existing tests after tsconfig changes. If they break, add `vite-tsconfig-paths` plugin to vitest config. The Next.js vitest guide recommends this plugin.

3. **Whether `src/transport.ts` (Express-based) should be kept or removed**
   - What we know: `src/transport.ts` provides Express-based Streamable HTTP and SSE transports for local dev. `src/index.ts` starts the Express server. After migration, `next dev` serves the MCP endpoint.
   - What's unclear: Whether keeping the Express transport provides value for local testing without Next.js overhead.
   - Recommendation: Keep both files for now. They are useful for debugging MCP protocol issues without the Next.js layer. Mark them as "local dev only" in comments. Remove in a future cleanup phase if unused.

4. **mcp-handler peer dependency pinning to SDK 1.25.2**
   - What we know: mcp-handler v1.0.7 pins `@modelcontextprotocol/sdk` to exactly `1.25.2`. The latest SDK is `1.26.0`. The project currently has `1.25.2` installed.
   - What's unclear: When mcp-handler will update to support newer SDK versions.
   - Recommendation: Do not upgrade the SDK. Monitor the mcp-handler GitHub repo for releases. This is noted in the prior decisions but worth tracking.

## Sources

### Primary (HIGH confidence)
- [mcp-handler GitHub README](https://github.com/vercel/mcp-handler) -- Next.js App Router integration pattern, `[transport]` route setup, basePath configuration
- [Next.js 16 Upgrade Guide](https://nextjs.org/docs/app/guides/upgrading/version-16) -- breaking changes documentation (confirms v15 is safer choice)
- [Next.js Installation Guide](https://nextjs.org/docs/app/getting-started/installation) -- tsconfig requirements, manual installation steps
- [Next.js Route Handlers](https://nextjs.org/docs/app/api-reference/file-conventions/route) -- named export pattern (GET, POST, DELETE)
- [Next.js Vite Migration Guide](https://nextjs.org/docs/app/guides/migrating/from-vite) -- tsconfig migration steps (applicable to any non-Next.js TypeScript project)
- mcp-handler `package.json` (local `node_modules`) -- peer dependencies: `@modelcontextprotocol/sdk: 1.25.2`, `next: >=13.0.0`
- npm registry -- `next@15.5.12` (latest v15), `next@16.1.6` (latest overall), `@modelcontextprotocol/sdk@1.26.0` (latest SDK)

### Secondary (MEDIUM confidence)
- [Next.js Vitest Guide](https://nextjs.org/docs/app/guides/testing/vitest) -- vitest configuration for Next.js projects
- [Next.js MCP Guide](https://nextjs.org/docs/app/guides/mcp) -- built-in MCP devtools (Next.js 16+ only, not directly relevant to Phase 7 but informative)
- [Vercel Next.js Deployment](https://vercel.com/docs/frameworks/full-stack/nextjs) -- framework detection, serverless function behavior

### Tertiary (LOW confidence)
- [Vercel GitHub issue #12676](https://github.com/vercel/vercel/issues/12676) -- routing conflict between root-level `api/` and Next.js App Router (referenced in PITFALLS.md, not independently verified by this research)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- versions verified against npm registry, mcp-handler peer deps checked locally, Next.js docs reviewed
- Architecture: HIGH -- the migration pattern is straightforward file restructuring; mcp-handler already uses the target pattern
- Pitfalls: HIGH for routing/tsconfig (well-documented); MEDIUM for module type and vitest compat (need empirical testing)

**Research date:** 2026-02-13
**Valid until:** 2026-03-13 (stable domain; Next.js 15.x is LTS, mcp-handler is stable)
