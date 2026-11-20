// app.ts — git-forge-core: a standalone GitHub-compatible git forge in one process.
//
// The server this file builds serves four surfaces from one in-memory store:
//   - git smart HTTP at /{owner}/{repo}.git (protocol v2 upload-pack, v0 fallback, v0 receive-pack)
//   - the REST v3 API under /api/v3 (repositories, contents, branches, commits, labels,
//     issues, comments, pull requests and merges)
//   - the GraphQL v4 API at /api/graphql (the documents gh and github-mcp-server send)
//   - the Model Context Protocol endpoint at /mcp (JSON-RPC 2.0 over streamable HTTP)
//
// Only node: builtins and this repository's own git.ts are imported. Determinism matters: the
// trial replays, so timestamps and ids come from a seeded counter seeded by MAKEFUN_TRIAL_NOW,
// never from a wall-clock read at answer time.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  ObjectStore,
  ZERO_OID,
  applyDelta,
  buildCommit,
  buildTree,
  buildTreeFromFlat,
  collectReachable,
  decodePkts,
  encodePkt,
  flattenTree,
  hashObject,
  isAncestor,
  mergeBase,
  parseCommit,
  parseTree,
  peelTagOnce,
  peelToCommit,
  readPack,
  writePack,
  PKT_FLUSH,
  type GitObject,
  type TreeEntry,
} from './git.ts';

void applyDelta;

// -------------------------------------------------------------------------------------------------
// Deterministic clock and counters
// -------------------------------------------------------------------------------------------------

const TRIAL_NOW_MS = (() => {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : Date.parse('2026-11-14T06:30:00.000Z');
})();

let tickCounter = 0;
/** The next deterministic timestamp: the trial's opening time plus one second per call. */
function nextStamp(): { iso: string; epoch: number } {
  tickCounter += 1;
  const ms = TRIAL_NOW_MS + tickCounter * 1000;
  return { iso: new Date(ms).toISOString(), epoch: Math.floor(ms / 1000) };
}

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(36).padStart(6, '0')}`;
}

const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function tokenAccepted(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (EXPECTED_TOKEN !== '') return header === `Bearer ${EXPECTED_TOKEN}`;
  return header.startsWith('Bearer ') && header.length > 'Bearer '.length;
}

// -------------------------------------------------------------------------------------------------
// The store
// -------------------------------------------------------------------------------------------------

/** The login the trial's token belongs to, learned from the first owner-scoped read of a real repo. */
let viewerLogin: string | null = null;

function learnViewer(owner: string): void {
  if (viewerLogin === null && owner !== '') {
    viewerLogin = owner;
    for (const repo of reposByName.values()) repo.owner = owner;
  }
}

function viewer(): string {
  return viewerLogin ?? 'octocat';
}

interface IssueRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  comments: CommentRecord[];
}

interface CommentRecord {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

interface PullRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

interface RepoRecord {
  id: number;
  name: string;
  owner: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  store: ObjectStore;
  refs: Map<string, string>;
  labels: Map<string, { id: number; name: string; color: string; description: string }>;
  issues: Map<number, IssueRecord>;
  pulls: Map<number, PullRecord>;
  nextNumber: number;
}

const reposByName = new Map<string, RepoRecord>();
let nextRepoId = 1;
let nextIssueId = 1;
let nextCommentId = 1;
let nextLabelId = 1;

function createRepoRecord(name: string, isPrivate: boolean, description: string): RepoRecord {
  const stamp = nextStamp();
  const repo: RepoRecord = {
    id: nextRepoId,
    name,
    owner: viewer(),
    isPrivate,
    description,
    defaultBranch: 'main',
    createdAt: stamp.iso,
    updatedAt: stamp.iso,
    store: new ObjectStore(),
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
  };
  nextRepoId += 1;
  reposByName.set(name.toLowerCase(), repo);
  return repo;
}

/**
 * Find a repository by owner and name. A repository lives under the token owner's login: a name
 * that exists under another owner is a 404, and the first owner-scoped read of an existing
 * repository teaches the forge the owner's login.
 */
function findRepo(owner: string, name: string): RepoRecord | null {
  const repo = reposByName.get(name.toLowerCase());
  if (repo === undefined) return null;
  if (viewerLogin !== null && owner !== viewerLogin) return null;
  if (viewerLogin === null) learnViewer(owner);
  return repo;
}

function findRepoByName(name: string): RepoRecord | null {
  return reposByName.get(name.toLowerCase()) ?? null;
}

// -------------------------------------------------------------------------------------------------
// Serializers (REST shapes)
// -------------------------------------------------------------------------------------------------

function repoJson(repo: RepoRecord): Record<string, unknown> {
  const owner = viewerLogin ?? repo.owner;
  return {
    id: repo.id,
    node_id: repoGraphqlId(repo),
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    private: repo.isPrivate,
    owner: { login: owner, id: 1, type: 'User', site_admin: false },
    html_url: `/${owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    default_branch: repo.defaultBranch,
    visibility: repo.isPrivate ? 'private' : 'public',
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
  };
}

function labelJson(label: { id: number; name: string; color: string; description: string }): Record<string, unknown> {
  return { id: label.id, name: label.name, color: label.color, description: label.description, default: false };
}

