# Architecture decision history

ADRs 0001–0038 record the original Worker-era boundaries. Their Cloudflare-specific storage, coordination, observability, and administration choices describe the retained reference adapter. The failed Worker memory gate selected the Node/Cloud Run fallback recorded in [runtime qualification](../../operations/worker-runtime-qualification.md), [Node runtime](../../operations/node-runtime.md), and [PostgreSQL storage](../../operations/postgres-storage.md). They are not instructions to restore the archived Cloudflare delivery implementation.

ADRs 0039–0046 and the [confirmed product scope](../product-scope.md) define the accepted lawyer workflows and supersede conflicting earlier product assumptions. Individual host authentication requires reconciling ADR 0006; the pinned protocol in ADR 0001 still requires host qualification. Source-permission and release-approval gates remain in force.
