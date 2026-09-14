# Expose only a minimal unauthenticated health endpoint

LexCerta will serve authenticated stateless MCP requests at `POST /` and an unauthenticated `GET /healthz` that returns only basic process status and a non-sensitive build identifier. Other methods on `/` return `405 Method Not Allowed`. The health check will not contact CourtListener or consume upstream quota. Deployment readiness will be established through a separate authenticated MCP smoke test rather than inferred from `/healthz`.