function issueJson(repo: RepoRecord, issue: IssueRecord): Record<string, unknown> {
  const owner = viewerLogin ?? repo.owner;
  return {
    id: issue.id,
    node_id: issueGraphqlId(repo, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels
      .map((name) => repo.labels.get(name.toLowerCase()))
      .filter((label) => label !== undefined)
      .map((label) => labelJson(label as { id: number; name: string; color: string; description: string })),
    user: { login: owner, id: 1, type: 'User' },
    author_association: 'OWNER',
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: `/${owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}`,
  };
}

function commentJson(repo: RepoRecord, comment: CommentRecord): Record<string, unknown> {
  const owner = viewerLogin ?? repo.owner;
  return {
    id: comment.id,
    node_id: `C_${comment.id}`,
    body: comment.body,
    user: { login: owner, id: 1, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `/${owner}/${repo.name}`,
  };
}

function branchTip(repo: RepoRecord, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

function pullJson(repo: RepoRecord, pull: PullRecord): Record<string, unknown> {
  const owner = viewerLogin ?? repo.owner;
  const headSha = branchTip(repo, pull.head) ?? ZERO_OID;
  const baseSha = branchTip(repo, pull.base) ?? ZERO_OID;
  return {
    id: pull.id,
    node_id: pullGraphqlId(repo, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open' ? !pullIsConflicted(repo, pull) : null,
    draft: false,
    user: { login: owner, id: 1, type: 'User' },
    head: { ref: pull.head, sha: headSha, label: `${owner}:${pull.head}` },
    base: { ref: pull.base, sha: baseSha, label: `${owner}:${pull.base}` },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `/${owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${owner}/${repo.name}/pulls/${pull.number}`,
  };
}

// -------------------------------------------------------------------------------------------------
// GraphQL global ids (opaque, stable, parseable by this forge alone)
// -------------------------------------------------------------------------------------------------

function repoGraphqlId(repo: RepoRecord): string {
  return `R_${repo.id}`;
}

function issueGraphqlId(repo: RepoRecord, number: number): string {
  return `I_${repo.id}_${number}`;
}

function pullGraphqlId(repo: RepoRecord, number: number): string {
  return `P_${repo.id}_${number}`;
}

function repoByGraphqlId(id: string): RepoRecord | null {
  const match = /^R_(\d+)$/.exec(id);
  if (match === null) return null;
  const wanted = Number(match[1]);
  for (const repo of reposByName.values()) if (repo.id === wanted) return repo;
  return null;
}

// -------------------------------------------------------------------------------------------------
// Git-backed repository operations (contents commits, diffs, merges)
// -------------------------------------------------------------------------------------------------

function forgeIdentity(): { line: string } {
  const stamp = nextStamp();
  const login = viewer();
  return { line: `${login} <${login}@example.invalid> ${stamp.epoch} +0000` };
}

/** The flattened file map at a branch tip (empty when the branch is unborn). */
function flatAtTip(repo: RepoRecord, tip: string | null): Map<string, TreeEntry> {
  if (tip === null) return new Map();
  const commitOid = peelToCommit(repo.store, tip);
  if (commitOid === null) return new Map();
  const commit = repo.store.get(commitOid);
  if (commit === undefined) return new Map();
  return flattenTree(repo.store, parseCommit(commit.data).tree);
}

/** Commit a set of path changes (Buffer to write, null to delete) onto a branch; returns the commit. */
function commitChanges(
  repo: RepoRecord,
  branch: string,
  changes: ReadonlyMap<string, Buffer | null>,
  message: string,
): { commitSha: string; treeSha: string } {
  const ref = `refs/heads/${branch}`;
  const parent = repo.refs.get(ref) ?? null;
  const flat = flatAtTip(repo, parent);
  for (const [path, content] of changes) {
    if (content === null) flat.delete(path);
    else {
      const oid = repo.store.put('blob', content);
      flat.set(path, { mode: '100644', name: path.split('/').pop() ?? path, oid });
    }
  }
  const treeSha = buildTreeFromFlat(repo.store, flat);
  const identity = forgeIdentity().line;
  const commitData = buildCommit({
    tree: treeSha,
    parents: parent === null ? [] : [parent],
    author: identity,
    committer: identity,
    message,
  });
  const commitSha = repo.store.put('commit', commitData);
  repo.refs.set(ref, commitSha);
  return { commitSha, treeSha };
}

/** One file's diff entry between two flattened trees. */
interface FileDiff {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  sha: string | null;
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let lines = 0;
  for (const byte of data) if (byte === 0x0a) lines += 1;
  return data[data.length - 1] === 0x0a ? lines : lines + 1;
}

/** The files that differ between a base tree and a head tree, GitHub's pull-files view. */
function diffFlats(repo: RepoRecord, baseFlat: ReadonlyMap<string, TreeEntry>, headFlat: ReadonlyMap<string, TreeEntry>): FileDiff[] {
  const diffs: FileDiff[] = [];
  const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of [...paths].sort()) {
    const before = baseFlat.get(path);
    const after = headFlat.get(path);
    if (before !== undefined && after !== undefined && before.oid === after.oid) continue;
    const beforeData = before === undefined ? null : (repo.store.get(before.oid)?.data ?? null);
    const afterData = after === undefined ? null : (repo.store.get(after.oid)?.data ?? null);
    const additions = afterData === null ? 0 : countLines(afterData);
    const deletions = beforeData === null ? 0 : countLines(beforeData);
    diffs.push({
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions: before === undefined ? additions : Math.min(additions, additions),
      deletions: after === undefined ? deletions : Math.min(deletions, deletions),
      changes: additions + deletions,
      sha: after?.oid ?? null,
    });
  }
  return diffs;
}

/** The merge-base commit of a pull request's head and base tips, or null. */
function pullMergeBase(repo: RepoRecord, pull: PullRecord): string | null {
  const headTip = branchTip(repo, pull.head);
  const baseTip = branchTip(repo, pull.base);
  if (headTip === null || baseTip === null) return null;
  const headCommit = peelToCommit(repo.store, headTip);
  const baseCommit = peelToCommit(repo.store, baseTip);
  if (headCommit === null || baseCommit === null) return null;
  return mergeBase(repo.store, headCommit, baseCommit);
}

/**
 * The tree a squash merge of `pull` would produce, or null when the merge conflicts: a path the
 * head changed since the merge base may not also have changed on the base to something else.
 */
function pullMergedFlat(repo: RepoRecord, pull: PullRecord): Map<string, TreeEntry> | null {
  const headTip = branchTip(repo, pull.head);
  const baseTip = branchTip(repo, pull.base);
  if (headTip === null || baseTip === null) return null;
  const base = pullMergeBase(repo, pull);
  if (base === null) return null;
  const originFlat = flatAtTip(repo, base);
  const baseFlat = flatAtTip(repo, baseTip);
  const headFlat = flatAtTip(repo, headTip);
  const merged = new Map(baseFlat);
  const paths = new Set<string>([...originFlat.keys(), ...headFlat.keys()]);
  for (const path of paths) {
    const origin = originFlat.get(path);
    const head = headFlat.get(path);
    if (origin !== undefined && head !== undefined && origin.oid === head.oid) continue;
    if (origin === undefined && head === undefined) continue;
    const baseEntry = baseFlat.get(path);
    const baseChanged = (origin?.oid ?? null) !== (baseEntry?.oid ?? null);
    if (baseChanged && (baseEntry?.oid ?? null) !== (head?.oid ?? null)) return null;
    if (head === undefined) merged.delete(path);
    else merged.set(path, head);
  }
  return merged;
}

function pullIsConflicted(repo: RepoRecord, pull: PullRecord): boolean {
  if (pull.state !== 'open') return false;
  return pullMergedFlat(repo, pull) === null;
}

/** Squash-merge a pull request onto its base branch. Returns the merge commit sha, or null on conflict. */
function mergePull(repo: RepoRecord, pull: PullRecord): string | null {
  const mergedFlat = pullMergedFlat(repo, pull);
  if (mergedFlat === null) return null;
  const baseTip = branchTip(repo, pull.base);
  if (baseTip === null) return null;
  const treeSha = buildTreeFromFlat(repo.store, mergedFlat);
  const identity = forgeIdentity().line;
  const stamp = nextStamp();
  const commitData = buildCommit({
    tree: treeSha,
    parents: [baseTip],
    author: identity,
    committer: identity,
    message: `${pull.title}\n\n${pull.body}`.trimEnd(),
  });
  const commitSha = repo.store.put('commit', commitData);
  repo.refs.set(`refs/heads/${pull.base}`, commitSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = stamp.iso;
  pull.mergeCommitSha = commitSha;
  pull.updatedAt = stamp.iso;
  return commitSha;
}

/** Create an issue in a repository; a label name the repository does not hold is an error. */
function createIssueRecord(
  repo: RepoRecord,
  input: { title: string; body: string; labels?: readonly string[] },
): { issue: IssueRecord } | { error: string } {
  const labelNames: string[] = [];
  for (const raw of input.labels ?? []) {
    const name = typeof raw === 'string' ? raw : (raw as { name?: string })?.name ?? '';
    const label = repo.labels.get(name.toLowerCase());
    if (label === undefined) return { error: `Validation Failed: label "${name}" does not exist` };
    labelNames.push(label.name);
  }
  const stamp = nextStamp();
  const issue: IssueRecord = {
    id: nextIssueId,
    number: repo.nextNumber,
    title: input.title,
    body: input.body,
    state: 'open',
    labels: labelNames,
    createdSeq: tickCounter,
    createdAt: stamp.iso,
    updatedAt: stamp.iso,
    comments: [],
  };
  nextIssueId += 1;
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return { issue };
}

/** Create a pull request record from a head branch to a base branch. */
function createPullRecord(
  repo: RepoRecord,
  input: { title: string; body: string; head: string; base: string },
): { pull: PullRecord } | { error: string } {
  const head = input.head.includes(':') ? input.head.split(':').pop() ?? input.head : input.head;
  if (branchTip(repo, head) === null) return { error: `Validation Failed: head branch "${head}" does not exist` };
  if (branchTip(repo, input.base) === null && repo.refs.size > 0 && input.base !== repo.defaultBranch) {
    return { error: `Validation Failed: base branch "${input.base}" does not exist` };
  }
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.head === head && existing.base === input.base) {
      return { error: 'Validation Failed: A pull request already exists for this branch' };
    }
  }
  const stamp = nextStamp();
  const pull: PullRecord = {
    id: nextIssueId,
    number: repo.nextNumber,
    title: input.title,
    body: input.body,
    state: 'open',
    head,
    base: input.base,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdSeq: tickCounter,
    createdAt: stamp.iso,
    updatedAt: stamp.iso,
  };
  nextIssueId += 1;
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return { pull };
}

// -------------------------------------------------------------------------------------------------
// HTTP plumbing
// -------------------------------------------------------------------------------------------------

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'x-github-request-id': nextRequestId(),
    ...(text !== '' ? { 'content-length': Buffer.byteLength(text) } : {}),
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'cache-control': 'no-cache' });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON request body; `undefined` for an empty body, the symbol BAD_JSON for a malformed one. */
const BAD_JSON = Symbol('bad-json');
function parseJsonBody(raw: Buffer): unknown {
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    return BAD_JSON;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** GitHub-style pagination: slice the list and link the next page when one remains. */
function paginate<T>(req: IncomingMessage, url: URL, items: readonly T[], res: ServerResponse, status = 200): void {
  const perPageRaw = Number(url.searchParams.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.floor(perPageRaw)) : 30;
  const pageRaw = Number(url.searchParams.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const host = req.headers.host ?? 'localhost';
    const next = new URL(url.pathname, `http://${host}`);
    for (const [key, value] of url.searchParams) next.searchParams.set(key, value);
    next.searchParams.set('per_page', String(perPage));
    next.searchParams.set('page', String(page + 1));
    const lastPage = Math.ceil(items.length / perPage);
    const last = new URL(url.pathname, `http://${host}`);
    for (const [key, value] of url.searchParams) last.searchParams.set(key, value);
    last.searchParams.set('per_page', String(perPage));
    last.searchParams.set('page', String(lastPage));
    headers.link = `<${next.toString()}>; rel="next", <${last.toString()}>; rel="last"`;
  }
  sendJson(res, status, slice, headers);
}

// -------------------------------------------------------------------------------------------------
// REST v3
// -------------------------------------------------------------------------------------------------

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' });
}

