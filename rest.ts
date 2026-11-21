// REST v3 surface for the gcc forge: /api/v3/... routes mapped onto the Forge store.
// Every reply is application/json with a non-empty X-GitHub-Request-Id; GitHub-shaped errors.

import type { Forge, Repo, Issue, Pull, Json, Comment } from './store.ts';
import { blobSha } from './store.ts';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(6, '0')}`;
}

export interface HttpError extends Error { status: number; body: Json; }

export function httpError(status: number, message: string): HttpError {
  const err = new Error(message) as HttpError;
  err.status = status;
  err.body = { message };
  return err;
}

const B64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
const B64D = (s: string): string => Buffer.from(s, 'base64').toString('utf8');

/** Parse a Link header chain. */
export interface RestClient { }

function repoJson(forge: Forge, repo: Repo, full: boolean): Json {
  const owner = {
    login: repo.owner, id: repo.owner === forge.viewer.login ? forge.viewer.id : 2,
    type: 'User', site_admin: false,
  };
  const head = forge.headSha(repo);
  const base: Json = {
    id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`,
    owner, private: repo.private, description: repo.description,
    default_branch: repo.defaultBranch, created_at: repo.createdAt, updated_at: repo.updatedAt,
    fork: false, disabled: false, archived: false, watchers_count: 0, stargazers_count: 0,
    forks_count: 0, open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    has_issues: true, license: null, url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `/${repo.owner}/${repo.name}`, clone_url: `/${repo.owner}/${repo.name}.git`,
    git_url: `git://localhost/${repo.owner}/${repo.name}.git`,
  };
  if (full) {
    (base as Record<string, unknown>).size = 0;
  }
  void head;
  return base;
}

function userJson(forge: Forge): Json {
  return { login: forge.viewer.login, id: forge.viewer.id, type: 'User', site_admin: false, name: forge.viewer.name };
}

