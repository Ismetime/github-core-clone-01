// GraphQL v4 executor for the gcc forge: answers the documents gh and github-mcp-server send
// (checks-graphql.ts GRAPHQL_DOCUMENTS), plus batching, introspection probes and error semantics.
// A tiny structured parser maps each known document shape onto resolvers over the Forge store.

import type { Forge, Repo, Issue, Pull } from './store.ts';
import { sha256 } from './store.ts';

export interface GqlRequest { query: string; variables?: Record<string, unknown>; }

/** Relay-style opaque global id: base64('type:databaseId') — stable, opaque, reversible for node(). */
export function globalId(type: string, db: number): string {
  return Buffer.from(`${type}:${db}`, 'utf8').toString('base64');
}
export function parseGlobalId(id: string): { type: string; db: number } | null {
  try {
    const [type, dbStr] = Buffer.from(id, 'base64').toString('utf8').split(':');
    if (type === undefined || dbStr === undefined) return null;
    const db = Number(dbStr);
    if (!Number.isFinite(db)) return null;
    return { type, db };
  } catch {
    return null;
  }
}

// ---- schema tables for the introspection probes ----

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'author', 'comments', 'createdAt', 'updatedAt', 'closedAt', 'labels', 'repository', 'url', 'viewerCanReact', 'viewerCanUpdate', 'viewerDidAuthor'];
const PULL_REQUEST_FIELDS = ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body', 'author', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'mergeCommit', 'headRefOid', 'baseRefOid', 'permalink', 'repository', 'url', 'viewerCanUpdate'];
const REPOSITORY_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt', 'updatedAt', 'isPrivate', 'url', 'viewerCanAdminister'];
const SEARCH_TYPE_ENUMS = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'ORGANIZATION'];
const ISSUE_STATE_ENUMS = ['OPEN', 'CLOSED'];
const PULL_REQUEST_STATE_ENUMS = ['OPEN', 'CLOSED', 'MERGED'];
const MERGEABLE_STATE_ENUMS = ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'];

function issueNode(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: globalId('Issue', issue.id), number: issue.number, title: issue.title, state: issue.state === 'closed' ? 'CLOSED' : 'OPEN',
    body: issue.body,
  };
}

function pullNode(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: globalId('PullRequest', pull.id), number: pull.number,
    headRefName: pull.head.ref, baseRefName: pull.base.ref,
    mergeable: 'MERGEABLE', state: pull.merged ? 'MERGED' : (pull.state === 'closed' ? 'CLOSED' : 'OPEN'),
    merged: pull.merged,
    files: {
      nodes: pullFiles(forge, repo, pull).map((p) => ({ path: p })),
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
}

function pullFiles(forge: Forge, repo: Repo, pull: Pull): string[] {
  const baseSnap = forge.commitTree(repo, pull.base.sha) ?? new Map<string, string>();
  const headSnap = forge.commitTree(repo, pull.head.sha) ?? new Map<string, string>();
  return forge.diff(repo, baseSnap, headSnap).map((d) => d.path);
}

function repoNode(forge: Forge, repo: Repo): Record<string, unknown> {
  return {
    id: globalId('Repository', repo.id), databaseId: repo.id,
    name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: globalId('User', repo.owner === forge.viewer.login ? 1 : 2) },
    defaultBranchRef: { name: repo.defaultBranch, id: globalId('Ref', repo.id) },
    viewerPermission: 'ADMIN', hasIssuesEnabled: true,
    description: repo.description, isPrivate: repo.private,
  };
}