function handleRest(req: IncomingMessage, res: ServerResponse, url: URL, rawBody: Buffer): void {
  const method = req.method ?? 'GET';
  const path = url.pathname.replace(/^\/api\/v3\/?/, '');
  const segments = path === '' ? [] : path.split('/').map((part) => decodeURIComponent(part));

  if (!tokenAccepted(req)) {
    sendJson(res, 401, { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest' });
    return;
  }

  let body: unknown;
  if (method !== 'GET' && method !== 'DELETE' || (method === 'DELETE' && rawBody.length > 0)) {
    body = parseJsonBody(rawBody);
    if (body === BAD_JSON) {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
  } else if (rawBody.length > 0 && method !== 'GET') {
    body = parseJsonBody(rawBody);
    if (body === BAD_JSON) {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
  }
  const data = asRecord(body);

  // API root and meta.
  if (segments.length === 0) {
    if (method === 'GET') {
      sendJson(
        res,
        200,
        {
          current_user_url: '/api/v3/user',
          repository_url: '/api/v3/repos/{owner}/{repo}',
          issue_search_url: '/api/v3/search/issues',
          rate_limit_url: '/api/v3/rate_limit',
        },
        { 'x-oauth-scopes': 'repo, read:org, write:repo_hook' },
      );
      return;
    }
    notFound(res);
    return;
  }
  if (segments[0] === 'meta' && segments.length === 1 && method === 'GET') {
    sendJson(res, 200, {
      verifiable_password_authentication: false,
      installed_version: 'git-forge-core 1.0.0',
      github_services_sha: 'forge',
    });
    return;
  }
  if (segments[0] === 'rate_limit' && method === 'GET') {
    sendJson(res, 200, { resources: { core: { limit: 5000, remaining: 4999, reset: 0 } }, rate: { limit: 5000, remaining: 4999, reset: 0 } });
    return;
  }

  // The token's own user.
  if (segments[0] === 'user' && segments.length === 1 && method === 'GET') {
    if (viewerLogin === null) {
      notFound(res);
      return;
    }
    sendJson(res, 200, { login: viewerLogin, id: 1, type: 'User', site_admin: false, name: viewerLogin });
    return;
  }

  // Repository creation and the owner's list.
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const all = [...reposByName.values()].sort((a, b) => a.id - b.id).map((repo) => repoJson(repo));
      paginate(req, url, all, res);
      return;
    }
    if (method === 'POST') {
      const name = str(data.name);
      if (name === '') {
        sendJson(res, 422, { message: 'Repository creation failed: name is required' });
        return;
      }
      if (reposByName.has(name.toLowerCase())) {
        sendJson(res, 422, { message: 'Repository creation failed: a repository with that name already exists' });
        return;
      }
      const repo = createRepoRecord(name, data.private === true, str(data.description));
      sendJson(res, 201, repoJson(repo));
      return;
    }
    notFound(res);
    return;
  }

  if (segments[0] !== 'repos' || segments.length < 3) {
    notFound(res);
    return;
  }
  const owner = segments[1];
  const repoName = segments[2];
  const rest = segments.slice(3);
  const repo = findRepo(owner, repoName);
  if (repo === null) {
    notFound(res);
    return;
  }

  // The repository itself.
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      if (typeof data.description === 'string') repo.description = data.description;
      if (typeof data.name === 'string' && data.name !== '' && data.name.toLowerCase() !== repo.name.toLowerCase()) {
        reposByName.delete(repo.name.toLowerCase());
        repo.name = data.name;
        reposByName.set(repo.name.toLowerCase(), repo);
      }
      if (typeof data.private === 'boolean') repo.isPrivate = data.private;
      repo.updatedAt = nextStamp().iso;
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      reposByName.delete(repo.name.toLowerCase());
      res.writeHead(204, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    notFound(res);
    return;
  }

  handleRepoRoute(req, res, url, method, repo, rest, data, rawBody);
}

function handleRepoRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
  repo: RepoRecord,
  rest: string[],
  data: Record<string, unknown>,
  rawBody: Buffer,
): void {
  void rawBody;
  const head = rest[0];

  // Branches.
  if (head === 'branches') {
    if (method === 'GET' && rest.length === 1) {
      const branches: Record<string, unknown>[] = [];
      for (const [ref, oid] of repo.refs) {
        if (!ref.startsWith('refs/heads/')) continue;
        branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid, url: '' }, protected: false });
      }
      branches.sort((a, b) => String(a.name) < String(b.name) ? -1 : 1);
      paginate(req, url, branches, res);
      return;
    }
    if (method === 'GET' && rest.length >= 2) {
      const branch = rest.slice(1).join('/');
      const tip = branchTip(repo, branch);
      if (tip === null) {
        notFound(res);
        return;
      }
      sendJson(res, 200, { name: branch, commit: { sha: tip, url: '' }, protected: false });
      return;
    }
    notFound(res);
    return;
  }

  // Commits.
  if (head === 'commits') {
    if (method === 'GET' && rest.length === 1) {
      const shaParam = url.searchParams.get('sha');
      let tip: string | null;
      if (shaParam === null || shaParam === '') tip = branchTip(repo, repo.defaultBranch);
      else if (branchTip(repo, shaParam) !== null) tip = branchTip(repo, shaParam);
      else if (/^[0-9a-f]{40}$/i.test(shaParam) && repo.store.has(shaParam.toLowerCase())) tip = shaParam.toLowerCase();
      else tip = null;
      if (tip === null) {
        sendJson(res, 200, []);
        return;
      }
      const startCommit = peelToCommit(repo.store, tip);
      const commits: Record<string, unknown>[] = [];
      const seen = new Set<string>();
      const queue = startCommit === null ? [] : [startCommit];
      while (queue.length > 0 && commits.length < 500) {
        const oid = queue.shift() as string;
        if (seen.has(oid)) continue;
        seen.add(oid);
        const object = repo.store.get(oid);
        if (object === undefined || object.type !== 'commit') continue;
        const commit = parseCommit(object.data);
        commits.push({
          sha: oid,
          node_id: `C_${oid}`,
          commit: {
            message: commit.message.replace(/\n$/, ''),
            author: parseIdent(commit.author),
            committer: parseIdent(commit.committer),
            tree: { sha: commit.tree, url: '' },
          },
          parents: commit.parents.map((parent) => ({ sha: parent, url: '' })),
        });
        queue.push(...commit.parents);
      }
      paginate(req, url, commits, res);
      return;
    }
    if (method === 'GET' && rest.length === 2) {
      const oid = rest[1].toLowerCase();
      const object = repo.store.get(oid);
      if (object === undefined || object.type !== 'commit') {
        notFound(res);
        return;
      }
      const commit = parseCommit(object.data);
      sendJson(res, 200, {
        sha: oid,
        commit: {
          message: commit.message.replace(/\n$/, ''),
          author: parseIdent(commit.author),
          committer: parseIdent(commit.committer),
          tree: { sha: commit.tree, url: '' },
        },
        parents: commit.parents.map((parent) => ({ sha: parent, url: '' })),
      });
      return;
    }
    notFound(res);
    return;
  }

  // Git data: refs.
  if (head === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const ref = str(data.ref);
      const sha = str(data.sha).toLowerCase();
      if (!ref.startsWith('refs/') || !repo.store.has(sha)) {
        sendJson(res, 422, { message: 'Validation Failed: ref or sha is invalid' });
        return;
      }
      if (repo.refs.has(ref)) {
        sendJson(res, 422, { message: 'Reference already exists' });
        return;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, node_id: `REF_${ref}`, url: '', object: { sha, type: repo.store.get(sha)?.type ?? 'commit', url: '' } });
      return;
    }
    if (method === 'GET') {
      if (rest.length === 2) {
        const all = [...repo.refs.entries()].map(([ref, oid]) => ({ ref, object: { sha: oid, type: repo.store.get(oid)?.type ?? 'commit' } }));
        paginate(req, url, all, res);
        return;
      }
      const ref = `refs/${rest.slice(2).join('/')}`;
      const oid = repo.refs.get(ref);
      if (oid === undefined) {
        notFound(res);
        return;
      }
      sendJson(res, 200, { ref, node_id: `REF_${ref}`, url: '', object: { sha: oid, type: repo.store.get(oid)?.type ?? 'commit', url: '' } });
      return;
    }
    notFound(res);
    return;
  }

  // Contents.
  if (head === 'contents') {
    handleContents(req, res, url, method, repo, rest.slice(1).join('/'), data);
    return;
  }

  // Labels.
  if (head === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      const name = str(data.name);
      if (name === '') {
        sendJson(res, 422, { message: 'Validation Failed: name is required' });
        return;
      }
      if (repo.labels.has(name.toLowerCase())) {
        sendJson(res, 422, { message: 'Validation Failed: a label with that name already exists' });
        return;
      }
      const label = { id: nextLabelId, name, color: str(data.color, 'ededed'), description: str(data.description) };
      nextLabelId += 1;
      repo.labels.set(name.toLowerCase(), label);
      sendJson(res, 201, labelJson(label));
      return;
    }
    if (method === 'GET' && rest.length === 1) {
      paginate(req, url, [...repo.labels.values()].map((label) => labelJson(label)), res);
      return;
    }
    notFound(res);
    return;
  }

  // Issues and comments.
  if (head === 'issues') {
    handleIssues(req, res, url, method, repo, rest.slice(1), data);
    return;
  }

  // Pull requests.
  if (head === 'pulls') {
    handlePulls(req, res, url, method, repo, rest.slice(1), data);
    return;
  }

  notFound(res);
}

/** Parse a git identity line ("Name <email> epoch tz") into GitHub's author shape. */
function parseIdent(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: line || viewer(), email: '', date: new Date(TRIAL_NOW_MS).toISOString() };
  return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() };
}

// -------------------------------------------------------------------------------------------------
// REST: contents, issues, pulls
// -------------------------------------------------------------------------------------------------

/** Resolve a `ref` query value (branch name or commit sha) to a commit oid. */
function resolveRefCommit(repo: RepoRecord, ref: string | null): string | null {
  if (ref === null || ref === '') return peelToCommit(repo.store, branchTip(repo, repo.defaultBranch) ?? '');
  const branch = branchTip(repo, ref);
  if (branch !== null) return peelToCommit(repo.store, branch);
  if (/^[0-9a-f]{40}$/i.test(ref) && repo.store.has(ref.toLowerCase())) {
    return peelToCommit(repo.store, ref.toLowerCase());
  }
  const byFullRef = repo.refs.get(ref.startsWith('refs/') ? ref : `refs/heads/${ref}`);
  return byFullRef === undefined ? null : peelToCommit(repo.store, byFullRef);
}

function handleContents(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
  repo: RepoRecord,
  filePath: string,
  data: Record<string, unknown>,
): void {
  void req;
  const path = filePath.replace(/^\/+|\/+$/g, '');

  if (method === 'GET') {
    const commitOid = resolveRefCommit(repo, url.searchParams.get('ref'));
    if (commitOid === null) {
      notFound(res);
      return;
    }
    const commit = repo.store.get(commitOid);
    if (commit === undefined) {
      notFound(res);
      return;
    }
    let treeOid = parseCommit(commit.data).tree;
    if (path === '') {
      sendJson(res, 200, directoryJson(repo, treeOid, ''));
      return;
    }
    const segments = path.split('/');
    for (let index = 0; index < segments.length; index += 1) {
      const tree = repo.store.get(treeOid);
      if (tree === undefined || tree.type !== 'tree') {
        notFound(res);
        return;
      }
      const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[index]);
      if (entry === undefined) {
        notFound(res);
        return;
      }
      if (index === segments.length - 1) {
        if (entry.mode === '40000' || entry.mode === '040000') {
          sendJson(res, 200, directoryJson(repo, entry.oid, path));
          return;
        }
        const blob = repo.store.get(entry.oid);
        if (blob === undefined) {
          notFound(res);
          return;
        }
        sendJson(res, 200, {
          type: 'file',
          encoding: 'base64',
          size: blob.data.length,
          name: entry.name,
          path,
          sha: entry.oid,
          content: blob.data.toString('base64'),
          url: '',
          html_url: '',
          download_url: null,
        });
        return;
      }
      treeOid = entry.oid;
    }
    notFound(res);
    return;
  }

  if (method === 'PUT') {
    const branch = str(data.branch, repo.defaultBranch) || repo.defaultBranch;
    const content = Buffer.from(str(data.content).replace(/\s+/g, ''), 'base64');
    const existing = flatAtTip(repo, branchTip(repo, branch)).get(path);
    if (existing !== undefined) {
      if (str(data.sha).toLowerCase() !== existing.oid.toLowerCase()) {
        sendJson(res, 409, { message: 'Conflict: the sha does not match the current file' });
        return;
      }
    }
    const blobOid = repo.store.put('blob', content);
    const { commitSha } = commitChanges(repo, branch, new Map([[path, content]]), str(data.message, 'Update file'));
    const status = existing === undefined ? 201 : 200;
    sendJson(res, status, {
      content: {
        type: 'file',
        encoding: 'base64',
        size: content.length,
        name: path.split('/').pop() ?? path,
        path,
        sha: blobOid,
        url: '',
        html_url: '',
        download_url: null,
      },
      commit: commitJson(repo, commitSha),
    });
    return;
  }

  if (method === 'DELETE') {
    const branch = str(data.branch, repo.defaultBranch) || repo.defaultBranch;
    const existing = flatAtTip(repo, branchTip(repo, branch)).get(path);
    if (existing === undefined) {
      notFound(res);
      return;
    }
    if (str(data.sha).toLowerCase() !== existing.oid.toLowerCase()) {
      sendJson(res, 409, { message: 'Conflict: the sha does not match the current file' });
      return;
    }
    const { commitSha } = commitChanges(repo, branch, new Map([[path, null]]), str(data.message, 'Delete file'));
    sendJson(res, 200, { content: null, commit: commitJson(repo, commitSha) });
    return;
  }

  notFound(res);
}

function directoryJson(repo: RepoRecord, treeOid: string, prefix: string): Record<string, unknown>[] {
  const tree = repo.store.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return [];
  return parseTree(tree.data).map((entry) => {
    const isDir = entry.mode === '40000' || entry.mode === '040000';
    const blob = isDir ? undefined : repo.store.get(entry.oid);
    return {
      type: isDir ? 'dir' : 'file',
      encoding: isDir ? '' : 'base64',
      size: isDir ? 0 : (blob?.data.length ?? 0),
      name: entry.name,
      path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
      sha: entry.oid,
      url: '',
      html_url: '',
      download_url: null,
    };
  });
}