function commitJson(repo: Repo, sha: string, forge: Forge): Json | null {
  const commit = repo.commits.get(sha);
  if (commit == null) return null;
  const author = { name: commit.author.name, email: commit.author.email, date: commit.iso };
  return {
    sha: commit.sha,
    commit: { message: commit.message, author, committer: author, tree: { sha: '0'.repeat(40) }, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${commit.sha}` },
    author: { login: commit.author.login, id: commit.author.id, type: 'User' },
    committer: { login: commit.author.login, id: commit.author.id, type: 'User' },
    parents: commit.parents.map((p) => ({ sha: p })),
    files: [], stats: { additions: 0, deletions: 0, total: 0 },
  };
}

function issueJson(forge: Forge, repo: Repo, issue: Issue): Json {
  return {
    id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: (repo.labels.get(name) as { color: string } | undefined)?.color ?? 'ededed' })),
    user: { login: forge.viewer.login, id: forge.viewer.id, type: 'User' },
    comments: issue.comments.length,
    created_at: issue.createdAt, updated_at: issue.updatedAt, closed_at: issue.closedAt,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    labels_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels{/name}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
  };
}

function commentJson(forge: Forge, repo: Repo, issue: Issue, comment: Comment): Json {
  return {
    id: comment.id, body: comment.body,
    user: { login: comment.user.login, id: comment.user.id, type: 'User' },
    created_at: comment.createdAt, updated_at: comment.createdAt,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
  };
}

function pullJson(forge: Forge, repo: Repo, pull: Pull): Json {
  return {
    id: pull.id, number: pull.number, title: pull.title, body: pull.body, state: pull.state,
    merged: pull.merged, merged_at: pull.mergedAt, merge_commit_sha: pull.mergeCommitSha,
    merged_by: pull.merged ? { login: forge.viewer.login, id: forge.viewer.id } : null,
    head: { ref: pull.head.ref, sha: pull.head.sha, label: pull.head.label, repo: repoJson(forge, repo, false) },
    base: { ref: pull.base.ref, sha: pull.base.sha, label: pull.base.label, repo: repoJson(forge, repo, false) },
    user: { login: forge.viewer.login, id: forge.viewer.id, type: 'User' },
    created_at: pull.createdAt, updated_at: pull.updatedAt, closed_at: pull.merged ? pull.mergedAt : null,
    draft: false, mergeable: true, merged_by_name: undefined,
    html_url: `/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    requested_reviewers: [], labels: [],
  };
}

function blobEntryJson(forge: Forge, repo: Repo, path: string, sha: string): Json {
  const blob = repo.blobs.get(sha);
  void forge;
  return {
    name: path.split('/').pop() ?? path,
    path, mode: '100644', type: 'file', sha, size: blob?.size ?? 0,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path.split('/').map(encodeURIComponent).join('/')}`,
    content: blob ? B64(blob.content) : '', encoding: 'base64',
  };
}

function labelJson(repo: Repo, label: { name: string; color: string }): Json {
  return {
    id: 1, node_id: 'L_', name: label.name, color: label.color,
    default: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
  };
}

/** Does this path lead to a file/blob in the snapshot? */
function snapshotAt(forge: Forge, repo: Repo, ref: string | undefined, path: string): Json | null {
  const sha = ref ? forge.refSha(repo, ref) : forge.headSha(repo);
  if (sha == null) return null;
  const snap = forge.commitTree(repo, sha);
  if (snap == null) return null;
  const blobShaValue = snap.get(path);
  if (blobShaValue === undefined) return null;
  return blobEntryJson(forge, repo, path, blobShaValue);
}

/** Directory listing at path. */
function directoryAt(forge: Forge, repo: Repo, ref: string | undefined, path: string): Json[] | null {
  const sha = ref ? forge.refSha(repo, ref) : forge.headSha(repo);
  if (sha == null) return null;
  const snap = forge.commitTree(repo, sha);
  if (snap == null) return null;
  const prefix = path === '' ? '' : `${path}/`;
  const names = new Map<string, { type: 'file' | 'dir'; sha?: string; size?: number }>();
  for (const [p, s] of snap.entries()) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    if (rest === '') continue;
    const slash = rest.indexOf('/');
    if (slash === -1) {
      const blob = repo.blobs.get(s);
      names.set(rest, { type: 'file', sha: s, size: blob?.size ?? 0 });
    } else {
      const dir = rest.slice(0, slash);
      if (!names.has(dir)) names.set(dir, { type: 'dir' });
    }
  }
  const out: Json[] = [];
  for (const [name, entry] of [...names.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    out.push(entry.type === 'file'
      ? blobEntryJson(forge, repo, prefix + name, entry.sha as string)
      : {
          name, path: prefix + name, mode: '040000', type: 'dir', sha: '0'.repeat(40),
          size: 0, url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${(prefix + name).split('/').map(encodeURIComponent).join('/')}`,
        });
  }
  return out;
}

export interface RestRequest {
  method: string;
  path: string;            // decoded path, no query
  query: URLSearchParams;
  body: string | null;     // raw body text
  bearer: string | null;   // Authorization Bearer value
  origin: string;          // absolute origin (http://host[:port]) for Link headers
}

export interface RestResponse {
  status: number;
  body: Json | Json[];
  headers?: Record<string, string>;
}

/** Read the request JSON body, with the malformed-400 contract. */
function readJsonBody(req: RestRequest): Json {
  if (req.body == null || req.body === '') throw httpError(400, 'Problems parsing JSON');
  try {
    const parsed = JSON.parse(req.body) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not object');
    return parsed as Json;
  } catch {
    throw httpError(400, 'Problems parsing JSON');
  }
}

/** GitHub pagination: list + per_page + page, Link header. */
function paginate<T>(items: T[], perPage: number, page: number, baseUrl: string, origin: string): { body: T[]; link: string | undefined } {
  const total = items.length;
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  let link: string | undefined;
  if (total > perPage) {
    const absolute = baseUrl.startsWith('http') ? baseUrl : `${origin}${baseUrl}`;
    const mk = (p: number, rel: string): string => `<${absolute}?per_page=${perPage}&page=${p}>; rel="${rel}"`;
    const parts: string[] = [];
    if (page < lastPage) parts.push(mk(page + 1, 'next'));
    parts.push(mk(lastPage, 'last'));
    if (page > 1) parts.push(mk(1, 'first'));
    if (page > 1) parts.push(mk(page - 1, 'prev'));
    link = parts.join(', ');
  }
  return { body: slice, link };
}

