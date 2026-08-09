# Worker runtime qualification

Status: **approved for Cloudflare Workers**. The deploy configuration sets the paid CPU budget to `limits.cpu_ms: 5000`. Issue #11 remains the deployed-canary confirmation gate.

## Exact artifact

The current dry-run artifact is [qualification-manifest.json](../.omo/evidence/issue-10/worker-artifact-release/qualification-manifest.json). Its deployable bundle is `worker.js`, SHA-256 `079c177c7c7f87413d069d480f1e680be50537e1e0f0a7ec568d519739d562ad`, with compatibility date `2026-08-01`.

| Component | Resolved version |
| --- | --- |
| `@modelcontextprotocol/server` | `2.0.0` |
| `parse5` | `8.0.1` |
| `zod` | `4.4.1` |
| Wrangler | `4.120.0` |
| workerd | `2026-08-01` |

Recreate the manifest with a new, empty evidence directory before any staging candidate:

```sh
node scripts/qualify-worker-artifact.mjs .omo/evidence/issue-10/worker-artifact-<candidate>
```

The generated manifest records the bundle checksum, all emitted-file checksums, source commit context, lockfile/configuration checksums, and the exact resolved production dependency graph. It refuses to overwrite a directory so a candidate cannot silently inherit a prior bundle.

## Local workerd conformance

The fixture-only real-workerd scenario is `test/worker-runtime-conformance.integration.test.ts`.

```sh
npx vitest run test/worker-runtime-conformance.integration.test.ts
```

It proves these binary observations through the deployed Worker entrypoint, local D1/R2/Durable Object bindings, and the official server handler:

| Scenario | Observable result | Constraint proved |
| --- | --- | --- |
| Modern discovery | HTTP `200`, only `2026-07-28`, tools capability | Official handler accepts the required stateless envelope. |
| 10,000-code-point quote in `html_with_citations` | HTTP `200`, `verified`, metadata-only response | The real `parse5` path runs and does not disclose fixture source text. |
| Fixture upstream | Exactly four permitted CourtListener fixture URLs: usage, citation lookup, cluster, then opinion | No live upstream call and no extra outbound request. |
| `subscriptions/listen` | HTTP `400`, no `text/event-stream`, zero outbound requests | Persistent subscription/SSE traffic is rejected. |

The body boundary is separately exercised by:

```sh
npx vitest run test/worker-request-body.integration.test.ts
```

Its declared and streamed oversize scenarios return HTTP `413`, `Cache-Control: no-store`, and zero upstream calls. The Worker cancels the bounded reader before dispatch; the observable no-dispatch result is the regression gate for that cancellation constraint.

An attempted run of `@modelcontextprotocol/conformance@0.2.0-alpha.11` is retained only as diagnostic evidence in `.omo/evidence/issue-10/official-tools-list-investigation.log`. Its forced `tools-list` request omits the mandatory 2026 per-request envelope and receives the expected strict rejection. It is not recorded as a product conformance result. The direct, envelope-complete workerd result is retained in `.omo/evidence/issue-10/direct-tools-list-after-envelope.json`.

## Runtime decision

Do not select a runtime from local compatibility alone. Local workerd has no production memory limit enforcement or per-request production CPU/memory metrics.

The local qualification report is [worker-qualification-benchmark.json](../.omo/evidence/issue-10-worker-qualification/final/worker-qualification-benchmark.json). It exercised the maximum fixture-only workload: a 10,000-code-point quote and 100 sequential 65,536-byte opinion responses. Its 1,476,622-byte bundle size matches the current artifact manifest; every deployment candidate must retain the recorded bundle SHA-256 or be requalified.

| Gate | Evidence and verdict |
| --- | --- |
| Compatibility and protocol | Green: this artifact manifest and the local workerd scenarios above pass. |
| CPU | Green: exact values are in the machine artifact; repeated qualification runs remained below 250 ms sampled core-entry CPU, below the approved 5,000 ms paid budget. |
| Memory and allocations | Green for local qualification: repeated runs remained below 4 MiB peak observed core-entry heap and 256 KiB sampled allocations, both far below 128 MB. Local workerd does not enforce the deployed limit. |
| Completion and outbound bounds | Green: repeated local wall time remained below 2 s; cold scenarios make 103 sequential outbound fixture requests and record zero cancellations. |
| Production confirmation | Required before promotion: Issue #11 staging canary records Cloudflare production CPU/memory observations for the identical bundle checksum. |

Current decision: **Cloudflare Workers approved**. No optimization pass is needed. Issue #11 must confirm the same bundle checksum and the committed `limits.cpu_ms: 5000` budget in staging production telemetry before promotion.

If a compatibility, memory, or CPU gate fails, make exactly one bounded optimization attempt against the same scenario. Record before/after bundle checksums and measurements. If the failed gate remains failed after that one attempt, select the unchanged TypeScript verification module on Cloud Run. Do not introduce Kotlin as a fallback.