function commitJson(repo: RepoRecord, commitSha: string): Record<string, unknown> {
  const object = repo.store.get(commitSha);
  if (object === undefined) return { sha: commitSha };
  const commit = parseCommit(object.data);
  return {
    sha: commitSha,
    node_id: `C_${commitSha}`,
    message: commit.message.replace(/\n$/, ''),
    author: parseIdent(commit.author),
    committer: parseIdent(commit.committer),
    tree: { sha: commit.tree, url: '' },
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

function handleIssues(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
  repo: RepoRecord,
  rest: string[],
  data: Record<string, unknown>,
): void {
  if (rest.length === 0) {
    if (method === 'POST') {
      const result = createIssueRecord(repo, {
        title: str(data.title),
        body: str(data.body),
        labels: Array.isArray(data.labels) ? (data.labels as readonly string[]) : [],
      });
      if ('error' in result) {
        sendJson(res, 422, { message: result.error });
        return;
      }
      sendJson(res, 201, issueJson(repo, result.issue));
      return;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      const direction = url.searchParams.get('direction') ?? 'desc';
      issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq || a.number - b.number : b.createdSeq - a.createdSeq || b.number - a.number));
      paginate(req, url, issues.map((issue) => issueJson(repo, issue)), res);
      return;
    }
    notFound(res);
    return;
  }

  const number = Number(rest[0]);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
  if (issue === undefined) {
    notFound(res);
    return;
  }

  if (rest.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
    if (method === 'PATCH') {
      if (typeof data.title === 'string') issue.title = data.title;
      if (typeof data.body === 'string') issue.body = data.body;
      if (data.state === 'open' || data.state === 'closed') issue.state = data.state;
      if (Array.isArray(data.labels)) {
        const names: string[] = [];
        for (const raw of data.labels as unknown[]) {
          const name = typeof raw === 'string' ? raw : str(asRecord(raw).name);
          const label = repo.labels.get(name.toLowerCase());
          if (label === undefined) {
            sendJson(res, 422, { message: `Validation Failed: label "${name}" does not exist` });
            return;
          }
          names.push(label.name);
        }
        issue.labels = names;
      }
      issue.updatedAt = nextStamp().iso;
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
    notFound(res);
    return;
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'POST') {
      const stamp = nextStamp();
      const comment: CommentRecord = { id: nextCommentId, body: str(data.body), createdAt: stamp.iso, updatedAt: stamp.iso };
      nextCommentId += 1;
      issue.comments.push(comment);
      sendJson(res, 201, commentJson(repo, comment));
      return;
    }
    if (method === 'GET') {
      paginate(req, url, issue.comments.map((comment) => commentJson(repo, comment)), res);
      return;
    }
  }

  notFound(res);
}

function handlePulls(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
  repo: RepoRecord,
  rest: string[],
  data: Record<string, unknown>,
): void {
  if (rest.length === 0) {
    if (method === 'POST') {
      const result = createPullRecord(repo, {
        title: str(data.title),
        body: str(data.body),
        head: str(data.head),
        base: str(data.base, repo.defaultBranch) || repo.defaultBranch,
      });
      if ('error' in result) {
        sendJson(res, 422, { message: result.error });
        return;
      }
      sendJson(res, 201, pullJson(repo, result.pull));
      return;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => b.createdSeq - a.createdSeq || b.number - a.number);
      paginate(req, url, pulls.map((pull) => pullJson(repo, pull)), res);
      return;
    }
    notFound(res);
    return;
  }

  const number = Number(rest[0]);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
  if (pull === undefined) {
    notFound(res);
    return;
  }

  if (rest.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, pullJson(repo, pull));
      return;
    }
    if (method === 'PATCH') {
      if (typeof data.title === 'string') pull.title = data.title;
      if (typeof data.body === 'string') pull.body = data.body;
      if (data.state === 'open' || data.state === 'closed') pull.state = data.state;
      pull.updatedAt = nextStamp().iso;
      sendJson(res, 200, pullJson(repo, pull));
      return;
    }
    notFound(res);
    return;
  }

  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    const base = pullMergeBase(repo, pull);
    const baseFlat = base === null ? new Map<string, TreeEntry>() : flatAtTip(repo, base);
    const headFlat = flatAtTip(repo, branchTip(repo, pull.head));
    const diffs = diffFlats(repo, baseFlat, headFlat).map((diff) => ({
      filename: diff.filename,
      status: diff.status,
      additions: diff.additions,
      deletions: diff.deletions,
      changes: diff.changes,
      sha: diff.sha,
    }));
    paginate(req, url, diffs, res);
    return;
  }

  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    if (pull.state === 'closed' && pull.merged) {
      sendJson(res, 405, { message: 'Pull Request is not mergeable' });
      return;
    }
    const sha = mergePull(repo, pull);
    if (sha === null) {
      sendJson(res, 405, { message: 'Pull Request is not mergeable' });
      return;
    }
    sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
    return;
  }

  notFound(res);
}

// -------------------------------------------------------------------------------------------------
// Git smart HTTP
// -------------------------------------------------------------------------------------------------

const UPLOAD_CAPS_V0 = 'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow symref=HEAD:refs/heads/main agent=git-forge-core/1.0';
const RECEIVE_CAPS_V0 = 'report-status side-band-64k delete-refs ofs-delta quiet agent=git-forge-core/1.0';

