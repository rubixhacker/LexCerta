# Issue tracker

The canonical tracker is GitHub Issues in `rubixhacker/LexCerta`. Use explicit repository arguments with `gh`. The [MVP Wayfinder map](https://github.com/rubixhacker/LexCerta/issues/23) indexes planning decisions; execution issues remain separate.

## Wayfinding operations

- A map is an issue labelled `wayfinder:map`.
- Decision tickets are native sub-issues labelled `wayfinder:research` or `wayfinder:grilling`; other Wayfinder types may be added when needed.
- Claim an open frontier ticket by assigning it to the driving developer before work. The MVP map uses `rubixhacker`.
- Blocking is GitHub's native issue-dependency relation. Use `GET/POST /repos/rubixhacker/LexCerta/issues/{number}/dependencies/blocked_by`; a POST supplies the blocking issue's numeric `issue_id`.
- Read or attach children with `GET/POST /repos/rubixhacker/LexCerta/issues/{map_number}/sub_issues`; a POST supplies `sub_issue_id`, the child issue's numeric database ID.
- The frontier is the map's open, unassigned children whose native blockers are all closed. Query children first, then dependencies; do not infer readiness from body checklists.
- A ticket body holds its question. Record the answer as a resolution comment, close the ticket, and append a title-linked one-line gist to the map's Decisions so far. Keep full decisions in their comments; research files are supporting evidence.
- Re-read map state before changing its index to preserve concurrent work. Use issue titles in human-facing links, not bare ticket numbers.
- Use structured API JSON or `--body-file` for multiline bodies/comments. Do not construct issue prose using shell interpolation.

## Delegated decisions for this effort

On September 12, 2026, the user explicitly requested recommended answers without interviews or per-step confirmations. The MVP map records that exception to the skill's usual interactive and one-ticket-per-session pauses. Resolutions must identify recommendations adopted under that delegation; they must not invent human interview responses or external validation.

The map is complete when the route is decided. Implementation, deployment, external participants, commercial arrangements, and pilot outcomes are separate work and evidence gates. Closing a planning issue does not complete those gates.