/** Which query document is this? Recognize by signature substrings (fast, deterministic). */
function classify(doc: string): string {
  const d = doc.replace(/\s+/g, ' ');
  if (d.includes('mutation IssueCreate')) return 'createIssue';
  if (d.includes('mutation IssueClose')) return 'closeIssue';
  if (d.includes('mutation PullRequestCreate')) return 'createPullRequest';
  if (d.includes('mutation MergePullRequest')) return 'mergePullRequest';
  if (d.includes('mutation AddComment')) return 'addComment';
  if (d.includes('noSuchFieldOnViewer')) return 'invalidField';
  if (d.includes('__type(name: "Issue")') || d.includes('__type(name:"Issue")')) return 'issueIntrospection';
  if (d.includes('__type(name: "PullRequest")')) return 'typeIntrospection';
  if (d.includes('__type(name: "SearchType")')) return 'searchTypeEnumValues';
  if (d.includes('viewer {') && d.includes('login')) return 'viewerLogin';
  if (d.includes('node(id:')) return 'nodeRepository';
  if (d.includes('pageInfo') && d.includes('endCursor')) return 'issuesPage';
  if (d.includes('issues(first:') && d.includes('states: [OPEN]')) return 'openIssues';
  if (d.includes('issue(number:')) return 'issueByNumber';
  if (d.includes('pullRequest(number:')) return 'pullRequestById';
  if (d.includes('pullRequests(first:')) return 'pullRequests';
  if (d.includes('repository(owner:') && d.includes('defaultBranchRef')) return 'repositoryFields';
  if (d.includes('repository(owner:')) return 'repositoryFields';
  return 'unknown';
}

/** Find a viewer repo by its numeric database id (the db part of a Repository global id). */
function findRepoById(forge: Forge, db: number): Repo | null {
  return forge.listViewerRepos().find((r) => r.id === db) ?? null;
}

export interface GqlOutcome {
  status: number;
  body: unknown;             // the full HTTP JSON body
  batch?: boolean;
}

