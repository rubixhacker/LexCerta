# Bounded evidence processing

The replacement Node path uses a request-scoped evidence budget and a bounded
worker-thread normalizer. The retained Worker uses the same transport and result
contracts; it remains a reference fixture and cannot be deployed by the blocked
legacy deployment command.

## Limits and failure behavior

- Selected cluster/opinion JSON responses and individual selected source
  representations are limited to 1,048,576 UTF-8 bytes. Citation and quota JSON
  retain their smaller 65,536-byte response limit. The whole JSON envelope counts,
  so its metadata reduces the text bytes available within a response.
- Each evidence request independently caps upstream response bytes and processed
  source bytes at 16 MiB. The latter includes cache hits. These counters measure
  wire envelopes and selected text respectively; neither represents total process
  memory. At most 100 listed opinions are searched sequentially.
- Every upstream attempt has a five-second deadline covering headers and body.
  The shared evidence deadline is 55 seconds, inherited from client cancellation.
  Monotonic checks prevent delayed timer callbacks from accepting overdue results.
- Actual stream chunks enforce the cap even when Content-Length is absent or
  wrong. Fatal UTF-8 decoding rejects corrupt and truncated sequences. JSON strings
  containing unpaired surrogates are rejected as source text.
- Redirects are rejected without following them. The adapter cancels unused
  error bodies, stalled reads, and responses arriving after cancellation. It does
  not wait indefinitely for an untrusted cancellation acknowledgement.
- Cluster requests select `id,absolute_url,sub_opinions`; opinion requests select
  `id,cluster,html_with_citations,html,plain_text`. This uses CourtListener's
  documented [field selection](https://wiki.free.law/c/courtlistener/help/api/rest/v4/query-refinement).
  Current live response behavior remains a staging qualification requirement.

Overflow, a missing required source, a processing failure, or an expired deadline
cannot produce a definitive quote miss. Existing source precedence, exact
normalization, provenance, source-reversal history, and completeness rules remain.
Submitted quote arguments are never stored in normalization jobs or evidence reports; worker jobs
contain only selected public source text. Source text and submitted quotes are
excluded from the response and logs tested by the fixture suite.

## Interruptible normalization

`NodeOpinionNormalizer` runs two workers with at most six queued jobs. Each job's
five-second deadline includes queueing and startup. Client cancellation or the
deadline terminates the actual worker; a stopping worker continues occupying its
slot until exit. A ninth queued/active request fails closed. Normalization workers
receive no application environment or preload flags, and their output streams
are drained without logging their contents.

The parser uses parse5's public fragment parser and tree adapter. Allocation is
limited to 50,000 element, comment, and text nodes, with periodic time checks on
token operations. Appending another token to an existing text node does not count
as another allocation. Iterative traversal avoids recursive JS stack growth on
deep markup and preserves the existing HTML5 normalization semantics.

Worker limits are 64 MiB old-generation heap, 8 MiB young-generation heap, and a
4 MiB stack. Node's limits do not cap every ArrayBuffer or total RSS. Container
memory qualification is therefore separate from the worker heap configuration.
The portable Worker fallback has structural and synchronous time bounds; only
the Node worker pool provides independently interruptible CPU execution.

## Evidence and remaining integration

The Node tests exercise actual HTTP socket closure, response/source byte edges,
invalid UTF-8, aggregate budget exhaustion, cancelled lease polling, finite worker
queueing, actual busy-CPU termination, and large/deep HTML processing. PostgreSQL
qualification separately covers durable admission, source publication, and cache
recovery against real PostgreSQL 18.

`scripts/qualify-evidence-resources.mjs` requires Linux cgroup v2, exactly one CPU,
and 1 GiB memory. It runs four synthetic workloads at eight concurrent quote
checks: large HTML with a last-opinion match, aggregate cached-source overflow,
excessive structure, and deep markup. It reports every outcome, elapsed time,
worker/queue peaks, RSS, cgroup peak, and OOM counters. Its gateways are synthetic;
it does not qualify a public HTTP server, GCS, database latency, or Cloud Run.

The first constrained replay rejected large ordinary HTML because the initial
guard counted token appends as allocations. That failed report is preserved.
The allocation fix passes the unchanged workload. Documents-directory bind mounts
stalled before container creation on the local Docker host; equivalent files in
`/private/tmp` allowed execution. Empty pre-execution outputs are not application
failures or measurement results.

The public Node HTTP runtime still needs to create the evidence scope at request
entry, inject the shared process normalizer, and bind authentication, body reads,
PostgreSQL/GCS operations, disconnects, and shutdown to their bounded lifetimes.
The 55-second evidence scope alone is not proof that those earlier stages obey
the full application deadline. Exact deployed-image concurrency, repeated GCS
failure recovery, privacy, and cold/warm actual-response tests remain in the
Cloud Run staging route.
