# Private operator service

The Node operator entrypoint implements pilot API-key administration. It is qualified locally; Cloud Run IAM and live Google token forwarding remain staging gates. Run the same built image with `node build/node/operator-main.js`. The public entrypoint never mounts these routes. The planned private service uses one CPU, 512 MiB, concurrency two, minimum zero instances and maximum one, with its own `lexcerta-admin` runtime identity and two-connection database pool. Actual cloud limits and IAM bindings require infrastructure deployment and verification.

## Identity and configuration

The service requires `LEXCERTA_ENVIRONMENT`, `GOOGLE_CLOUD_PROJECT`, `LEXCERTA_BUILD_ID`, `API_KEY_PEPPER`, `LEXCERTA_DATABASE_HOST`, `LEXCERTA_DATABASE_PASSWORD` and optional `PORT`, plus:

- `LEXCERTA_OPERATOR_AUDIENCE`: canonical HTTPS `run.app` origin, without a path or trailing slash.
- `LEXCERTA_OPERATOR_SUBJECTS`: comma-separated immutable Google subject IDs. Email addresses are not identity substitutes.
- `LEXCERTA_PILOT_CUSTOMERS`: one to three comma-separated customer slugs permitted for new issuance.

It requires create/get access to the environment's separate `${GOOGLE_CLOUD_PROJECT}-lexcerta-recovery` GCS bucket for immutable revocation and rotation-expiry records. It receives no opinion-body access or CourtListener token. Staging and production have separate GCP and Neon projects, service accounts, database users and peppers. The database username is fixed to `lexcerta_<environment>_admin`; its password comes from a dedicated Secret Manager version available only to the admin runtime. See the [Neon connection configuration](node-runtime.md). Key mutations check the configured environment inside their locked SQL transaction; a staging operator cannot rotate or revoke a copied production key.

Use a dedicated **operator invoker** service account, distinct from the admin runtime account. Grant approved operators permission to impersonate that account and give it invocation permission on the private service. Allowlist its immutable numeric unique ID. The audit actor represents this verified service account; it does not identify the human who impersonated it. Google IAM audit logs supply that separate impersonation evidence. Do not give the public service invocation or impersonation permission on these identities.

The CLI asks `gcloud auth print-identity-token` for an audience-specific token through service-account impersonation. It captures output internally, without a shell or token command-line argument. Retrieval has a ten-second timeout, a 4 KiB output bound and sanitized failures. The CLI does not read or write a user-managed token file.