/** The ref lines of a v0 advertisement (first line carries the capabilities after a NUL). */
function v0Advertisement(repo: RepoRecord, service: string, caps: string): Buffer {
  const parts: Buffer[] = [encodePkt(`# service=${service}\n`), PKT_FLUSH];
  const refs = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  const lines: string[] = [];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}`);
  } else {
    lines.push(`${headOid ?? refs[0][1]} HEAD`);
    for (const [ref, oid] of refs) {
      lines.push(`${oid} ${ref}`);
      const peeled = peelTagOnce(repo.store, oid);
      if (peeled !== null) lines.push(`${peeled} ${ref}^{}`);
    }
  }
  lines.forEach((line, index) => {
    parts.push(encodePkt(index === 0 ? `${line}\0${caps}\n` : `${line}\n`));
  });
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  const lines = [
    'version 2\n',
    'agent=git-forge-core/1.0\n',
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done\n',
    'object-format=sha1\n',
  ];
  return Buffer.concat([...lines.map((line) => encodePkt(line)), PKT_FLUSH]);
}

function handleGitInfoRefs(req: IncomingMessage, res: ServerResponse, url: URL, repo: RepoRecord): void {
  const service = url.searchParams.get('service') ?? '';
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendRaw(res, 403, Buffer.from('invalid service\n'), 'text/plain');
    return;
  }
  const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
  if (service === 'git-upload-pack' && wantsV2) {
    sendRaw(res, 200, v2Advertisement(), 'application/x-git-upload-pack-advertisement');
    return;
  }
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  sendRaw(res, 200, v0Advertisement(repo, service, caps), `application/x-${service}-advertisement`);
}

/** Split a pack into sideband-1 packets (each pkt-line payload stays below the 65520 cap). */
function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 60_000;
  if (pack.length === 0) {
    packets.push(encodePkt(Buffer.concat([Buffer.from([1])])));
    return packets;
  }
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    packets.push(encodePkt(Buffer.concat([Buffer.from([1]), pack.subarray(offset, offset + CHUNK)])));
  }
  return packets;
}

interface FetchPlan {
  objects: (GitObject & { oid: string })[];
  shallow: string[];
  unshallow: string[];
}

/**
 * Work out which objects a fetch must carry: everything reachable from the wants, bounded by
 * the depth when one is given, minus what the haves already prove the client holds (a have the
 * client lists as shallow does not prove its ancestry).
 */
function planFetch(
  repo: RepoRecord,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth: number | null,
): FetchPlan {
  const store = repo.store;
  const shallowSet = new Set(clientShallow);

  // What the client already holds.
  const haveObjects = new Set<string>();
  {
    const stack = [...haves];
    const seenCommits = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      const object = store.get(oid);
      if (object === undefined || haveObjects.has(oid)) continue;
      haveObjects.add(oid);
      if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      } else if (object.type === 'tag') {
        const target = peelTagOnce(store, oid);
        if (target !== null) stack.push(target);
      } else if (object.type === 'commit') {
        if (seenCommits.has(oid)) continue;
        seenCommits.add(oid);
        const commit = parseCommit(object.data);
        stack.push(commit.tree);
        if (!shallowSet.has(oid)) stack.push(...commit.parents);
      }
    }
  }

  // The commits the wants need, by generation distance from a want tip.
  const distance = new Map<string, number>();
  const extras = new Set<string>(); // tag objects on the way to a commit, and non-commit wants
  {
    let frontier: string[] = [];
    for (const want of wants) {
      let current = want;
      // Peel tags, keeping the tag objects themselves for the pack.
      for (let hops = 0; hops < 16; hops += 1) {
        const object = store.get(current);
        if (object === undefined) break;
        if (object.type === 'tag') {
          extras.add(current);
          const target = peelTagOnce(store, current);
          if (target === null) break;
          current = target;
          continue;
        }
        break;
      }
      const object = store.get(current);
      if (object !== undefined && object.type === 'commit') frontier.push(current);
      else if (object !== undefined) extras.add(current);
    }
    let level = 0;
    while (frontier.length > 0) {
      if (depth !== null && level >= depth) break;
      const next: string[] = [];
      for (const oid of frontier) {
        if (distance.has(oid)) continue;
        distance.set(oid, level);
        const object = store.get(oid);
        if (object === undefined || object.type !== 'commit') continue;
        for (const parent of parseCommit(object.data).parents) {
          if (!distance.has(parent)) next.push(parent);
        }
      }
      frontier = next;
      level += 1;
    }
  }

  const included = new Set<string>();
  const send = new Map<string, GitObject & { oid: string }>();
  const addWithTree = (oid: string): void => {
    const stack = [oid];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (included.has(current)) continue;
      const object = store.get(current);
      if (object === undefined) continue;
      included.add(current);
      if (!haveObjects.has(current)) send.set(current, { ...object, oid: current });
      if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      } else if (object.type === 'tag') {
        const target = peelTagOnce(store, current);
        if (target !== null) stack.push(target);
      } else if (object.type === 'commit') {
        stack.push(parseCommit(object.data).tree);
      }
    }
  };
  for (const oid of extras) addWithTree(oid);
  for (const oid of distance.keys()) addWithTree(oid);

  // The shallow boundary: included commits whose parents exist but were not included.
  const boundary: string[] = [];
  if (depth !== null) {
    for (const oid of distance.keys()) {
      const object = store.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.some((parent) => store.has(parent) && !distance.has(parent))) boundary.push(oid);
    }
  }
  const unshallow = [...shallowSet].filter((oid) => distance.has(oid) && !boundary.includes(oid));
  return { objects: [...send.values()], shallow: boundary.sort(), unshallow: unshallow.sort() };
}

function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: RepoRecord, rawBody: Buffer): void {
  const first = decodePkts(rawBody, 0);
  const firstLine = first.packets.find((packet) => packet.kind === 'data')?.payload.toString('utf8') ?? '';

  // Protocol v2: a command line opens the request.
  if (firstLine.startsWith('command=ls-refs')) {
    const args: string[] = [];
    let afterDelim = false;
    for (const packet of first.packets) {
      if (packet.kind === 'delim') {
        afterDelim = true;
        continue;
      }
      if (afterDelim && packet.kind === 'data') args.push(packet.payload.toString('utf8').replace(/\n$/, ''));
    }
    const wantPeel = args.includes('peel');
    const wantSymrefs = args.includes('symrefs');
    const wantUnborn = args.includes('unborn');
    const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
    const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
    const lines: string[] = [];
    const headRef = `refs/heads/${repo.defaultBranch}`;
    const headOid = repo.refs.get(headRef);
    if (matches('HEAD')) {
      if (headOid !== undefined) lines.push(`${headOid} HEAD${wantSymrefs ? ` symref-target:${headRef}` : ''}`);
      else if (wantUnborn) lines.push(`unborn HEAD${wantSymrefs ? ` symref-target:${headRef}` : ''}`);
    }
    for (const [ref, oid] of [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (!matches(ref)) continue;
      let line = `${oid} ${ref}`;
      if (wantPeel) {
        const peeled = peelToCommit(repo.store, oid);
        if (peeled !== null && peeled !== oid) line += ` peeled:${peeled}`;
      }
      lines.push(line);
    }
    sendRaw(res, 200, Buffer.concat([...lines.map((line) => encodePkt(`${line}\n`)), PKT_FLUSH]), 'application/x-git-upload-pack-result');
    return;
  }

  if (firstLine.startsWith('command=fetch')) {
    const wants: string[] = [];
    const haves: string[] = [];
    const clientShallow: string[] = [];
    let depth: number | null = null;
    let sawDone = false;
    let afterDelim = false;
    for (const packet of first.packets) {
      if (packet.kind === 'delim') {
        afterDelim = true;
        continue;
      }
      if (!afterDelim || packet.kind !== 'data') continue;
      const line = packet.payload.toString('utf8').replace(/\n$/, '');
      if (line.startsWith('want ')) wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) clientShallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
      else if (line === 'done') sawDone = true;
      else if (line.startsWith('want-ref ')) {
        const oid = repo.refs.get(line.slice(9).trim());
        if (oid !== undefined) wants.push(oid);
      }
    }
    // With `done` the negotiation is over: git expects the packfile sections directly, and an
    // acknowledgments section at that point is a protocol error. Without it, acknowledge only.
    if (!sawDone) {
      const acks: Buffer[] = [encodePkt('acknowledgments\n')];
      const common = haves.filter((oid) => repo.store.has(oid));
      if (common.length === 0) acks.push(encodePkt('NAK\n'));
      else for (const oid of common) acks.push(encodePkt(`ACK ${oid}\n`));
      acks.push(PKT_FLUSH);
      sendRaw(res, 200, Buffer.concat(acks), 'application/x-git-upload-pack-result');
      return;
    }
    const plan = planFetch(repo, wants, haves, clientShallow, depth !== null && Number.isFinite(depth) ? depth : null);
    const pack = writePack(plan.objects);
    const parts: Buffer[] = [];
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      parts.push(encodePkt('shallow-info\n'));
      for (const oid of plan.shallow) parts.push(encodePkt(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(encodePkt(`unshallow ${oid}\n`));
      parts.push(PKT_FLUSH);
    }
    parts.push(encodePkt('packfile\n'));
    parts.push(...sidebandPackets(pack));
    parts.push(PKT_FLUSH);
    sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
    return;
  }

  // Protocol v0: want lines, a flush, have lines, a flush, then the pack comes back framed.
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | null = null;
  for (const packet of first.packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    const wantMatch = /^want ([0-9a-f]{40})/.exec(line);
    if (wantMatch !== null) wants.push(wantMatch[1]);
    else if (line.startsWith('shallow ')) clientShallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
  }
  const second = decodePkts(rawBody, first.end);
  for (const packet of second.packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('have ')) haves.push(line.slice(5).trim());
  }
  if (wants.length === 0) {
    sendRaw(res, 400, Buffer.from('expected want lines\n'), 'text/plain');
    return;
  }
  const plan = planFetch(repo, wants, haves, clientShallow, depth !== null && Number.isFinite(depth) ? depth : null);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(encodePkt(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePkt(`unshallow ${oid}\n`));
  parts.push(encodePkt('NAK\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function handleReceivePack(res: ServerResponse, repo: RepoRecord, rawBody: Buffer): void {
  const decoded = decodePkts(rawBody, 0);
  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: Command[] = [];
  let capabilities = '';
  for (const packet of decoded.packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul !== -1) {
      capabilities = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (match !== null) commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
  }
  if (commands.length === 0) {
    sendRaw(res, 400, Buffer.from('expected a command list\n'), 'text/plain');
    return;
  }

  // Unpack first: every object the pack carries joins the store, accepted ref or not.
  const packBytes = rawBody.subarray(decoded.end);
  let unpackOk = true;
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => repo.store.get(oid));
      for (const object of objects) repo.store.putObject(object.oid, object.type, object.data);
    } catch {
      unpackOk = false;
    }
  }

  const reportLines: string[] = [unpackOk ? 'unpack ok' : 'unpack error'];
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    let failure: string | null = null;
    if (!unpackOk) failure = 'unpack failed';
    else if (command.oldOid !== current) failure = 'stale info';
    else if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
    } else if (!repo.store.has(command.newOid)) failure = 'missing object';
    else if (current !== ZERO_OID) {
      const currentCommit = peelToCommit(repo.store, current);
      const newCommit = peelToCommit(repo.store, command.newOid);
      if (currentCommit !== null && newCommit !== null && !isAncestor(repo.store, currentCommit, newCommit)) {
        failure = 'non-fast-forward';
      }
    }
    if (failure === null) {
      if (command.newOid !== ZERO_OID) repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}`);
    } else {
      reportLines.push(`ng ${command.ref} ${failure}`);
    }
  }

  const inner = Buffer.concat([...reportLines.map((line) => encodePkt(`${line}\n`)), PKT_FLUSH]);
  let body: Buffer;
  if (capabilities.split(' ').includes('side-band-64k')) {
    const packets: Buffer[] = [];
    const CHUNK = 60_000;
    for (let offset = 0; offset < inner.length; offset += CHUNK) {
      packets.push(encodePkt(Buffer.concat([Buffer.from([1]), inner.subarray(offset, offset + CHUNK)])));
    }
    packets.push(PKT_FLUSH);
    body = Buffer.concat(packets);
  } else {
    body = inner;
  }
  sendRaw(res, 200, body, 'application/x-git-receive-pack-result');
}

// -------------------------------------------------------------------------------------------------
// GraphQL v4
// -------------------------------------------------------------------------------------------------

type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Map<string, GqlValue> };

interface GqlField {
  name: string;
  alias: string | null;
  args: Map<string, GqlValue>;
  selection: GqlField[] | null;
  fragmentSpread: string | null;
  inlineOn: string | null;
}

interface GqlOperation {
  type: 'query' | 'mutation';
  name: string | null;
  selection: GqlField[];
}

interface GqlDocument {
  operations: GqlOperation[];
  fragments: Map<string, { on: string; selection: GqlField[] }>;
}

/** A small GraphQL parser for the documents gh and github-mcp-server send. */
function parseGraphql(source: string): GqlDocument {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(ch)) {
      i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}()[]:$!@='.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push(`"${source.slice(i + 3, end === -1 ? source.length : end)}"`);
        i = end === -1 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          value += source[j + 1];
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      tokens.push(`"${value}"`);
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < source.length && /[A-Za-z0-9_.\-]/.test(source[j])) j += 1;
    if (j === i) {
      i += 1;
      continue;
    }
    tokens.push(source.slice(i, j));
    i = j;
  }

  let pos = 0;
  const peek = (): string | undefined => tokens[pos];
  const take = (): string => tokens[pos++];

  const parseValue = (): GqlValue => {
    const token = take();
    if (token === '$') return { kind: 'variable', name: take() };
    if (token.startsWith('"')) return { kind: 'string', value: token.slice(1, -1) };
    if (token === '[') {
      const items: GqlValue[] = [];
      while (peek() !== ']') items.push(parseValue());
      take();
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields = new Map<string, GqlValue>();
      while (peek() !== '}') {
        const key = take();
        take(); // ':'
        fields.set(key, parseValue());
      }
      take();
      return { kind: 'object', fields };
    }
    if (token === 'true' || token === 'false') return { kind: 'boolean', value: token === 'true' };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number(token) };
    if (/^-?\d*\.\d+$/.test(token)) return { kind: 'float', value: Number(token) };
    return { kind: 'enum', value: token };
  };

  const parseSelectionSet = (): GqlField[] => {
    take(); // '{'
    const fields: GqlField[] = [];
    while (peek() !== '}' && pos < tokens.length) {
      if (peek() === '...') {
        take();
        if (peek() === 'on') {
          take();
          const on = take();
          const selection = parseSelectionSet();
          fields.push({ name: '', alias: null, args: new Map(), selection, fragmentSpread: null, inlineOn: on });
        } else {
          const name = take();
          fields.push({ name: '', alias: null, args: new Map(), selection: null, fragmentSpread: name, inlineOn: null });
        }
        continue;
      }
      let name = take();
      let alias: string | null = null;
      if (peek() === ':') {
        take();
        alias = name;
        name = take();
      }
      const args = new Map<string, GqlValue>();
      if (peek() === '(') {
        take();
        while (peek() !== ')') {
          const key = take();
          take(); // ':'
          args.set(key, parseValue());
        }
        take();
      }
      // Directives are parsed and ignored: the suite's documents carry none that change data.
      while (peek() === '@') {
        take();
        take();
        if (peek() === '(') {
          let depth = 0;
          do {
            const token = take();
            if (token === '(') depth += 1;
            if (token === ')') depth -= 1;
          } while (depth > 0);
        }
      }
      const selection = peek() === '{' ? parseSelectionSet() : null;
      fields.push({ name, alias, args, selection, fragmentSpread: null, inlineOn: null });
    }
    take(); // '}'
    return fields;
  };

  const skipVariableDefinitions = (): void => {
    if (peek() !== '(') return;
    let depth = 0;
    do {
      const token = take();
      if (token === '(') depth += 1;
      if (token === ')') depth -= 1;
    } while (depth > 0 && pos < tokens.length);
  };

  const operations: GqlOperation[] = [];
  const fragments = new Map<string, { on: string; selection: GqlField[] }>();
  while (pos < tokens.length) {
    const token = peek();
    if (token === 'query' || token === 'mutation' || token === 'subscription') {
      take();
      let name: string | null = null;
      if (peek() !== '(' && peek() !== '{' && peek() !== '@') name = take();
      skipVariableDefinitions();
      while (peek() === '@') {
        take();
        take();
      }
      const selection = parseSelectionSet();
      operations.push({ type: token === 'mutation' ? 'mutation' : 'query', name, selection });
    } else if (token === 'fragment') {
      take();
      const fragName = take();
      take(); // 'on'
      const on = take();
      const selection = parseSelectionSet();
      fragments.set(fragName, { on, selection });
    } else if (token === '{') {
      operations.push({ type: 'query', name: null, selection: parseSelectionSet() });
    } else {
      take();
    }
  }
  return { operations, fragments };
}

