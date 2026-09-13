# MVP hosting cost review — September 12, 2026

The user's latest stack questions make low standing cost and compute that sleeps when idle material constraints. The previous Cloud SQL recommendation creates an unnecessary fixed bill for this pilot. Recommend **Cloud Run request-based services, Neon Launch PostgreSQL, and existing immutable GCS source storage** for the next qualification pass. Keep Node 24, the three stateless MCP tools, PostgreSQL authority and the existing evidence semantics.

This recommendation was adopted in the [canonical Wayfinder platform reconciliation](https://github.com/rubixhacker/LexCerta/issues/27#issuecomment-5649573236). The uncommitted runtime now uses direct verified PostgreSQL TLS with environment-specific Neon credentials, exercised against a local PostgreSQL/TLS fixture. Live Neon isolation, suspension, secret rotation and restoration remain **unqualified**. Nothing has been provisioned or purchased. Historical Cloud SQL research and measurements remain evidence of the earlier route.

Cloud Run, Neon Launch, Cloudflare Containers and Vercel rates were rechecked against their official pages on September 13. The estimates below still apply to the stated workload assumptions; no hosted bill or customer usage has been observed.

## Platform comparison

Amounts are USD before tax, without promotional credits. Platform floors are not whole-product quotes.

| Option | Standing cost and scale-to-zero behavior | Product fit |
| --- | --- | --- |
| Current Cloud Run + Cloud SQL | About $51.01/month per SQL instance plus initial SSD; $102.02 for two environments before backups and other services. Request-based Cloud Run with minimum instances zero has no idle compute charge. | Managed PostgreSQL IAM and one provider, but the fixed database allocation is excessive for an unproven, intermittent pilot. |
| Cloud Run + Neon Launch | No minimum fee for either service. Database storage, restore history and scheduled work still cost money. Neon compute suspends after five inactive minutes. | Recommended next qualification target: retains the locally tested container, PostgreSQL transactions, Google operator identity and GCS adapter. Adds a database provider, TLS credentials and network latency. |
| Cloudflare Containers + Neon + R2 | Workers Paid starts at $5/month; containers stop accruing runtime charges when asleep. Add database, object storage and usage beyond the included allowances. | Viable alternative. A failed 128-MiB Worker qualification does not disqualify Containers. Current basic size is 1/4 CPU with 1 GiB; the 1-CPU size has 6 GiB. Neither is the tested 1-CPU/1-GiB envelope. |
| Vercel Pro + serverless PostgreSQL | Starts at $20/month for one developer seat, with $20 of included usage credit; external database charges are additional. Hobby is for personal, noncommercial use. | Can serve the Node MCP API with an appropriate adapter. Its deployment and frontend tooling would be more useful if a web application became central; the current API and operator pilot does not justify choosing it for idle cost. |

Sources checked September 12: [Cloud Run pricing](https://cloud.google.com/run/pricing), [Cloud SQL pricing](https://cloud.google.com/sql/pricing), [Neon plans](https://neon.com/docs/introduction/plans), [Cloudflare Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/), [Vercel pricing](https://vercel.com/pricing). Neon documentation was fetched directly because the browser parser rejected its Markdown content type. Google's large SQL page was fetched and parsed directly. The current Neon plans document takes precedence over older search snippets.

Cloud SQL arithmetic at published Iowa Enterprise rates: `730 × ($0.0413 + 3.75 × $0.007) + 10 × 730 × $0.000232877 = $51.01`. This is one zonal 1-CPU/3.75-GiB instance and 10 GiB SSD. It excludes backups, network and all other services.

## A transparent low-traffic scenario

Budget **$10–20/month for staging and production infrastructure combined** under the following assumptions. This is a planning scenario, not a hosted measurement or a spending cap.

- A 30-day month; ten hypothetical customer organizations making 1,000 MCP calls each, or 10,000 calls total. Ten is a future economic scenario; the invitation limit remains three pilot organizations.
- Each call accounts for two billed 1-CPU/1-GiB Cloud Run instance-seconds, with no assumed concurrency discount. The actual distribution of cache hits, source fan-out, normalization and upstream waiting must be measured.
- Neon remains at 0.25 CU while awake, with no read replicas. Production is awake eight hours on each of 22 working days. Hourly maintenance wakes it for five minutes during the other 544 hours. Staging receives only hourly maintenance. The five minutes approximate the inactivity tail; actual job/query duration adds to it.
- Each database has 1 GB of logical data and an average 1 GB of retained restore history. Seven-day restore history is selected on Launch; the free plan's six-hour history is not a substitute. Source bodies remain in object storage under the existing 256-MiB per-environment cap.
- One hourly maintenance invocation per environment also performs the daily lifecycle sweep when due. Assume each invocation fits within one billed minute at 1 CPU and 512 MiB; Cloud Run Jobs bill at least one minute even if they finish earlier. There are no paid minimum instances, VPC connector, load balancer, replica, paid observability add-on or extra developer seat. Keep image retention and builds bounded. No free-tier allowance is assumed available to LexCerta in the calculation below.

At Neon's current Launch rates of $0.106/CU-hour, $0.35/GB-month data and $0.20/GB-month restore history:

| Component | Scenario arithmetic | Monthly amount |
| --- | --- | ---: |
| Production database | `(176 + 544/12) × 0.25 × 0.106 + 0.35 + 0.20` | $6.42 |
| Staging database | `60 × 0.25 × 0.106 + 0.35 + 0.20` | $2.14 |
| Public Cloud Run requests and runtime | `10,000 × 2 × (0.000024 + 0.0000025) + 10,000 × 0.40/1,000,000` | $0.53 |
| Maintenance jobs, both environments | `2 × 720 × 60 × (0.000018 + 0.5 × 0.000002)` | $1.64 |
| Two Scheduler definitions | About `2 × $0.10` monthly | $0.20 |

These quantified components total approximately **$10.93** before service startup, network, secrets, snapshots beyond the assumed restore history, object operations, registry, logs and builds. The $10–20 planning range allows modest usage of those services; it does not establish their actual bill. Cloud Run free allowances may reduce charges, but they are shared across the billing account. Longer maintenance, retries, larger compute requirements, database wake patterns or frequent builds can exceed this range. Scheduler charges per definition, not per invocation. [Cloud Run job billing](https://cloud.google.com/run/pricing), [Scheduler pricing](https://cloud.google.com/scheduler/pricing).

An otherwise idle environment still runs maintenance: 60 awake database hours at 0.25 CU cost $1.59/month, plus $0.55 for the assumed data/history, approximately **$2.14 per database**. Two such databases, the short jobs and Scheduler total approximately **$6.12/month before the other services above**. A near-idle planning estimate is roughly **$6–10/month combined**, assuming tiny retained data, bounded snapshots/images and little build activity. Storage survives compute suspension, and scheduled work wakes the database. Scale to zero therefore removes idle compute allocation; it does not guarantee a $0 whole-product bill.

## Cost per customer

There is no hosting charge merely for adding a LexCerta user. Shared infrastructure, usage and any upstream agreement determine the cost. One thousand calls at the scenario's two seconds cost about **$0.053 in public Cloud Run runtime and request fees**, before free allowances. At five seconds the same component is $0.133. Those figures exclude the database and other costs; they are not all-in verification prices.

The illustrative $10–20 total divided among ten organizations is **$1–2 per organization per month**. If the same total were shared by only three organizations it would be about $3.33–6.67 each. Usage does not scale linearly with seats: one isolated database query can keep compute awake for five minutes, while many requests in an existing active window share that cost.

For perspective, a 0.25-CU database awake continuously for 720 hours is $19.08 in compute alone. If the workload needs 1 CU continuously, it is $76.32. Autoscaling is not inherently cheaper at every sustained load. Revisit provisioning after measurements justify it.

All figures exclude **CourtListener/FLP hosted or commercial access terms and fees**, which remain unknown, as well as domain registration, payment processing, human support and development. The three-tool implementation does not invoke an LLM, so there is no model-token fee in this service's core path; a client's separate AI subscription is outside this hosting bill.

## Qualification changes before deployment

1. Reconcile the platform decision and issue 35 with this economic constraint before adding infrastructure. Keep cloud purchasing, upstream permission and production approval gates intact.
2. Replace Cloud SQL connection setup only after verifying Neon PostgreSQL 18 compatibility, explicit least-privilege roles, separate environment projects and secret rotation. Use certificate-verified TLS. Do not use an owner connection as the public application's database identity.
3. Preserve short transactions, database time, row locks, fenced publication and conservative ambiguous-commit behavior. Direct versus pooled connectivity must be chosen against the actual driver, session settings and migrations; do not assume transaction pooling preserves session state or role connection ceilings.
4. Measure cold database activation, idle socket closure, cross-provider latency and reconnect behavior within the request deadline. Revisit the one-second acquisition bound explicitly if it conflicts with a safe cold start. Avoid keep-alive database queries that prevent suspension.
5. Retain seven-day recoverability and isolated restoration with retention and revocation reconciliation. Validate Neon's recovery mechanism instead of claiming that a Cloud SQL backup configuration transfers automatically.
6. Repeat affected behavior, role, concurrency, failure, container and hosted qualification checks. Produce measured active compute time, cache behavior, database awake time, network bytes and cost projections before customer-facing unit-cost claims. Continue provider-independent maintenance and evidence work while provider access remains unavailable.
