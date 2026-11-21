// gcc-forge: a GitHub-compatible forge — REST v3 store engine.
// Content model: repos -> refs -> commits (blob tree) + issues/labels/pulls/comments.
// Deterministic: ids from a seeded counter; commit shas are sha1('commit ' + len + bytes) of a
// canonical serialized commit (git-style), blob shas sha1 of content — GitHub-shaped, stable.

import { createHash } from 'node:crypto';

export type Json = Record<string, unknown>;

export interface User { id: number; login: string; name: string; email: string; }
export interface Blob { sha: string; content: string; size: number; }
export interface TreeItem { path: string; mode: string; type: 'blob' | 'tree'; sha: string; size?: number; }
export interface Commit {
  sha: string;
  message: string;
  author: User;
  committer: User;
  epochSec: number;
  iso: string;
  parents: string[];
  tree: TreeItem[];
}
export interface Issue {
  number: number; id: number; title: string; body: string; state: 'open' | 'closed';
  labels: string[]; comments: Comment[]; createdAt: string; updatedAt: string; closedAt: string | null;
}
export interface Comment { id: number; body: string; createdAt: string; user: User; }
export interface Pull {
  number: number; id: number; title: string; body: string; state: 'open' | 'closed';
  merged: boolean; mergedAt: string | null; mergeCommitSha: string | null;
  head: { ref: string; sha: string; label: string };
  base: { ref: string; sha: string; label: string };
  createdAt: string; updatedAt: string;
}
export interface Repo {
  id: number; name: string; owner: string; description: string; private: boolean;
  defaultBranch: string; createdAt: string; updatedAt: string;
  refs: Map<string, string>;              // ref name -> commit sha
  commits: Map<string, Commit>;           // sha -> commit
  blobs: Map<string, Blob>;               // sha -> blob
  headPath: string;                       // path -> sha (flat file store per repo)
  labels: Map<string, { name: string; color: string }>;
  issues: Issue[]; pulls: Pull[];
  deleted: boolean;
}

export const sha1 = (data: Buffer | string): string => createHash('sha1').update(data).digest('hex');
export const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

/** Blob sha as git computes it: sha1('blob ' + len + '\0' + bytes). */
export function blobSha(content: string): string {
  const bytes = Buffer.from(content, 'utf8');
  return sha1(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]));
}

/** Commit sha over a canonical serialization (message + tree flat + parent list). */
function commitShaOf(message: string, tree: TreeItem[], parents: string[], author: User, epochSec: number): string {
  const treePart = tree.map((t) => `${t.mode} ${t.type} ${t.sha}\t${t.path}`).sort().join('\n');
  const body = `commit-ish\nmessage: ${message}\nauthor: ${author.login} <${author.email}> ${epochSec}\nparents: ${parents.join(' ')}\ntree:\n${treePart}`;
  return sha1(body);
}

/**
 * The forge store: owns the viewer login (the token's login), the viewer user object and all
 * repositories. A repository belongs to the viewer's login; the same name under another login
 * exists in the stranger namespace for the ownership checks (404, never 403).
 */

/** The frozen scenario the kit's wire.ts builds (embedded as scenario.json). */
export interface ScenarioData {
  viewer: { id: number; login: string; name: string; email: string };
  teammate: { id: number; login: string; name: string; email: string };
  stranger: { id: number; login: string; name: string; email: string };
  users: Array<{ id: number; login: string; name: string; email: string }>;
  org: string;
  repos: Array<{ id: number; owner: string; name: string; fullName: string; description: string; private: boolean; defaultBranch: string }>;
  orgRepos: Array<{ id: number; owner: string; name: string; fullName: string; description: string; private: boolean; defaultBranch: string }>;
  strangerRepos: Array<{ id: number; owner: string; name: string; fullName: string; description: string; private: boolean; defaultBranch: string }>;
  labels: string[];
  branches: string[];
  filePaths: string[];
  blobs: Array<{ path: string; content: string; base64: string }>;
  commits: Array<{ message: string; author: { id: number; login: string; name: string; email: string }; epochSec: number; iso: string }>;
  issues: Array<{ title: string; body: string; labels: string[] }>;
  pulls: Array<{ title: string; body: string; head: string; base: string }>;
}

export class Forge {
  readonly viewer: User;
  readonly stranger: User;
  private nextRepoId = 5000;
  private nextIssueId = 10000;
  private nextCommentId = 20000;
  private repos = new Map<string, Repo>();       // 'owner/name' -> repo
  private nextNumber = new Map<string, number>(); // 'owner/name' -> next issue/pull number
  now: string;                                    // frozen clock: MAKEFUN_TRIAL_NOW
  epoch: number;

