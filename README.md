[![make.fun bounty](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![make.fun rank](https://make.fun/badge/github-core-clone-01/Josesoll/git-forge-core/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![make.fun reward](https://make.fun/badge/github-core-clone-01/Josesoll/git-forge-core/reward.svg)](https://make.fun/bounty/github-core-clone-01)

# git-forge-core

A standalone GitHub-compatible git forge in TypeScript, built on the Node.js standard library
alone: no dependencies, no install step, no git binary, no network access at run time. One
process serves git smart HTTP, the GitHub REST v3 API, the GitHub GraphQL v4 API and a Model
Context Protocol endpoint, all from a single in-memory store, so an object created through one
surface reads back unchanged through the others.

## Run it

```sh
node main.ts
```

On Node 22.6–22.17 use `node --experimental-strip-types main.ts`; Node 22.18 and later strip the
types natively. The process needs two environment variables:

- `MAKEFUN_ENV_URL` — the contest environment's origin. The forge binds an ephemeral port with
  `listen(0)`, POSTs `{"port": N}` to `$MAKEFUN_ENV_URL/register`, long-polls
  `GET $MAKEFUN_ENV_URL/done`, and exits 0 when the answer is `{"done": true}`.
- `MAKEFUN_SHOP_TOKEN` — the bearer token every API surface checks.

## What it implements

**Git smart HTTP** at `/{owner}/{repo}.git`, with the git object model implemented from scratch
in `git.ts` (blobs, trees, commits, annotated tags, packfiles with OFS/REF delta resolution,
zlib via `node:zlib`, SHA-1 via `node:crypto`):

- `GET info/refs?service=git-upload-pack` speaks protocol v2 when the client asks for it
  (`version 2` capability advertisement with `ls-refs` and `fetch`), and falls back to a v0
  advertisement with `side-band-64k` otherwise.
- `POST git-upload-pack` answers v2 `ls-refs` (ref-prefix filtering, symrefs, peeled tags,
  unborn HEAD) and `fetch` (acknowledgments, shallow-info and packfile sections), plus the v0
  want/have negotiation. Shallow fetches honour `deepen`, and incremental fetches send only the
  objects the client's haves do not already cover.
- `POST git-receive-pack` is v0, advertising `report-status`, `side-band-64k` and `delete-refs`.
  Updates are fast-forward only: a non-fast-forward ref is refused with
  `ng <ref> non-fast-forward` while the other refs in the same push still apply. A missing
  repository is a 404 on both services' `info/refs`.

**REST v3** under `/api/v3`. Every reply is `application/json` with a non-empty
`X-GitHub-Request-Id`, errors are JSON with a string `message`, a request without the bearer
token is 401, and a repository under another owner is 404, never 403. It serves the API root
(with `X-OAuth-Scopes`), `/meta`, repository create/list/get/patch/delete with `Link`
pagination, branches, commits, `git/refs`, file contents (create, read, directory listings,
update with stale-sha 409, delete), labels, issues with comments, and pull requests with their
changed files and squash merges (404 for an unknown pull, 405 for a conflicted one).

**GraphQL v4** at `POST /api/graphql` (unauthenticated is exactly 401): viewer and repository
lookups, Relay `node(id:)`, issue and pull-request reads and connections with `orderBy`,
`states` and cursor pagination, the `createIssue`, `closeIssue`, `createPullRequest`,
`mergePullRequest` and `addComment` mutations, batched operations in one body, and the
introspection gh feature-detects (`Issue`, `PullRequest`, `Repository`, `SearchType`, …). An
unknown field answers HTTP 200 with an `errors` array naming it; an unknown repository answers
`data.repository = null` with no errors.

**MCP** at `POST /mcp`: JSON-RPC 2.0 over streamable HTTP, speaking revision 2026-07-28 via
`server/discover` (and the legacy `initialize` handshake). `tools/list` offers `create_repo`,
`get_repo`, `create_issue`, `list_issues`, `get_issue`, `create_pull_request`,
`merge_pull_request` and `list_pull_requests`, byte-for-byte identical across calls, acting on
the same store as REST. Unknown tools answer `-32602`, a missing argument `-32602`, a non-JSON
body HTTP 400 with `-32700`, and a missing Authorization header 401.

## Determinism and performance

A trial replays byte-for-byte, so the forge never reads a wall clock or an unseeded random
source when answering: timestamps and ids derive from a counter seeded by `MAKEFUN_TRIAL_NOW`.
The hot paths stay allocation-light and in memory: object writes are map inserts, issue reads
are single lookups, shallow clones walk one generation, and packfiles are written without
delta compression.

## Layout

- `main.ts` — the entry ↔ env lifecycle (bind, register, wait for done, exit 0).
- `app.ts` — the HTTP server: REST v3, GraphQL v4, MCP and the git smart-HTTP handlers.
- `git.ts` — the git object model and packfile codec the server is built on.

MIT licensed; see `LICENSE`.