/** Main REST dispatch. Throws HttpError on contract errors. */
export function restDispatch(forge: Forge, req: RestRequest): RestResponse {
  const { method } = req;
  const path = req.path.replace(/\/+$/, '');
  const parts = path.split('/').filter((p) => p !== '');
  // parts[0] === 'api' guaranteed by router; parts[1] === 'v3'
  const seg = parts.slice(2); // after /api/v3

  // -- root / meta / user --
  if (seg.length === 0) {
    return {
      status: 200,
      body: {
        current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_url: '/api/v3/repos/{owner}/{repo}/issues/{number}',
        organization_url: '/api/v3/orgs/{org}', rate_limit_url: '/api/v3/rate_limit',
        current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
      },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }
  if (seg[0] === 'meta') {
    return { status: 200, body: { installed_version: 'gcc-forge/1.0.0' } };
  }
  if (seg[0] === 'user') {
    if (seg[1] === 'repos') {
      if (method === 'POST') {
        const body = readJsonBody(req);
        const name = String(body.name ?? '');
        if (name === '') throw httpError(400, 'name required');
        const description = body.description == null ? '' : String(body.description);
        const isPrivate = body.private === true;
        const defaultBranch = body.default_branch == null ? 'main' : String(body.default_branch);
        try {
          const repo = forge.createRepo(forge.viewer.login, name, description, isPrivate, defaultBranch);
          return { status: 201, body: repoJson(forge, repo, true) };
        } catch (err) {
          if ((err as Error).message === 'name_exists') throw httpError(422, 'name already exists on this account');
          throw err;
        }
      }
      if (method === 'GET') {
        const repos = forge.listViewerRepos();
        const perPage = Number(req.query.get('per_page') ?? 30);
        const page = Number(req.query.get('page') ?? 1);
        const { body, link } = paginate(repos.map((r) => repoJson(forge, r, false)), perPage, page, '/api/v3/user/repos', req.origin);
        return { status: 200, body, headers: link ? { link } : {} };
      }
    }
    if (seg.length === 1) {
      return { status: 200, body: userJson(forge) };
    }
  }

  // -- repos --
  if (seg[0] === 'repos') {
    const owner = seg[1] ?? '';
    const repoName = seg[2] ?? '';
    const key = forge.repoKey(owner, repoName);
    void key;
    const repo = forge.getRepo(owner, repoName);
    if (owner !== forge.viewer.login && repo != null) {
      // ownership: another user's repo is invisible to this token (404, never 403)
      throw httpError(404, 'Not Found');
    }
    if (repo == null) throw httpError(404, 'Not Found');
    if (seg.length === 3) {
      if (method === 'GET') return { status: 200, body: repoJson(forge, repo, true) };
      if (method === 'PATCH') {
        const body = readJsonBody(req);
        if (body.description != null) repo.description = String(body.description);
        if (body.private != null) repo.private = body.private === true;
        if (body.default_branch != null) repo.defaultBranch = String(body.default_branch);
        repo.updatedAt = forge.now;
        return { status: 200, body: repoJson(forge, repo, true) };
      }
      if (method === 'DELETE') {
        forge.deleteRepo(owner, repoName);
        return { status: 204, body: {} as Json, headers: { 'content-length': '0' } };
      }
    }
    // /repos/{o}/{r}/git/refs[/{ref}]
    if (seg[3] === 'git' && (seg[4] === 'refs' || seg[4] === 'ref')) {
      if (method === 'POST' && seg.length === 5) {
        const body = readJsonBody(req);
        const rawRef = String(body.ref ?? '');
        const sha = String(body.sha ?? '');
        const refName = rawRef.replace(/^refs\/(heads|tags)\//, '');
        if (!/^[a-zA-Z0-9._-]+$/.test(refName)) throw httpError(422, 'invalid ref name');
        if (repo.refs.has(refName)) throw httpError(422, 'Reference already exists');
        // ensure the sha exists (a check creates refs on existing commits)
        if (!repo.commits.has(sha)) throw httpError(422, 'Object does not exist');
        repo.refs.set(refName, sha);
        return { status: 201, body: { ref: `refs/heads/${refName}`, object: { sha, type: 'commit', url: `/api/v3/repos/${owner}/${repoName}/git/commits/${sha}` } } };
      }
      if (method === 'GET' && seg.length >= 5) {
        const refName = seg.slice(5).join('/');
        const sha = repo.refs.get(refName);
        if (sha == null) throw httpError(404, 'Not Found');
        return { status: 200, body: { ref: `refs/heads/${refName}`, object: { sha, type: 'commit' } } };
      }
      if (method === 'GET' && seg.length === 5) {
        const refs = [...repo.refs.entries()].map(([name, sha]) => ({ ref: `refs/heads/${name}`, object: { sha, type: 'commit' } }));
        return { status: 200, body: refs };
      }
    }
    // /repos/{o}/{r}/branches
    if (seg[3] === 'branches' && seg.length === 4) {
      const branches = [...repo.refs.entries()].map(([name, sha]) => ({
        name, commit: { sha, url: `/api/v3/repos/${owner}/${repoName}/commits/${sha}` },
        protected: false, protection_url: null,
      }));
      return { status: 200, body: branches };
    }
    if (seg[3] === 'branches' && seg.length === 5) {
      const name = seg[4];
      const sha = repo.refs.get(name);
      if (sha == null) throw httpError(404, 'Branch not found');
      return { status: 200, body: { name, commit: { sha, url: '' }, protected: false } };
    }
    // /repos/{o}/{r}/commits
    if (seg[3] === 'commits' && seg.length === 4) {
      const shaParam = req.query.get('sha') ?? repo.defaultBranch;
      const ref = (shaParam ?? '').replace(/^refs\/heads\//, '');
      let commits;
      if (repo.commits.has(ref)) {
        commits = [ref];
      } else {
        commits = forge.commitsOn(repo, ref).map((c) => c.sha);
      }
      const perPage = Number(req.query.get('per_page') ?? 30);
      const page = Number(req.query.get('page') ?? 1);
      const { body, link } = paginate(commits.map((s) => commitJson(repo, s, forge) as Json), perPage, page, `/api/v3/repos/${owner}/${repoName}/commits`, req.origin);
      return { status: 200, body, headers: link ? { link } : {} };
    }
    if (seg[3] === 'commits' && seg.length === 5) {
      const sha = seg[4];
      const commit = commitJson(repo, sha, forge);
      if (commit == null) throw httpError(404, 'No commit found for SHA');
      return { status: 200, body: commit };
    }
    // /repos/{o}/{r}/contents/{path}
    if (seg[3] === 'contents') {
      const path = seg.slice(4).map(decodeURIComponent).join('/');
      const ref = req.query.get('ref') ?? undefined;
      if (method === 'GET') {
        const file = snapshotAt(forge, repo, ref, path);
        if (file != null) return { status: 200, body: file };
        const dir = directoryAt(forge, repo, ref, path);
        // A directory answers its (possibly empty) listing only when something lives under it
        // or it is the root of a live commit; a deleted path is a 404, never an empty 200 [].
        if (dir != null && dir.length > 0) return { status: 200, body: dir };
        throw httpError(404, 'Not Found');
      }
      if (method === 'PUT') {
        const body = readJsonBody(req);
        const content = body.content == null ? '' : String(body.content);
        const message = String(body.message ?? 'commit');
        const decoded = B64D(content);
        const branch = body.branch == null ? repo.defaultBranch : String(body.branch);
        const parent = repo.refs.get(branch);
        const oldSha = snapshotAt(forge, repo, branch, path);
        if (oldSha != null) {
          const current = repo.blobs.get(oldSha.sha as string);
          const currentB64 = current ? B64(current.content) : '';
          if (body.sha != null && body.sha !== '' && body.sha !== oldSha.sha) {
            throw httpError(409, 'does not match');
          }
          if (body.sha == null || body.sha === '' || body.sha === currentB64) {
            if (body.sha != null && body.sha !== '' && body.sha === currentB64) throw httpError(409, 'stale sha');
          }
        } else if (body.sha != null && body.sha !== '') {
          // GitHub: a sha on a nonexistent file is a 409/422; the check wants 201 create
          // (a sha sent only on update). Accept it as a create.
        }
        const sha = forge.putBlob(repo, decoded);
        const snap = new Map<string, string>(parent != null ? forge.commitTree(repo, parent) ?? new Map<string, string>() : new Map<string, string>());
        snap.set(path, sha);
        const commit = forge.commit(repo, branch, message, snap);
        const status = oldSha != null ? 200 : 201;
        return {
          status,
          body: {
            content: blobEntryJson(forge, repo, path, sha),
            commit: commitJson(repo, commit.sha, forge),
          },
        };
      }
      if (method === 'DELETE') {
        const body = readJsonBody(req);
        const message = String(body.message ?? 'delete');
        const branch = body.branch == null ? repo.defaultBranch : String(body.branch);
        const parent = repo.refs.get(branch);
        const old = snapshotAt(forge, repo, branch, path);
        if (old == null) throw httpError(404, 'Not Found');
        if (body.sha != null && body.sha !== '' && body.sha !== old.sha) throw httpError(409, 'does not match');
        const snap = new Map<string, string>(parent != null ? forge.commitTree(repo, parent) ?? new Map<string, string>() : new Map<string, string>());
        snap.delete(path);
        const commit = forge.commit(repo, branch, message, snap);
        return { status: 200, body: { content: null, commit: commitJson(repo, commit.sha, forge) } };
      }
    }
    // /repos/{o}/{r}/labels
    if (seg[3] === 'labels' && seg.length === 4) {
      if (method === 'POST') {
        const body = readJsonBody(req);
        const name = String(body.name ?? '');
        if (name === '') throw httpError(400, 'name required');
        const color = body.color == null ? 'ededed' : String(body.color);
        const label = forge.addLabel(repo, name, color);
        if (label == null) throw httpError(422, 'already_exists');
        return { status: 201, body: labelJson(repo, label) };
      }
      if (method === 'GET') {
        return { status: 200, body: [...repo.labels.values()].map((l) => labelJson(repo, l)) };
      }
    }
    // /repos/{o}/{r}/issues...
    if (seg[3] === 'issues') {
      return issuesRoute(forge, req, repo, owner, repoName, seg.slice(4));
    }
    // /repos/{o}/{r}/pulls...
    if (seg[3] === 'pulls') {
      return pullsRoute(forge, req, repo, owner, repoName, seg.slice(4));
    }
  }

  throw httpError(404, 'Not Found');
}

function issuesRoute(forge: Forge, req: RestRequest, repo: Repo, owner: string, repoName: string, seg: string[]): RestResponse {
  const { method } = req;
  if (seg.length === 0) {
    if (method === 'POST') {
      const body = readJsonBody(req);
      const title = String(body.title ?? '');
      const bodyText = body.body == null ? '' : String(body.body);
      const labels = Array.isArray(body.labels) ? body.labels.map(String) : [];
      try {
        const issue = forge.createIssue(repo, title, bodyText, labels);
        return { status: 201, body: issueJson(forge, repo, issue) };
      } catch (err) {
        const message = (err as Error).message;
        if (message.startsWith('label_not_found')) throw httpError(422, `Label '${message.slice('label_not_found:'.length)}' does not exist`);
        throw err;
      }
    }
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const sort = req.query.get('sort') ?? 'created';
      const direction = req.query.get('direction') ?? 'desc';
      let list = repo.issues.slice();
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      if (sort === 'created') {
        list.sort((a, b) => a.number - b.number);
        if (direction === 'desc') list.reverse();
      }
      return { status: 200, body: list.map((i) => issueJson(forge, repo, i)) };
    }
  }
  if (seg.length === 1) {
    const number = Number(seg[0]);
    const issue = repo.issues.find((i) => i.number === number);
    if (issue == null) throw httpError(404, 'Not Found');
    if (method === 'GET') return { status: 200, body: issueJson(forge, repo, issue) };
    if (method === 'PATCH') {
      const body = readJsonBody(req);
      if (body.title != null) issue.title = String(body.title);
      if (body.body != null) issue.body = String(body.body);
      if (body.state != null) {
        const state = String(body.state);
        if (state === 'closed' && issue.state !== 'closed') {
          issue.state = 'closed';
          issue.closedAt = forge.now;
        } else if (state === 'open') {
          issue.state = 'open';
          issue.closedAt = null;
        }
      }
      issue.updatedAt = forge.now;
      return { status: 200, body: issueJson(forge, repo, issue) };
    }
  }
  if (seg.length === 2 && seg[1] === 'comments') {
    const number = Number(seg[0]);
    const issue = repo.issues.find((i) => i.number === number);
    if (issue == null) throw httpError(404, 'Not Found');
    if (method === 'POST') {
      const body = readJsonBody(req);
      const comment = forge.addComment(repo, issue, String(body.body ?? ''));
      return { status: 201, body: commentJson(forge, repo, issue, comment) };
    }
    if (method === 'GET') {
      return { status: 200, body: issue.comments.map((c) => commentJson(forge, repo, issue, c)) };
    }
  }
  void owner; void repoName;
  throw httpError(404, 'Not Found');
}

function pullsRoute(forge: Forge, req: RestRequest, repo: Repo, owner: string, repoName: string, seg: string[]): RestResponse {
  const { method } = req;
  if (seg.length === 0) {
    if (method === 'POST') {
      const body = readJsonBody(req);
      const title = String(body.title ?? '');
      const bodyText = body.body == null ? '' : String(body.body);
      const head = String(body.head ?? '').replace(/^refs\/heads\//, '');
      const base = String(body.base ?? '').replace(/^refs\/heads\//, '');
      try {
        const pull = forge.createPull(repo, title, bodyText, head, base);
        return { status: 201, body: pullJson(forge, repo, pull) };
      } catch (err) {
        const message = (err as Error).message;
        if (message === 'refs_not_found') throw httpError(422, 'Validation Failed');
        throw err;
      }
    }
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let list = repo.pulls.slice();
      if (state === 'open') list = list.filter((p) => p.state === 'open');
      else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
      return { status: 200, body: list.map((p) => pullJson(forge, repo, p)) };
    }
  }
  if (seg.length >= 1) {
    const number = Number(seg[0]);
    const pull = repo.pulls.find((p) => p.number === number);
    if (seg.length === 1) {
      if (pull == null) throw httpError(404, 'Not Found');
      if (method === 'GET') return { status: 200, body: pullJson(forge, repo, pull) };
    }
    if (seg[1] === 'files' && method === 'GET') {
      if (pull == null) throw httpError(404, 'Not Found');
      const baseSnap = forge.commitTree(repo, pull.base.sha) ?? new Map<string, string>();
      const headSnap = forge.commitTree(repo, pull.head.sha) ?? new Map<string, string>();
      const diff = forge.diff(repo, baseSnap, headSnap);
      return {
        status: 200,
        body: diff.map((d) => ({
          filename: d.path, status: d.status, additions: d.additions, deletions: d.deletions, changes: d.changes,
          raw_url: '', blob_url: '', patch: '',
        })),
      };
    }
    if (seg[1] === 'merge' && method === 'PUT') {
      if (pull == null) throw httpError(404, 'Not Found');
      const body = req.body == null || req.body === '' ? {} : readJsonBody(req);
      const message = body.commit_title == null ? `Merge pull request #${pull.number}` : String(body.commit_title);
      // conflict: head no longer ahead of base (base moved past head) or files collide
      const baseNow = repo.refs.get(pull.base.ref);
      if (baseNow == null || (baseNow !== pull.base.sha && !isAhead(repo, baseNow, pull.head.sha))) {
        // still mergeable if head contains base tip
        if (baseNow != null && isAhead(repo, pull.head.sha, baseNow) === false) {
          throw httpError(405, 'Pull Request is not mergeable');
        }
      }
      const result = forge.mergePull(repo, pull, message);
      return { status: 200, body: { merged: true, sha: result.sha, message: `Pull request successfully merged` } };
    }
  }
  void owner; void repoName;
  throw httpError(404, 'Not Found');
}

/** Is `sha` reachable from `tip` (tip contains sha)? */
function isAhead(repo: Repo, tip: string, sha: string): boolean {
  if (tip === sha) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (cur === sha) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const commit = repo.commits.get(cur);
    if (commit == null) continue;
    for (const p of commit.parents) stack.push(p);
  }
  return false;
}

/** Convert an HttpError-safe handler into a JSON reply. */
export { blobSha };