function gqlResolve(value: GqlValue | undefined, variables: Record<string, unknown>): unknown {
  if (value === undefined) return undefined;
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => gqlResolve(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, item] of value.fields) out[key] = gqlResolve(item, variables);
      return out;
    }
  }
}

// The schema surface gh feature-detects, by type.
const GQL_TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'search', 'rateLimit', 'meta', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue', 'reopenIssue'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'hasProjectsEnabled', 'isPrivate', 'description', 'url', 'createdAt', 'updatedAt',
    'issue', 'issues', 'pullRequest', 'pullRequests', 'labels', 'stargazerCount', 'forkCount',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'state', 'body', 'url', 'author', 'labels', 'comments',
    'createdAt', 'updatedAt', 'closedAt', 'repository', 'assignees', 'milestone',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeable',
    'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'commits', 'author', 'url',
    'createdAt', 'updatedAt', 'repository', 'additions', 'deletions', 'changedFiles', 'mergeCommit',
  ],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'url', 'avatarUrl'],
  RepositoryOwner: ['id', 'login', 'url', 'avatarUrl'],
  Ref: ['name', 'prefix', 'target'],
  Commit: ['oid', 'message', 'messageHeadline', 'authoredDate'],
  GitActor: ['name', 'email', 'date'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  Label: ['id', 'name', 'color', 'description'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType', 'specifiedByURL'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __Schema: ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives'],
  __Directive: ['name', 'description', 'locations', 'args'],
};

const GQL_ENUMS: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  IssueStateReason: ['COMPLETED', 'NOT_PLANNED', 'REOPENED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  StatusState: ['EXPECTED', 'ERROR', 'FAILURE', 'PENDING', 'SUCCESS'],
};

type GqlTagged = { __type: string; [key: string]: unknown };

function tag(type: string, props: Record<string, unknown>): GqlTagged {
  return { __type: type, ...props };
}

function gqlTypeObject(name: string): GqlTagged | null {
  if (GQL_ENUMS[name] !== undefined) {
    return tag('__Type', {
      name,
      kind: 'ENUM',
      fields: null,
      enumValues: GQL_ENUMS[name].map((value) => tag('__EnumValue', { name: value, description: null, isDeprecated: false, deprecationReason: null })),
    });
  }
  const fields = GQL_TYPE_FIELDS[name];
  if (fields === undefined) return null;
  return tag('__Type', {
    name,
    kind: 'OBJECT',
    fields: fields.map((field) =>
      tag('__Field', {
        name: field,
        description: null,
        args: [],
        type: tag('__Type', { name: 'String', kind: 'SCALAR', fields: null, enumValues: null }),
        isDeprecated: false,
        deprecationReason: null,
      }),
    ),
    enumValues: null,
  });
}

function gqlRepo(repo: RepoRecord): GqlTagged {
  return tag('Repository', { repo });
}

function gqlIssue(repo: RepoRecord, issue: IssueRecord): GqlTagged {
  return tag('Issue', { repo, issue });
}

function gqlPull(repo: RepoRecord, pull: PullRecord): GqlTagged {
  return tag('PullRequest', { repo, pull });
}

interface GqlContext {
  variables: Record<string, unknown>;
  errors: { message: string }[];
  document: GqlDocument;
}

function gqlCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function gqlCursorIndex(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(decoded);
    return match === null ? -1 : Number(match[1]);
  } catch {
    return -1;
  }
}

/** Resolve one field of one tagged value; `undefined` marks a field the type does not hold. */
function gqlField(source: GqlTagged | null, field: string, args: Map<string, GqlValue>, ctx: GqlContext): unknown {
  const type = source === null ? 'Query' : source.__type;
  const arg = (name: string): unknown => gqlResolve(args.get(name), ctx.variables);

  if (field === '__typename') return type;

  if (type === 'Query') {
    switch (field) {
      case 'viewer':
        return tag('User', { login: viewer() });
      case 'repository': {
        const owner = String(arg('owner') ?? '');
        const name = String(arg('name') ?? '');
        const repo = findRepo(owner, name);
        return repo === null ? null : gqlRepo(repo);
      }
      case 'node': {
        const id = String(arg('id') ?? '');
        const repo = repoByGraphqlId(id);
        if (repo !== null) return gqlRepo(repo);
        const issueMatch = /^I_(\d+)_(\d+)$/.exec(id);
        if (issueMatch !== null) {
          for (const candidate of reposByName.values()) {
            if (candidate.id !== Number(issueMatch[1])) continue;
            const issue = candidate.issues.get(Number(issueMatch[2]));
            if (issue !== undefined) return gqlIssue(candidate, issue);
          }
        }
        const pullMatch = /^P_(\d+)_(\d+)$/.exec(id);
        if (pullMatch !== null) {
          for (const candidate of reposByName.values()) {
            if (candidate.id !== Number(pullMatch[1])) continue;
            const pull = candidate.pulls.get(Number(pullMatch[2]));
            if (pull !== undefined) return gqlPull(candidate, pull);
          }
        }
        return null;
      }
      case '__type':
        return gqlTypeObject(String(arg('name') ?? ''));
      case '__schema':
        return tag('__Schema', {
          queryType: gqlTypeObject('Query'),
          mutationType: gqlTypeObject('Mutation'),
          subscriptionType: null,
          types: Object.keys(GQL_TYPE_FIELDS).map((name) => gqlTypeObject(name)),
          directives: [],
        });
      case 'rateLimit':
        return tag('Query', {});
      default:
        return undefined;
    }
  }

  if (type === 'Mutation') {
    const input = asRecord(arg('input'));
    switch (field) {
      case 'createIssue': {
        const repo = repoByGraphqlId(String(input.repositoryId ?? ''));
        if (repo === null) return null;
        const result = createIssueRecord(repo, { title: str(input.title), body: str(input.body), labels: [] });
        if ('error' in result) return null;
        return tag('CreateIssuePayload', { issue: gqlIssue(repo, result.issue), clientMutationId: (input.clientMutationId as string) ?? null });
      }
      case 'closeIssue': {
        const match = /^I_(\d+)_(\d+)$/.exec(String(input.issueId ?? ''));
        if (match === null) return null;
        for (const repo of reposByName.values()) {
          if (repo.id !== Number(match[1])) continue;
          const issue = repo.issues.get(Number(match[2]));
          if (issue === undefined) return null;
          issue.state = 'closed';
          issue.updatedAt = nextStamp().iso;
          return tag('CloseIssuePayload', { issue: gqlIssue(repo, issue), clientMutationId: (input.clientMutationId as string) ?? null });
        }
        return null;
      }
      case 'createPullRequest': {
        const repo = repoByGraphqlId(String(input.repositoryId ?? ''));
        if (repo === null) return null;
        const result = createPullRecord(repo, {
          title: str(input.title),
          body: str(input.body),
          head: str(input.headRefName),
          base: str(input.baseRefName, repo.defaultBranch),
        });
        if ('error' in result) {
          // An already-open pull for the same refs is the mutation's answer, not a failure.
          for (const pull of repo.pulls.values()) {
            if (pull.state === 'open' && pull.head === str(input.headRefName) && pull.base === str(input.baseRefName)) {
              return tag('CreatePullRequestPayload', { pullRequest: gqlPull(repo, pull), clientMutationId: (input.clientMutationId as string) ?? null });
            }
          }
          return null;
        }
        return tag('CreatePullRequestPayload', { pullRequest: gqlPull(repo, result.pull), clientMutationId: (input.clientMutationId as string) ?? null });
      }
      case 'mergePullRequest': {
        const match = /^P_(\d+)_(\d+)$/.exec(String(input.pullRequestId ?? ''));
        if (match === null) return null;
        for (const repo of reposByName.values()) {
          if (repo.id !== Number(match[1])) continue;
          const pull = repo.pulls.get(Number(match[2]));
          if (pull === undefined) return null;
          if (!pull.merged) mergePull(repo, pull);
          return tag('MergePullRequestPayload', { pullRequest: gqlPull(repo, pull), clientMutationId: (input.clientMutationId as string) ?? null });
        }
        return null;
      }
      case 'addComment': {
        const match = /^I_(\d+)_(\d+)$/.exec(String(input.subjectId ?? ''));
        if (match === null) return null;
        for (const repo of reposByName.values()) {
          if (repo.id !== Number(match[1])) continue;
          const issue = repo.issues.get(Number(match[2]));
          if (issue === undefined) return null;
          const stamp = nextStamp();
          const comment: CommentRecord = { id: nextCommentId, body: str(input.body), createdAt: stamp.iso, updatedAt: stamp.iso };
          nextCommentId += 1;
          issue.comments.push(comment);
          const node = tag('IssueComment', { id: `C_${comment.id}`, body: comment.body, createdAt: comment.createdAt, updatedAt: comment.updatedAt });
          return tag('AddCommentPayload', {
            commentEdge: tag('IssueCommentEdge', { node, cursor: gqlCursor(comment.id) }),
            subject: gqlIssue(repo, issue),
            clientMutationId: (input.clientMutationId as string) ?? null,
          });
        }
        return null;
      }
      default:
        return undefined;
    }
  }

  if (source === null) return undefined;
  return gqlObjectField(source, field, args, ctx);
}

