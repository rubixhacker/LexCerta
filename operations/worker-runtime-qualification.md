# Worker runtime qualification

Status: **Cloudflare Workers rejected; select the unchanged TypeScript Cloud Run fallback**. The exact Worker artifact is compatible and stays within the approved `limits.cpu_ms: 5000` CPU budget, but repeated maximum-workload runs do not reliably remain below the fixed 128 MiB memory limit. Issue #11 must deliver and promote the Cloud Run artifact instead of this Worker artifact.

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

The generated manifest records the bundle checksum, all emitted-file checksums, source commit context, lockfile/configuration checksums, and the exact resolved production dependency graph. It refuses to overwrite a directory or build when tracked/indexed files differ from `HEAD`; untracked evidence is allowed. This record proves compatibility and the rejected Worker candidate's identity; it is not eligible for production promotion.

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

The release artifact itself is exercised separately, after Wrangler emits `worker.js`:

```sh
node --test scripts/worker-bundle-conformance.test.mjs
```

This test loads that immutable bundle directly into Miniflare/workerd, applies every committed D1 migration, and drives modern discovery plus the 10,000-code-point `html_with_citations` verification path through D1, R2, and both Durable Objects. A strict outbound service permits only the four fixture CourtListener URLs; any other URL makes qualification fail. The report records the emitted bundle checksum, binding observations, request sequence, and redaction results without retaining fixture legal text or credentials.

An attempted run of `@modelcontextprotocol/conformance@0.2.0-alpha.11` is retained only as diagnostic evidence in `.omo/evidence/issue-10/official-tools-list-investigation.log`. Its forced `tools-list` request omits the mandatory 2026 per-request envelope and receives the expected strict rejection. It is not recorded as a product conformance result. The direct, envelope-complete workerd result is retained in `.omo/evidence/issue-10/direct-tools-list-after-envelope.json`.

## Runtime decision

Do not select a runtime from local compatibility alone. Local workerd has no production memory limit enforcement or per-request production CPU/memory metrics.

The local qualification report is [worker-qualification-benchmark.json](../.omo/evidence/issue-10-worker-qualification/final/worker-qualification-benchmark.json). It exercised the maximum fixture-only workload: a 10,000-code-point quote and 100 sequential 65,536-byte opinion responses. Its 1,476,622-byte bundle size matches the current artifact manifest; every deployment candidate must retain the recorded bundle SHA-256 or be requalified.

| Gate | Evidence and verdict |
| --- | --- |
| Compatibility and protocol | Green: this artifact manifest and the local workerd scenarios above pass. |
| CPU | Green: exact values are in the machine artifact; sampled CPU from the exact Vitest runner isolate executing `SELF.fetch` and the conservative single-isolate wall-time bound both remain below the approved 5,000 ms paid budget. `core:entry` is recorded separately as the paused control target. |
| Memory and allocations | **Failed for reliable Worker qualification.** Every 20 ms CDP sample retains `usedSize`, `totalSize`, `embedderHeapUsedSize`, and `backingStorageSize`; the fail-closed gate uses `totalSize + embedderHeapUsedSize + backingStorageSize`. Two post-calibration runs peaked at 132,149,536 to 132,411,680 bytes, but an independent exact-SHA run peaked at 135,459,674 bytes, exceeding 134,217,728. The narrow passing margin is therefore not reliable evidence of compliance. Sampled allocations remain in each machine artifact. |
| Completion and outbound bounds | Green: repeated local wall time remained below 2 s; cold scenarios make 103 sequential outbound fixture requests and record zero cancellations. |
| Production confirmation | The Worker artifact is not eligible. Issue #11 must stage the same TypeScript verification contract on Cloud Run and bind promotion to that immutable container artifact. |

Current decision: **Google Cloud Run selected with the unchanged TypeScript verification contract**. The single bounded pass replaced eager retention of all 100 synthetic maximum-size upstream bodies with per-request generation; every response remained exactly 65,536 bytes and product code stayed unchanged. Because a fresh exact-SHA run still exceeded the fixed Worker limit, no second optimization is permitted. Kotlin/Ktor remains deferred.

Issue #11 must retain the failed Worker evidence, build the framework-neutral TypeScript service for Cloud Run, and prove its staging artifact before production eligibility. Do not deploy the rejected Worker artifact or introduce Kotlin as a fallback.