Cloud Run may remove the signature from the forwarded platform authentication header. The CLI sends the ID token in `Authorization: Bearer …` for Cloud Run and a full copy in `X-Lexcerta-Operator-Token` for application verification. The application independently checks Google's signature, exact audience, allowed issuer, immutable subject, strict expiry and a maximum one-hour lifetime. It never trusts an actor field, email, forwarded host, or platform header as an application identity. Staging must confirm the full custom header survives real ingress. See [Cloud Run service authentication](https://docs.cloud.google.com/run/docs/authenticating/service-to-service) and [Google's ID-token claims](https://developers.google.com/identity/openid-connect/openid-connect).

Signing certificates come only from Google's fixed HTTPS endpoint. Native HTTP bounds retrieval to two seconds and 64 KiB, without redirects or retries. Concurrent cold requests share retrieval. Public keys are cached inside Google's expiry, capped at one hour; unknown signing keys and failures cause at most one early refresh per minute. A new signing key immediately after a refresh may be rejected for up to a minute. Every request checks token expiry and identity. The pinned Google library verifies signatures; its unbounded certificate transport is not used.

## Commands and recovery

Build with `npm run build:node`. Set `LEXCERTA_OPERATOR_URL` to the canonical operator origin and `LEXCERTA_OPERATOR_INVOKER` to the dedicated invoker service-account email. These values are not secrets.

```text
node build/node/operator-cli.js issue CUSTOMER [MINUTE DAY]
node build/node/operator-cli.js rotate PUBLIC_ID
node build/node/operator-cli.js revoke PUBLIC_ID
node build/node/operator-cli.js limits PUBLIC_ID MINUTE DAY
node build/node/operator-cli.js status PUBLIC_ID
node build/node/operator-cli.js remove-source OPINION_ID
```

The CLI prints the prepared public ID or removal's opinion ID to stderr before dispatch. Successful issuance and rotation print a single JSON result to stdout containing the one-time credential, public ID and expiry. Transfer that credential through the approved secret channel. Do not capture it in ordinary logs, screenshots, tickets, shell arguments or committed files. The server stores only its HMAC. Status returns metadata without a credential or digest. There is no secret-recovery endpoint.

Keys expire after 90 days using database time. Rotation inherits customer, environment and limits and leaves at most seven days of overlap, shortened by the original expiry. Defaults are 10 MCP requests per rolling minute and 100 per rolling day; explicit limits remain bounded to 600 and 10,000. Raising customer limits does not increase the separate global CourtListener budget. Revocation and limit changes share admission locking with the public service and write the verified actor in the same transaction.

Issue and rotation requests contain a caller-generated UUID for the new public key ID. Database uniqueness prevents duplicate issuance for that ID, and a parent can only be rotated once. No plaintext secret is stored for replay. HTTP failures, lost commit acknowledgements and output-write failures are uncertain outcomes; neither CLI nor storage automatically repeats a possibly committed mutation. SQL retries cover only provably aborted serialization/deadlock failures before COMMIT.

If issuance or rotation output is lost, inspect the printed new public ID, then revoke it before issuing a replacement. For a lost rotation response, an external record may already limit the parent even if SQL still reports its old expiry; retire that parent and issue the replacement for the same enrolled customer. Repeating rotation is not recovery. For uncertain revocation, inspect status and finish revoking an active key; an external restriction must never be treated as cancelled because SQL reports active. For an uncertain limit change, inspect status and apply the necessary remaining action. Status reports `absent` only after validating the authenticated application's exact missing-key response. A failed status request does not establish absence; resolve service/identity availability first. Confirmed absence or revocation permits a replacement without recovering a secret. Revoked or missing IDs return a conflict to repeat mutations, without revealing a secret.

Revocation and rotation first validate the existing key in a short SQL transaction, release its locks, then create and verify a content-addressed recovery record. Only then can a second locked transaction change the key and write its SQL audit. The external record contains an environment, public ID and restriction, with an expiry ceiling for rotation. It contains no credential, digest, actor, customer name or opinion text. Rotation's overlap begins at preflight database time, so object-write latency slightly shortens the available seven days. Object operations have a five-second total bound within the request's ten seconds. A failed journal write prevents SQL mutation; a persisted record followed by a SQL failure remains an uncertain outcome and may conservatively restrict the key during future recovery. The same revocation record is reusable after verifying its exact generation and bytes.

See [recovery journal boundaries](recovery-journal.md). The external writer and bounded reader are implemented; the full isolated restore/replay job and reconciliation of changed limits/admission/evidence history remain unfinished. Do not reopen a restored service based on this journal writer alone.

`remove-source OPINION_ID` first verifies an immutable external removal record, then executes the database's one-way removal function. It works for uncached opinions as well as cached ones. Removal disables later source reads and acquisition, clears the publication lease, retains evidence history, queues registered bodies for exact-generation deletion, and records the verified actor in the same SQL transaction. Repeating the command returns the original removal timestamp without changing the first audit actor or resetting an in-flight deletion token. There is no restore-source command.

The result contains `opinionId`, `status: "removed"`, `removedAt` and `pendingDeletionObjects`. This confirms suppression from verification; it does not claim immediate physical erasure. The count covers registered objects at that transaction. A late upload can still require orphan reconciliation. Scheduled maintenance handles physical deletion, and provider removal-response terms remain an external gate. An uncertain response can be reconciled by repeating removal for the same opinion ID. Both the HTTP body and CLI reject source text, operator-selected actor/environment, unsafe IDs and unexpected fields.

The operator receives execute permission on `lexcerta.remove_opinion(bigint,text,text)`, without direct source-table updates or source-bucket access. Public and maintenance roles cannot execute this function, change `removed_at` or delete opinion history. Its fixed search path and qualified table references prevent a caller's schema objects from changing the action. Source-removal audit events retain only an opinion ID, verified actor, environment and timestamps for one calendar year; their tombstones remain after audit retention.

New issuance is restricted to the configured customer list. Changing that list is enrollment administration: preserve the three-organization pilot gate, inventory and revoke all keys for a departing organization before replacing its configured ID. The allowlist size is enforced in configuration; it is not a durable count of all organizations ever issued keys. Rotation and revocation remain available for an existing key after its customer leaves the issuance allowlist.

## Request and operational bounds

The service exposes authenticated `POST /v1/keys`, `POST /v1/keys/:id/rotate`, `POST /v1/keys/:id/revoke`, `PUT /v1/keys/:id/limits`, read-only `GET /v1/keys/:id`, and `POST /v1/sources/:opinionId/remove`, plus process-only `GET /healthz`. JSON mutation bodies are limited to 4 KiB with strict schemas; responses to 16 KiB. Origins, duplicate identity headers, unsupported methods/routes, upgrades and `Expect` are rejected. Two active requests fill the service; a third gets 503 without an application queue. Requests are bounded to ten seconds and cancellation propagates to authentication, journal I/O and SQL. The shared lifecycle drains up to nine seconds, with a ten-second process backstop.

Do not enable HTTP body or authorization-header logging. The process emits only constant startup/fatal events; mutations use the bounded database audit table. Fixtures use synthetic credentials and verify their exclusion from both container output streams. Live IAM denial, Google-issued token forwarding, project isolation, secret references, log retention and restore/revocation reconciliation still require staging evidence before launch.