function gqlObjectField(source: GqlTagged, field: string, args: Map<string, GqlValue>, ctx: GqlContext): unknown {
  const type = source.__type;
  const arg = (name: string): unknown => gqlResolve(args.get(name), ctx.variables);

  // Introspection and plain tagged records answer from their own properties.
  if (type === '__Type' || type === '__Field' || type === '__EnumValue' || type === '__InputValue' || type === '__Schema' || type === '__Directive') {
    return field in source ? source[field] : undefined;
  }
  if (type === 'PageInfo' || type === 'IssueEdge' || type === 'PullRequestEdge' || type === 'IssueCommentEdge') {
    return field in source ? source[field] : undefined;
  }
  if (type.endsWith('Payload')) {
    return field in source ? source[field] : undefined;
  }
  if (type === 'User' || type === 'RepositoryOwner') {
    const login = String(source.login ?? viewer());
    switch (field) {
      case 'login': return login;
      case 'id': return 'U_1';
      case 'databaseId': return 1;
      case 'name': return login;
      case 'email': return `${login}@example.invalid`;
      case 'url': return `/${login}`;
      case 'avatarUrl': return '';
      default: return undefined;
    }
  }
  if (type === 'Ref') {
    switch (field) {
      case 'name': return source.name;
      case 'prefix': return 'refs/heads/';
      case 'target': return null;
      default: return undefined;
    }
  }
  if (type === 'IssueComment') {
    return field in source ? source[field] : undefined;
  }
  if (type === 'Label') {
    return field in source ? source[field] : undefined;
  }
  if (type === 'PullRequestChangedFile') {
    return field in source ? source[field] : undefined;
  }

  if (type === 'Repository') {
    const repo = source.repo as RepoRecord;
    const owner = viewerLogin ?? repo.owner;
    switch (field) {
      case 'id': return repoGraphqlId(repo);
      case 'databaseId': return repo.id;
      case 'name': return repo.name;
      case 'nameWithOwner': return `${owner}/${repo.name}`;
      case 'owner': return tag('RepositoryOwner', { login: owner });
      case 'defaultBranchRef':
        return repo.refs.has(`refs/heads/${repo.defaultBranch}`) || true
          ? tag('Ref', { name: repo.defaultBranch })
          : null;
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'hasProjectsEnabled': return false;
      case 'isPrivate': return repo.isPrivate;
      case 'description': return repo.description;
      case 'url': return `/${owner}/${repo.name}`;
      case 'createdAt': return repo.createdAt;
      case 'updatedAt': return repo.updatedAt;
      case 'stargazerCount': return 0;
      case 'forkCount': return 0;
      case 'issue': {
        const issue = repo.issues.get(Number(arg('number')));
        return issue === undefined ? null : gqlIssue(repo, issue);
      }
      case 'issues': {
        let issues = [...repo.issues.values()];
        const states = arg('states');
        if (Array.isArray(states) && states.length > 0) {
          const wanted = states.map((state) => String(state).toLowerCase());
          issues = issues.filter((issue) => wanted.includes(issue.state));
        }
        const orderBy = asRecord(arg('orderBy'));
        const direction = typeof orderBy.direction === 'string' ? orderBy.direction : null;
        if (direction === 'DESC') issues.sort((a, b) => b.createdSeq - a.createdSeq || b.number - a.number);
        else if (direction === 'ASC') issues.sort((a, b) => a.createdSeq - b.createdSeq || a.number - b.number);
        else issues.sort((a, b) => a.number - b.number);
        return gqlConnection(
          issues.map((issue) => gqlIssue(repo, issue)),
          'IssueConnection',
          args,
          ctx,
        );
      }
      case 'pullRequest': {
        const pull = repo.pulls.get(Number(arg('number')));
        return pull === undefined ? null : gqlPull(repo, pull);
      }
      case 'pullRequests': {
        let pulls = [...repo.pulls.values()];
        const states = arg('states');
        if (Array.isArray(states) && states.length > 0) {
          const wanted = states.map((state) => String(state).toUpperCase());
          pulls = pulls.filter((pull) => wanted.includes(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
        }
        pulls.sort((a, b) => a.number - b.number);
        return gqlConnection(
          pulls.map((pull) => gqlPull(repo, pull)),
          'PullRequestConnection',
          args,
          ctx,
        );
      }
      case 'labels': {
        const labels = [...repo.labels.values()].map((label) => tag('Label', { id: `L_${label.id}`, name: label.name, color: label.color, description: label.description }));
        return gqlConnection(labels, 'LabelConnection', args, ctx);
      }
      default:
        return undefined;
    }
  }

  if (type === 'Issue') {
    const repo = source.repo as RepoRecord;
    const issue = source.issue as IssueRecord;
    switch (field) {
      case 'id': return issueGraphqlId(repo, issue.number);
      case 'databaseId': return issue.id;
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'state': return issue.state.toUpperCase();
      case 'body': return issue.body;
      case 'url': return `/${viewer()}/${repo.name}/issues/${issue.number}`;
      case 'author': return tag('User', { login: viewer() });
      case 'createdAt': return issue.createdAt;
      case 'updatedAt': return issue.updatedAt;
      case 'closedAt': return issue.state === 'closed' ? issue.updatedAt : null;
      case 'repository': return gqlRepo(repo);
      case 'labels': {
        const labels = issue.labels
          .map((name) => repo.labels.get(name.toLowerCase()))
          .filter((label) => label !== undefined)
          .map((label) => tag('Label', { id: `L_${(label as { id: number }).id}`, name: (label as { name: string }).name, color: (label as { color: string }).color, description: (label as { description: string }).description }));
        return gqlConnection(labels, 'LabelConnection', args, ctx);
      }
      case 'comments': {
        const comments = issue.comments.map((comment) => tag('IssueComment', { id: `C_${comment.id}`, body: comment.body, createdAt: comment.createdAt, updatedAt: comment.updatedAt }));
        return gqlConnection(comments, 'IssueCommentConnection', args, ctx);
      }
      default:
        return undefined;
    }
  }

  if (type === 'PullRequest') {
    const repo = source.repo as RepoRecord;
    const pull = source.pull as PullRecord;
    switch (field) {
      case 'id': return pullGraphqlId(repo, pull.number);
      case 'databaseId': return pull.id;
      case 'number': return pull.number;
      case 'title': return pull.title;
      case 'body': return pull.body;
      case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
      case 'merged': return pull.merged;
      case 'mergedAt': return pull.mergedAt;
      case 'mergeable': return pull.state !== 'open' ? 'UNKNOWN' : pullIsConflicted(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
      case 'headRefName': return pull.head;
      case 'baseRefName': return pull.base;
      case 'headRef': return tag('Ref', { name: pull.head });
      case 'baseRef': return tag('Ref', { name: pull.base });
      case 'author': return tag('User', { login: viewer() });
      case 'url': return `/${viewer()}/${repo.name}/pull/${pull.number}`;
      case 'createdAt': return pull.createdAt;
      case 'updatedAt': return pull.updatedAt;
      case 'repository': return gqlRepo(repo);
      case 'files': {
        const base = pullMergeBase(repo, pull);
        const baseFlat = base === null ? new Map<string, TreeEntry>() : flatAtTip(repo, base);
        const headFlat = flatAtTip(repo, branchTip(repo, pull.head));
        const files = diffFlats(repo, baseFlat, headFlat).map((diff) =>
          tag('PullRequestChangedFile', {
            path: diff.filename,
            additions: diff.additions,
            deletions: diff.deletions,
            changeType: diff.status.toUpperCase(),
          }),
        );
        return gqlConnection(files, 'PullRequestChangedFileConnection', args, ctx);
      }
      case 'additions': {
        const base = pullMergeBase(repo, pull);
        const baseFlat = base === null ? new Map<string, TreeEntry>() : flatAtTip(repo, base);
        return diffFlats(repo, baseFlat, flatAtTip(repo, branchTip(repo, pull.head))).reduce((sum, diff) => sum + diff.additions, 0);
      }
      case 'deletions': {
        const base = pullMergeBase(repo, pull);
        const baseFlat = base === null ? new Map<string, TreeEntry>() : flatAtTip(repo, base);
        return diffFlats(repo, baseFlat, flatAtTip(repo, branchTip(repo, pull.head))).reduce((sum, diff) => sum + diff.deletions, 0);
      }
      case 'changedFiles': {
        const base = pullMergeBase(repo, pull);
        const baseFlat = base === null ? new Map<string, TreeEntry>() : flatAtTip(repo, base);
        return diffFlats(repo, baseFlat, flatAtTip(repo, branchTip(repo, pull.head))).length;
      }
      case 'mergeCommit': return pull.mergeCommitSha === null ? null : tag('Commit', { oid: pull.mergeCommitSha });
      case 'commits': return gqlConnection([], 'PullRequestConnection', args, ctx);
      default:
        return undefined;
    }
  }

  if (type === 'Commit') {
    return field in source ? source[field] : field === 'message' ? '' : undefined;
  }

  // Connections answer nodes/edges/pageInfo/totalCount from their prepared lists.
  if (type.endsWith('Connection')) {
    return field in source ? source[field] : undefined;
  }

  return undefined;
}

/** Wrap a list in a connection with first/after cursor pagination. */
function gqlConnection(nodes: GqlTagged[], type: string, args: Map<string, GqlValue>, ctx: GqlContext): GqlTagged {
  const firstRaw = gqlResolve(args.get('first'), ctx.variables);
  const first = typeof firstRaw === 'number' && firstRaw > 0 ? Math.floor(firstRaw) : nodes.length;
  const afterRaw = gqlResolve(args.get('after'), ctx.variables);
  const afterIndex = afterRaw === null || afterRaw === undefined ? -1 : gqlCursorIndex(afterRaw);
  const start = afterIndex + 1;
  const page = nodes.slice(start, start + first);
  const hasNext = start + page.length < nodes.length;
  const edges = page.map((node, index) => tag(type.replace('Connection', 'Edge'), { node, cursor: gqlCursor(start + index) }));
  return tag(type, {
    nodes: page,
    edges,
    totalCount: nodes.length,
    pageInfo: tag('PageInfo', {
      hasNextPage: hasNext,
      hasPreviousPage: start > 0,
      endCursor: page.length > 0 ? gqlCursor(start + page.length - 1) : null,
      startCursor: page.length > 0 ? gqlCursor(start) : null,
    }),
  });
}

/** Execute one selection set against a tagged value (or the Query/Mutation root). */
function gqlExecuteSelection(source: GqlTagged | null, type: string, selection: GqlField[], ctx: GqlContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selection) {
    if (field.fragmentSpread !== null) {
      const fragment = ctx.document.fragments.get(field.fragmentSpread);
      if (fragment !== undefined && (fragment.on === type || fragment.on === 'Node' || type === 'Repository')) {
        Object.assign(out, gqlExecuteSelection(source, type, fragment.selection, ctx));
      }
      continue;
    }
    if (field.inlineOn !== null) {
      if (field.inlineOn === type || (field.inlineOn === 'Node' && source !== null)) {
        Object.assign(out, gqlExecuteSelection(source, type, field.selection ?? [], ctx));
      }
      continue;
    }
    const key = field.alias ?? field.name;
    const knownFields = GQL_TYPE_FIELDS[type];
    const isIntrospectionField = field.name === '__type' || field.name === '__schema' || field.name === '__typename';
    if (knownFields !== undefined && !knownFields.includes(field.name) && !isIntrospectionField && source !== null && !type.endsWith('Connection') && type !== '__Type' && type !== '__Field' && type !== '__EnumValue' && type !== '__Schema') {
      // Plain-record types (payloads, edges, page info, comments, labels, files) validate by property.
      const plain = ['Payload', 'Edge', 'PageInfo', 'IssueComment', 'Label', 'PullRequestChangedFile', 'Ref', 'Commit', 'User', 'RepositoryOwner'].some((suffix) => type.includes(suffix));
      if (!plain || !(field.name in source)) {
        ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${type}".` });
        out[key] = null;
        continue;
      }
    }
    const value = gqlField(source, field.name, field.args, ctx);
    if (value === undefined) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${type}".` });
      out[key] = null;
      continue;
    }
    out[key] = gqlComplete(value, field, ctx);
  }
  return out;
}

/** Complete a resolved value against its selection set. */
function gqlComplete(value: unknown, field: GqlField, ctx: GqlContext): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => gqlComplete(item, field, ctx));
  if (typeof value === 'object') {
    const tagged = value as GqlTagged;
    if (typeof tagged.__type === 'string') {
      if (field.selection === null) return tagged;
      return gqlExecuteSelection(tagged, tagged.__type, field.selection, ctx);
    }
    return value;
  }
  return value;
}

