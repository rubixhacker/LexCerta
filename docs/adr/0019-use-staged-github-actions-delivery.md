# Use staged GitHub Actions delivery

LexCerta will use GitHub Actions for staged delivery. Pull requests must pass formatting, lint, type checking, unit tests, workerd integration tests, and MCP `2026-07-28` conformance. Merges to the canonical branch deploy an isolated staging environment and run authenticated live smoke and conformance tests. Production requires GitHub environment approval, deploys the exact staging-tested artifact, runs production smoke tests, and automatically rolls back if those tests fail.