  constructor(viewerLogin: string, strangerLogin: string, nowIso: string, epoch: number) {
    this.viewer = { id: 1, login: viewerLogin, name: viewerLogin, email: `${viewerLogin}@example.invalid` };
    this.stranger = { id: 2, login: strangerLogin, name: strangerLogin, email: `${strangerLogin}@example.invalid` };
    this.now = nowIso;
    this.epoch = epoch;
  }

  /** Two-digit hex id for a repo, unique per store. */
  repoKey(owner: string, name: string): string { return `${owner}/${name}`; }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean, defaultBranch: string): Repo {
    const key = this.repoKey(owner, name);
    if (this.repos.has(key)) throw new Error('name_exists');
    const repo: Repo = {
      id: this.nextRepoId++, name, owner, description, private: isPrivate,
      defaultBranch: defaultBranch || 'main', createdAt: this.now, updatedAt: this.now,
      refs: new Map(), commits: new Map(), blobs: new Map(), headPath: new Map(),
      labels: new Map(), issues: [], pulls: [], deleted: false,
    };
    // An unborn repo still has refs.map empty until the first commit lands (PUT /contents on an
    // unborn repository is accepted per checks-rest.ts, creating the default branch).
    this.repos.set(key, repo);
    return repo;
  }

  /** The trial's forge: the scenario's viewer/stranger and the 30 seeded viewer repos, empty of content. */
  static seeded(scenario: ScenarioData, nowIso: string, epoch: number): Forge {
    const forge = new Forge(scenario.viewer.login, scenario.stranger.login, nowIso, epoch);
    forge.viewer.id = scenario.viewer.id;
    forge.viewer.name = scenario.viewer.name;
    forge.viewer.email = scenario.viewer.email;
    forge.stranger.id = scenario.stranger.id;
    forge.stranger.name = scenario.stranger.name;
    forge.stranger.email = scenario.stranger.email;
    forge.scenario = scenario;
    for (const r of scenario.repos) {
      const key = `${r.owner}/${r.name}`;
      const repo: Repo = {
        id: r.id, name: r.name, owner: r.owner, description: r.description, private: r.private,
        defaultBranch: r.defaultBranch, createdAt: nowIso, updatedAt: nowIso,
        refs: new Map(), commits: new Map(), blobs: new Map(), headPath: new Map(),
        labels: new Map(), issues: [], pulls: [], deleted: false,
      };
      forge.repos.set(key, repo);
      if (r.id >= forge.nextRepoId) forge.nextRepoId = r.id + 1;
    }
    return forge;
  }

  /** The scenario, when this forge was built from one. */
  scenario: ScenarioData | null = null;

  getRepo(owner: string, name: string): Repo | null {
    const key = this.repoKey(owner, name);
    return this.repos.get(key) ?? null;
  }

  listViewerRepos(): Repo[] {
    return [...this.repos.values()].filter((r) => r.owner === this.viewer.login && !r.deleted)
      .sort((a, b) => a.id - b.id);
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.getRepo(owner, name);
    if (repo == null) return false;
    this.repos.delete(this.repoKey(owner, name));
    return true;
  }

  private nextNumberOf(repo: Repo): number {
    const key = this.repoKey(repo.owner, repo.name);
    const n = (this.nextNumber.get(key) ?? 1);
    this.nextNumber.set(key, n + 1);
    return n;
  }

  /** Store a blob; returns its sha. */
  putBlob(repo: Repo, content: string): string {
    const sha = blobSha(content);
    if (!repo.blobs.has(sha)) repo.blobs.set(sha, { sha, content, size: Buffer.byteLength(content, 'utf8') });
    return sha;
  }

  /** Current file snapshot of a commit: flat path -> blob sha. */
  commitTree(repo: Repo, sha: string): Map<string, string> | null {
    const commit = repo.commits.get(sha);
    if (commit == null) return null;
    const snap = new Map<string, string>();
    for (const item of commit.tree) if (item.type === 'blob') snap.set(item.path, item.sha);
    return snap;
  }

  /** The default branch's tip sha (null when unborn). */
  headSha(repo: Repo): string | null {
    return repo.refs.get(repo.defaultBranch) ?? null;
  }

  /** Branch tip sha. */
  refSha(repo: Repo, ref: string): string | null {
    return repo.refs.get(ref.replace(/^refs\/heads\//, '')) ?? null;
  }

  /** Build a TreeItem[] snapshot of a path->sha map. */
  private treeOf(snap: Map<string, string>, repo: Repo): TreeItem[] {
    return [...snap.entries()].map(([path, sha]) => {
      const blob = repo.blobs.get(sha);
      return { path, mode: '100644', type: 'blob' as const, sha, size: blob?.size ?? 0 };
    }).sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  /** Create a commit on a branch from a path->sha snapshot; returns the commit. */
  commit(repo: Repo, branch: string, message: string, snap: Map<string, string>, author = this.viewer): Commit {
    const parent = repo.refs.get(branch) ?? null;
    const parents = parent != null ? [parent] : [];
    const tree = this.treeOf(snap, repo);
    const sha = commitShaOf(message, tree, parents, author, this.epoch);
    const commitObj: Commit = {
      sha, message, author, committer: author, epochSec: this.epoch, iso: this.now,
      parents, tree,
    };
    repo.commits.set(sha, commitObj);
    repo.refs.set(branch, sha);
    repo.updatedAt = this.now;
    return commitObj;
  }

  /** List commits on a branch (newest first). */
  commitsOn(repo: Repo, ref: string): Commit[] {
    const tip = repo.refs.get(ref.replace(/^refs\/heads\//, ''));
    if (tip == null) return [];
    const out: Commit[] = [];
    const seen = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const c = repo.commits.get(sha);
      if (c == null) continue;
      out.push(c);
      for (const p of c.parents) stack.push(p);
    }
    return out.sort((a, b) => b.epochSec - a.epochSec || (b.sha < a.sha ? -1 : 1));
  }

  /** Diff two snapshots: GitHub pull-files shape. */
  diff(repo: Repo, baseSnap: Map<string, string>, headSnap: Map<string, string>): { path: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }[] {
    const out = [];
    const paths = new Set([...baseSnap.keys(), ...headSnap.keys()]);
    for (const path of paths) {
      const a = baseSnap.get(path);
      const b = headSnap.get(path);
      if (a === b) continue;
      if (a === undefined) {
        const blob = repo.blobs.get(b as string);
        out.push({ path, status: 'added', additions: (blob?.size ?? 0), deletions: 0, changes: (blob?.size ?? 0) });
      } else if (b === undefined) {
        const blob = repo.blobs.get(a);
        out.push({ path, status: 'removed', additions: 0, deletions: (blob?.size ?? 0), changes: (blob?.size ?? 0) });
      } else {
        const blobA = repo.blobs.get(a); const blobB = repo.blobs.get(b);
        out.push({ path, status: 'modified', additions: blobB?.size ?? 0, deletions: blobA?.size ?? 0, changes: (blobA?.size ?? 0) + (blobB?.size ?? 0) });
      }
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  // ---- issues / labels / pulls ----

  addLabel(repo: Repo, name: string, color: string): { name: string; color: string } | null {
    if (repo.labels.has(name)) return null;
    const label = { name, color };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    for (const label of labels) {
      if (!repo.labels.has(label)) throw new Error('label_not_found:' + label);
    }
    const number = this.nextNumberOf(repo);
    const issue: Issue = {
      number, id: this.nextIssueId++, title, body, state: 'open', labels: [...labels],
      comments: [], createdAt: this.now, updatedAt: this.now, closedAt: null,
    };
    repo.issues.push(issue);
    return issue;
  }

  addComment(repo: Repo, issue: Issue, body: string): Comment {
    const comment: Comment = { id: this.nextCommentId++, body, createdAt: this.now, user: this.viewer };
    issue.comments.push(comment);
    issue.updatedAt = this.now;
    return comment;
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull {
    const headSha = repo.refs.get(head);
    const baseSha = repo.refs.get(base);
    if (headSha == null || baseSha == null) throw new Error('refs_not_found');
    const number = this.nextNumberOf(repo);
    const pull: Pull = {
      number, id: this.nextIssueId++, title, body, state: 'open', merged: false, mergedAt: null,
      mergeCommitSha: null,
      head: { ref: head, sha: headSha, label: `${repo.owner}:${head}` },
      base: { ref: base, sha: baseSha, label: `${repo.owner}:${base}` },
      createdAt: this.now, updatedAt: this.now,
    };
    repo.pulls.push(pull);
    return pull;
  }

  /** Squash-merge a pull: one commit on base carrying the head snapshot's diff; closes the pull. */
  mergePull(repo: Repo, pull: Pull, message: string): { sha: string; } {
    const baseSha = repo.refs.get(pull.base.ref);
    if (baseSha == null) throw new Error('base_gone');
    const baseSnap = this.commitTree(repo, baseSha) ?? new Map<string, string>();
    const headSnap = this.commitTree(repo, pull.head.sha) ?? new Map<string, string>();
    const merged = new Map(baseSnap);
    for (const [path, sha] of headSnap) merged.set(path, sha);
    // apply only the diff: remove deleted paths
    for (const path of [...merged.keys()]) if (!headSnap.has(path) && !baseSnap.has(path)) merged.delete(path);
    const commit = this.commit(repo, pull.base.ref, message, merged);
    pull.merged = true;
    pull.mergedAt = this.now;
    pull.state = 'closed';
    pull.mergeCommitSha = commit.sha;
    repo.updatedAt = this.now;
    return { sha: commit.sha };
  }
}