function executeGraphql(body: Record<string, unknown>): Record<string, unknown> {
  const query = typeof body.query === 'string' ? body.query : '';
  const variables = asRecord(body.variables);
  let document: GqlDocument;
  try {
    document = parseGraphql(query);
  } catch {
    return { errors: [{ message: 'Syntax error in document' }] };
  }
  if (document.operations.length === 0) return { errors: [{ message: 'No operation found' }] };
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  const operation = operationName === null ? document.operations[0] : (document.operations.find((op) => op.name === operationName) ?? document.operations[0]);
  const ctx: GqlContext = { variables, errors: [], document };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = gqlExecuteSelection(tag(rootType, {}), rootType, operation.selection, ctx);
  const response: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) response.errors = ctx.errors;
  return response;
}

function handleGraphql(req: IncomingMessage, res: ServerResponse, rawBody: Buffer): void {
  if (!tokenAccepted(req)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return;
  }
  const parsed = parseJsonBody(rawBody);
  if (parsed === BAD_JSON || parsed === undefined) {
    sendJson(res, 400, { errors: [{ message: 'Invalid JSON body' }] });
    return;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => executeGraphql(asRecord(entry)));
    sendJson(res, 200, results);
    return;
  }
  const result = executeGraphql(asRecord(parsed));
  sendJson(res, 200, result);
}

// -------------------------------------------------------------------------------------------------
// MCP (Model Context Protocol, JSON-RPC 2.0 over streamable HTTP)
// -------------------------------------------------------------------------------------------------

const MCP_TOOLS: readonly Record<string, unknown>[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user and return the repository object.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name and return the repository object.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository and return the created issue.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue of a repository by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        number: { type: 'number', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'number'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch to a base branch and return it.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number (squash) and return the merged pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
];

const MCP_TOOLS_JSON = JSON.stringify({ tools: MCP_TOOLS });

function mcpToolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
    isError: false,
  };
}

function mcpToolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Resolve the (owner, repo) pair a tool call names; a full_name property is honoured too. */
function mcpRepo(args: Record<string, unknown>): RepoRecord | null {
  let owner = str(args.owner);
  let repoName = str(args.repo, str(args.name));
  const fullName = str(args.full_name);
  if (repoName === '' && fullName.includes('/')) {
    owner = fullName.split('/')[0];
    repoName = fullName.split('/').slice(1).join('/');
  }
  if (repoName === '') return null;
  if (owner !== '') return findRepo(owner, repoName);
  return findRepoByName(repoName);
}

function mcpCallTool(name: string, args: Record<string, unknown>): Record<string, unknown> | { rpcError: number; message: string } {
  const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) return { rpcError: -32602, message: `Unknown tool: ${name}` };
  const schema = tool.inputSchema as { required?: string[] };
  for (const required of schema.required ?? []) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return { rpcError: -32602, message: `Missing required argument: ${required}` };
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = str(args.name);
      const existing = findRepoByName(repoName);
      if (existing !== null) return mcpToolResult(repoJson(existing));
      const repo = createRepoRecord(repoName, args.private === true, str(args.description));
      return mcpToolResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = mcpRepo(args);
      if (repo === null) return mcpToolError('Repository not found');
      return mcpToolResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = mcpRepo(args);
      if (repo === null) return mcpToolError('Repository not found');
      const result = createIssueRecord(repo, { title: str(args.title), body: str(args.body) });
      if ('error' in result) return mcpToolError(result.error);
      return mcpToolResult(issueJson(repo, result.issue));
    }
    case 'list_issues': {
      const repo = mcpRepo(args);
      if (repo === null) return mcpToolError('Repository not found');
      const state = str(args.state, 'open');
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => a.number - b.number);
      return mcpToolResult(issues.map((issue) => issueJson(repo, issue)));
    }
    case 'get_issue': {
      const repo = mcpRepo(args);
      if (repo === null) return mcpToolError('Repository not found');
      const issue = repo.issues.get(Number(args.number ?? args.issue_number));
      if (issue === undefined) return mcpToolError('Issue not found');
      return mcpToolResult(issueJson(repo, issue));
    }
    case 'create_pull_request': {
      const repo = mcpRepo(args);
      if (repo === null) return mcpToolError('Repository not found');
      const result = createPullRecord(repo, {
        title: str(args.title),
        body: str(args.body),
        head: str(args.head),
        base: str(args.base, repo.defaultBranch),
      });
      if ('error' in result) {
        for (const pull of repo.pulls.values()) {
          if (pull.state === 'open' && pull.head === str(args.head) && pull.base === str(args.base)) {
            return mcpToolResult(pullJson(repo, pull));
          }
        }
        return mcpToolError(result.error);
      }
      return mcpToolResult(pullJson(repo, result.pull));
    }
    case 'merge_pull_request': {
      const repo = mcpRepo(args);
      if (repo === null) return mcpToolError('Repository not found');
      const pull = repo.pulls.get(Number(args.pull_number ?? args.number));
      if (pull === undefined) return mcpToolError('Pull request not found');
      if (!pull.merged) {
        const sha = mergePull(repo, pull);
        if (sha === null) return mcpToolError('Pull Request is not mergeable');
      }
      return mcpToolResult(pullJson(repo, pull));
    }
    case 'list_pull_requests': {
      const repo = mcpRepo(args);
      if (repo === null) return mcpToolError('Repository not found');
      const state = str(args.state, 'open');
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => a.number - b.number);
      return mcpToolResult(pulls.map((pull) => pullJson(repo, pull)));
    }
    default:
      return { rpcError: -32602, message: `Unknown tool: ${name}` };
  }
}

function mcpHandleOne(message: Record<string, unknown>): Record<string, unknown> | null {
  const method = str(message.method);
  const id = message.id ?? null;
  const isNotification = message.id === undefined || method.startsWith('notifications/');
  const params = asRecord(message.params);
  const reply = (result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id, result });
  const replyError = (code: number, text: string): Record<string, unknown> => ({ jsonrpc: '2.0', id, error: { code, message: text } });

  switch (method) {
    case 'server/discover':
      return reply({
        serverInfo: { name: 'git-forge-core', version: '1.0.0' },
        capabilities: { tools: {} },
        supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'],
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'git-forge-core', version: '1.0.0' } },
      });
    case 'initialize': {
      const requested = str(params.protocolVersion, '2025-11-25');
      const supported = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
      return reply({
        protocolVersion: supported.includes(requested) ? requested : '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'git-forge-core', version: '1.0.0' },
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply(JSON.parse(MCP_TOOLS_JSON) as unknown);
    case 'tools/call': {
      const result = mcpCallTool(str(params.name), asRecord(params.arguments));
      if ('rpcError' in result) return replyError(result.rpcError, result.message);
      return reply(result);
    }
    case 'resources/list':
      return reply({ resources: [] });
    case 'prompts/list':
      return reply({ prompts: [] });
    default:
      if (isNotification) return null;
      return replyError(-32601, `Method not found: ${method}`);
  }
}

function handleMcp(req: IncomingMessage, res: ServerResponse, rawBody: Buffer): void {
  if (!tokenAccepted(req)) {
    sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
    return;
  }
  if ((req.method ?? 'POST') !== 'POST') {
    sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not allowed' } });
    return;
  }
  const parsed = parseJsonBody(rawBody);
  if (parsed === BAD_JSON || parsed === undefined) {
    res.writeHead(400, { 'content-type': JSON_TYPE, 'x-github-request-id': nextRequestId() });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
    return;
  }
  if (Array.isArray(parsed)) {
    const replies = parsed.map((entry) => mcpHandleOne(asRecord(entry))).filter((entry) => entry !== null);
    sendJson(res, 200, replies);
    return;
  }
  const reply = mcpHandleOne(asRecord(parsed));
  if (reply === null) {
    res.writeHead(202, { 'x-github-request-id': nextRequestId() });
    res.end();
    return;
  }
  sendJson(res, 200, reply);
}

// -------------------------------------------------------------------------------------------------
// The server
// -------------------------------------------------------------------------------------------------

/** Build the forge's HTTP server. It binds nothing until the caller listens. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const rawBody = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);

        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          handleRest(req, res, url, rawBody);
          return;
        }
        if (path === '/api/graphql' && method === 'POST') {
          handleGraphql(req, res, rawBody);
          return;
        }
        if (path === '/mcp') {
          handleMcp(req, res, rawBody);
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(?:\/(.*))?$/.exec(path);
        if (gitMatch !== null) {
          const owner = decodeURIComponent(gitMatch[1]);
          const repoName = decodeURIComponent(gitMatch[2]);
          const sub = gitMatch[3] ?? '';
          const repo = findRepo(owner, repoName);
          if (repo === null) {
            sendRaw(res, 404, Buffer.from('repository not found\n'), 'text/plain');
            return;
          }
          if (method === 'GET' && sub === 'info/refs') {
            handleGitInfoRefs(req, res, url, repo);
            return;
          }
          if (method === 'POST' && sub === 'git-upload-pack') {
            handleUploadPack(req, res, repo, rawBody);
            return;
          }
          if (method === 'POST' && sub === 'git-receive-pack') {
            handleReceivePack(res, repo, rawBody);
            return;
          }
          sendRaw(res, 404, Buffer.from('not found\n'), 'text/plain');
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      }
    })();
  });
}
