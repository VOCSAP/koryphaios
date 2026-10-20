---
paths:
  - "broker.ts"
  - "cli.ts"
  - "shared/**"
  - "desktop/src/main/roadmap-service.ts"
---

# Broker contracts

- A new `roadmap_items` column goes through every hand-written column list: `ROADMAP_IMPORT_COLUMNS` (`shared/types.ts`), each `INSERT INTO roadmap_items` and `UPDATE roadmap_items SET` in `broker.ts` (upsert create and patch, sync push, `applyPulledRow`), and the `sanitizeRoadmapItem` pick-list.
  Why: only `ROADMAP_IMPORT_COLUMNS` is compared to the live schema (`findUncoveredRoadmapColumns`); every other list drops the field silently.
- Before making a request field required, sweep its callers by the ROUTE STRING across the whole tree, `desktop/src/main` and `tests/` included.
  Why: production callers that the type name does not reach keep sending the old body and get a 400.
- A broker door that stores a `project_key` refuses a non-lowercase key through `projectKeyCaseRefusal` (`shared/project-key.ts`).
  Why: a mixed-case key opens a second roadmap bucket for the same repository.
- A new sentinel is declared in `SENTINEL_DEFINITIONS`, and a refusal test also probes an unlisted sentinel-shaped token such as `"__anything__"`.
  Why: refusal by shape (`isSentinelInstanceToken`) fails closed, while the seed and TTL treatment come from the enumeration and fail open.
- A lock-release UPDATE interpolates `CLEAR_LOCK_SET`; a new lock column is added there and nowhere else.
  Why: one shared fragment keeps every release path clearing the same columns.
- A new `/roadmap/*` route or `handleRoadmap*` handler is classified in `tests/broker-roadmap-route-coverage.test.ts`, and that file belongs in the targeted run.
  Why: it derives routes from `broker.ts` and fails on any unclassified one, while the lot's own tests stay green.
- An FTS trigger on update is `AFTER UPDATE OF <indexed columns>` (as `roadmap_fts_au` with `ROADMAP_FTS_COLUMNS`), and FTS triggers are dropped and recreated at startup.
  Why: an unrestricted update trigger issued an FTS5 delete on a segmentless index ("database disk image is malformed"), and existing databases keep an old trigger definition.
- Read a nullable numeric field from the wire with `typeof v === "number" && Number.isInteger(v)`, never `Number(v)`.
  Why: `Number(null)` is 0, so an absent queue position becomes position 0.
- A `createLogger` added in a `shared/` module passes `mirrorToConsole: false` and writes its console line to stderr.
  Why: `server.ts` imports `shared/` and its stdout is the MCP protocol; the default mirror sends `info` to stdout.
