# Launch baseline

The launch baseline uses Node 24.21.0, pinned in `.nvmrc` and checked against `process.version`. `Dockerfile.check` pins the official Node image by digest and runs the same fixture-only checks in Linux. It is a check image, not a deployable MCP service.

GitHub Actions checks changes targeting `main`: locked installation, actual runtime, formatting, lint, strict types, behavioral tests, emitted-adapter integration, and production dependency audit. These checks spend no live CourtListener quota. Deployed Cloud Run, real PostgreSQL/GCS, real-source coverage and client qualification remain separate gates in the [MVP route](../docs/mvp-route.md).

The September 12 dependency update keeps the compatible Vitest 4 line at 4.1.11. The temporary `sharp` 0.35.4 override patches the retained Miniflare image dependency; remove it when the Worker test adapter is retired or its dependency constraints include the fixed release. It is not used by LexCerta's production evidence core. See the [Vitest advisory](https://github.com/advisories/GHSA-82fw-gwwq-j7x9) and [sharp advisory](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c).

The user explicitly authorized obsolete-code removal on September 12. The unused Next.js/Express tree, legacy SDK transports, old parser/tools, fuzzy matching, singleton caches and disconnected tests were removed before Cloud Run cutover. Active verification contracts and their tests remain. This supersedes the earlier plan to retain those unused source files until production qualification.

`vercel.json` disables future automatic Git deployments using the [documented setting](https://vercel.com/docs/project-configuration/git-configuration#turning-off-all-automatic-deployments). It does not delete existing deployments or detach hostnames. Remote retirement still follows inventory and verified cutover. Old failed Vercel checks remain historical failures; new GitHub checks qualify the maintained code.