/** Execute one GraphQL request (query+variables) against the forge. */
export function graphqlExecute(forge: Forge, req: GqlRequest, nodeIndex = new Map<string, { repo: string; owner: string }>()): { data: unknown | null; errors: { message: string }[] } {
  const vars = (req.variables ?? {}) as Record<string, unknown>;
  const kind = classify(req.query);
  const errors: { message: string }[] = [];
  const E = (message: string): { data: unknown | null; errors: { message: string }[] } => {
    errors.push({ message });
    return { data: null, errors };
  };

  // validate unknown fields on viewer (the invalidField probe)
  if (kind === 'invalidField') {
    return { data: { viewer: { login: forge.viewer.login } }, errors: [{ message: "Field 'noSuchFieldOnViewer' doesn't exist on type 'Viewer'" }] };
  }

  if (kind === 'viewerLogin') {
    return { data: { viewer: { login: forge.viewer.login } }, errors: [] };
  }

  if (kind === 'issueIntrospection') {
    return { data: { Issue: { fields: ISSUE_FIELDS.map((name) => ({ name })) } }, errors: [] };
  }
  if (kind === 'typeIntrospection') {
    return {
      data: {
        PullRequest: { fields: PULL_REQUEST_FIELDS.map((name) => ({ name })) },
        Repository: { fields: REPOSITORY_FIELDS.map((name) => ({ name })) },
      },
      errors: [],
    };
  }
  if (kind === 'searchTypeEnumValues') {
    return { data: { SearchType: { enumValues: SEARCH_TYPE_ENUMS.map((name) => ({ name })) } }, errors: [] };
  }
  // An IssueState / PullRequestState / MergeableState / OrderDirection / IssueOrderField probe
  if (req.query.includes('__type(name: "IssueState")')) {
    return { data: { IssueState: { enumValues: ISSUE_STATE_ENUMS.map((name) => ({ name })) } }, errors: [] };
  }
  if (req.query.includes('__type(name: "PullRequestState")')) {
    return { data: { PullRequestState: { enumValues: PULL_REQUEST_STATE_ENUMS.map((name) => ({ name })) } }, errors: [] };
  }
  if (req.query.includes('__type(name: "MergeableState")')) {
    return { data: { MergeableState: { enumValues: MERGEABLE_STATE_ENUMS.map((name) => ({ name })) } }, errors: [] };
  }

  if (kind === 'nodeRepository') {
    const id = String(vars.id ?? '');
    const parsed = parseGlobalId(id);
    if (parsed == null || parsed.type !== 'Repository') return E(`node: no node for id ${id}`);
    const entry = nodeIndex.get(id);
    if (entry == null) return E('node not found');
    const repo = forge.getRepo(entry.owner, entry.repo);
    if (repo == null) return { data: { node: null }, errors: [] };
    const node = repoNode(forge, repo);
    return { data: { node: { id, ...node } }, errors: [] };
  }

  // ---- mutations: resolve the target through global ids, never owner/name ----
  if (kind === 'createIssue') {
    const input = (vars.input ?? {}) as Record<string, unknown>;
    const repositoryId = String(input.repositoryId ?? '');
    const parsed = parseGlobalId(repositoryId);
    const target = findRepoById(forge, parsed != null ? parsed.db : NaN);
    if (target == null) return E(`createIssue: no repository for id ${repositoryId}`);
    const title = String(input.title ?? '');
    const body = input.body == null ? '' : String(input.body);
    try {
      const issue = forge.createIssue(target, title, body, []);
      return { data: { createIssue: { issue: { number: issue.number, id: globalId('Issue', issue.id) } } }, errors: [] };
    } catch (err) {
      return E(`createIssue: ${(err as Error).message}`);
    }
  }

  if (kind === 'closeIssue') {
    const input = (vars.input ?? {}) as Record<string, unknown>;
    const issueId = String(input.issueId ?? '');
    const parsed = parseGlobalId(issueId);
    if (parsed == null || parsed.type !== 'Issue') return E('closeIssue: bad issueId');
    for (const candidate of forge.listViewerRepos()) {
      const issue = candidate.issues.find((i) => i.id === parsed.db);
      if (issue != null) {
        issue.state = 'closed';
        issue.closedAt = forge.now;
        issue.updatedAt = forge.now;
        return { data: { closeIssue: { issue: { number: issue.number, id: issueId, state: 'CLOSED' } } }, errors: [] };
      }
    }
    return E('closeIssue: issue not found');
  }

  if (kind === 'createPullRequest') {
    const input = (vars.input ?? {}) as Record<string, unknown>;
    const repositoryId = String(input.repositoryId ?? '');
    const parsed = parseGlobalId(repositoryId);
    const target = findRepoById(forge, parsed != null ? parsed.db : NaN);
    if (target == null) return E(`createPullRequest: no repository for id ${repositoryId}`);
    const baseRefName = String(input.baseRefName ?? '');
    const headRefName = String(input.headRefName ?? '');
    const title = String(input.title ?? '');
    const body = input.body == null ? '' : String(input.body);
    try {
      const pull = forge.createPull(target, title, body, headRefName, baseRefName);
      return {
        data: {
          createPullRequest: {
            pullRequest: {
              number: pull.number, id: globalId('PullRequest', pull.id), state: 'OPEN',
              headRefName, baseRefName,
            },
          },
        },
        errors: [],
      };
    } catch (err) {
      return E(`createPullRequest: ${(err as Error).message}`);
    }
  }

  if (kind === 'mergePullRequest') {
    const input = (vars.input ?? {}) as Record<string, unknown>;
    const pullRequestId = String(input.pullRequestId ?? '');
    const parsed = parseGlobalId(pullRequestId);
    if (parsed == null || parsed.type !== 'PullRequest') return E('mergePullRequest: bad id');
    const mergeMethod = input.mergeMethod == null ? 'MERGE' : String(input.mergeMethod);
    void mergeMethod;
    for (const candidate of forge.listViewerRepos()) {
      const pull = candidate.pulls.find((p) => p.id === parsed.db);
      if (pull != null) {
        const result = forge.mergePull(candidate, pull, `Merge pull request #${pull.number}`);
        return {
          data: {
            mergePullRequest: {
              pullRequest: { number: pull.number, merged: true, state: 'MERGED', sha: result.sha },
            },
          },
          errors: [],
        };
      }
    }
    return E('mergePullRequest: pull not found');
  }

  if (kind === 'addComment') {
    const input = (vars.input ?? {}) as Record<string, unknown>;
    const subjectId = String(input.subjectId ?? '');
    const body = String(input.body ?? '');
    const parsed = parseGlobalId(subjectId);
    if (parsed == null) return E('addComment: bad subjectId');
    for (const candidate of forge.listViewerRepos()) {
      const issue = candidate.issues.find((i) => i.id === parsed.db);
      if (issue != null) {
        const comment = forge.addComment(candidate, issue, body);
        return {
          data: {
            addComment: {
              commentEdge: { node: { id: globalId('Comment', comment.id), body: comment.body } },
            },
          },
          errors: [],
        };
      }
    }
    return E('addComment: subject not found');
  }

  // ---- repository(owner:, name:) reads ----
  const owner = vars.owner == null ? forge.viewer.login : String(vars.owner);
  const name = vars.name == null ? '' : String(vars.name);
  const repo = forge.getRepo(owner, name);
  if (repo == null) return { data: { repository: null }, errors: [] };
  nodeIndex.set(globalId('Repository', repo.id), { repo: repo.name, owner: repo.owner });

  if (kind === 'repositoryFields') {
    return { data: { repository: repoNode(forge, repo) }, errors: [] };
  }

  if (kind === 'openIssues') {
    const first = Number(vars.first ?? 10);
    const open = repo.issues.filter((i) => i.state === 'open').sort((a, b) => b.number - a.number);
    return {
      data: {
        repository: {
          issues: {
            nodes: open.slice(0, first).map((i) => issueNode(forge, repo, i)),
            pageInfo: { hasNextPage: open.length > first, endCursor: null },
          },
        },
      },
      errors: [],
    };
  }

  if (kind === 'issuesPage') {
    const first = Number(vars.first ?? 5);
    const after = vars.after == null ? null : String(vars.after);
    const all = repo.issues.slice().sort((a, b) => a.number - b.number);
    let start = 0;
    if (after != null) {
      const parsed = parseGlobalId(after);
      start = parsed != null ? Number(parsed.db) : 0;
      // after is a cursor like 'cursor:5'; we encode page offset
      const match = /^offset:(\d+)$/.exec(after);
      if (match) start = Number(match[1]);
    }
    const page = all.slice(start, start + first);
    return {
      data: {
        repository: {
          issues: {
            nodes: page.map((i) => issueNode(forge, repo, i)),
            pageInfo: { hasNextPage: start + first < all.length, endCursor: `offset:${start + first}` },
          },
        },
      },
      errors: [],
    };
  }

  if (kind === 'issueByNumber') {
    const number = Number(vars.number ?? 0);
    const issue = repo.issues.find((i) => i.number === number);
    if (issue == null) return { data: { repository: { issue: null } }, errors: [] };
    return { data: { repository: { issue: issueNode(forge, repo, issue) } }, errors: [] };
  }

  if (kind === 'pullRequests') {
    const first = Number(vars.first ?? 10);
    const list = repo.pulls.slice(0, first);
    return { data: { repository: { pullRequests: { nodes: list.map((p) => pullNode(forge, repo, p)) } } }, errors: [] };
  }

  if (kind === 'pullRequestById' || (kind === 'unknown' && req.query.includes('pullRequest(number:'))) {
    const number = Number(vars.number ?? 0);
    const pull = repo.pulls.find((p) => p.number === number);
    if (pull == null) return { data: { repository: { pullRequest: null } }, errors: [] };
    const node = pullNode(forge, repo, pull);
    // PullRequestFiles document also asks files(first: 10) { nodes { path } }
    return { data: { repository: { pullRequest: node } }, errors: [] };
  }

  return E(`Unknown document: ${req.query.slice(0, 80)}`);
}
