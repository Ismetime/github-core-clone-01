// MCP endpoint for the gcc forge: JSON-RPC 2.0 over Streamable HTTP at /mcp, revision 2026-07-28.
// Six tools acting on the same Forge store the REST surface serves.

import type { Forge, Repo } from './store.ts';
import { globalId } from './graphql.ts';

export interface McpTool {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, unknown>; required?: string[] };
}

const toolsList: McpTool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user. Returns the repository object with its id, name, full_name and default branch.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' }, owner: { type: 'string', description: 'Repository owner (defaults to the token login)' } }, required: ['name'] },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name. Returns the repository object with id, name, full_name, description and default branch.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner' }, repo: { type: 'string', description: 'Repository name' }, full_name: { type: 'string', description: 'Full name owner/repo' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository. Returns the created issue with its number, title and state.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Issue title' }, body: { type: 'string', description: 'Issue body' }, labels: { type: 'array', items: { type: 'string' } } }, required: ['owner', 'repo', 'title'] },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state (open, closed or all).',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner' }, repo: { type: 'string', description: 'Repository name' }, state: { type: 'string', description: 'Issue state filter: open, closed or all' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch. Returns the pull request with its number, head and base refs.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Pull request title' }, body: { type: 'string', description: 'Pull request body' }, head: { type: 'string', description: 'Head branch name' }, base: { type: 'string', description: 'Base branch name' } }, required: ['owner', 'repo', 'title', 'head', 'base'] },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number. Returns merged: true and the merge commit sha.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner' }, repo: { type: 'string', description: 'Repository name' }, pull_number: { type: 'number', description: 'Pull request number' } }, required: ['owner', 'repo', 'pull_number'] },
  },
];

/** The exact tools/list JSON (byte-identical across calls). */
const TOOLS_LIST_JSON = JSON.stringify({ tools: toolsList });

function repoObject(forge: Forge, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    description: repo.description,
    private: repo.private,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    owner: { login: repo.owner },
    html_url: `/${repo.owner}/${repo.name}`,
  };
}

function issueObject(forge: Forge, repo: Repo, issue: { id: number; number: number; title: string; body: string; state: string; labels: string[]; createdAt: string; updatedAt: string; closedAt: string | null; comments: { id: number; body: string }[] }): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: (repo.labels.get(name) as { color: string } | undefined)?.color ?? 'ededed' })),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    user: { login: forge.viewer.login, id: forge.viewer.id },
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullObject(repo: Repo, pull: { id: number; number: number; title: string; state: string; merged: boolean; head: { ref: string; sha: string }; base: { ref: string; sha: string }; mergedAt: string | null; mergeCommitSha: string | null }): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head.ref, sha: pull.head.sha, label: `${repo.owner}:${pull.head.ref}` },
    base: { ref: pull.base.ref, sha: pull.base.sha, label: `${repo.owner}:${pull.base.ref}` },
  };
}

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export interface McpAnswer {
  status: number;
  body: string;
}

const JSONRPC_PARSE = { code: -32700, message: 'Parse error' };
const JSONRPC_METHOD = { code: -32601, message: 'Method not found' };
const JSONRPC_PARAMS = { code: -32602, message: 'Invalid params' };

/** Tool call result: content text + structuredContent for the client's text search. */
function toolResult(obj: Record<string, unknown>): Record<string, unknown> {
  const text = JSON.stringify(obj, null, 0);
  return {
    content: [{ type: 'text', text }],
    structuredContent: obj,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    structuredContent: { error: message },
    isError: true,
  };
}

/** Execute one JSON-RPC request against the forge. */
export function mcpExecute(forge: Forge, req: JsonRpcRequest): McpAnswer {
  const id = req.id ?? null;
  const respond = (status: number, payload: Record<string, unknown>): McpAnswer => {
    const body = JSON.stringify(payload);
    return { status, body };
  };
  const result = (resultObj: unknown): McpAnswer => respond(200, { jsonrpc: '2.0', id, result: resultObj });
  const error = (status: number, code: number, message: string): McpAnswer => respond(status, { jsonrpc: '2.0', id, error: { code, message } });

  const method = req.method ?? '';

  if (method === 'server/discover') {
    return result({
      resultType: 'DiscoverResult',
      supportedVersions: ['2026-07-28', '2025-11-25'],
      capabilities: { tools: { listChanged: false } },
      instructions: 'A GitHub-compatible forge speaking MCP over streamable HTTP.',
      serverInfo: { name: 'gcc-forge', version: '1.0.0' },
    });
  }
  if (method === 'initialize') {
    return result({
      protocolVersion: '2026-07-28',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'gcc-forge', version: '1.0.0' },
    });
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return respond(202, {});
  }
  if (method === 'tools/list') {
    return respond(200, { jsonrpc: '2.0', id, result: { tools: toolsList } });
  }
  if (method === 'ping') {
    return result({});
  }
  if (method === 'tools/call') {
    const params = (req.params ?? {}) as Record<string, unknown>;
    const name = String(params.name ?? '');
    // map name: server prefix allowed, matched as suffix case-insensitively
    const canonical = toolsList.find((t) => t.name.toLowerCase() === name.toLowerCase() || name.toLowerCase().endsWith('__' + t.name.toLowerCase()) || name.toLowerCase().endsWith('.' + t.name.toLowerCase()) || name.toLowerCase().endsWith(':' + t.name.toLowerCase()));
    if (canonical == null) {
      return error(200, -32602, `Unknown tool: ${name}`);
    }
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    // the suite maps arguments onto the schema's nearest property names and fills full_name
    return toolsCall(forge, canonical.name, args, id);
  }
  return error(200, -32601, `Method not found: ${method}`);
}

function argString(args: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    if (args[name] !== undefined && args[name] !== null) return String(args[name]);
  }
  return undefined;
}

function toolsCall(forge: Forge, name: string, args: Record<string, unknown>, id: string | number | null): McpAnswer {
  const ok = (obj: Record<string, unknown>): McpAnswer => ({ status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, result: toolResult(obj) }) });
  const err = (message: string): McpAnswer => ({ status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, result: toolError(message) }) });
  const rpcErr = (code: number, message: string): McpAnswer => ({ status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) });

  switch (name) {
    case 'create_repo': {
      const repoName = argString(args, 'name', 'repo', 'repository');
      if (repoName === undefined) return rpcErr(-32602, 'create_repo: name is required');
      const owner = argString(args, 'owner') ?? forge.viewer.login;
      const description = argString(args, 'description') ?? '';
      const isPrivate = args.private === true;
      if (forge.getRepo(owner, repoName) != null) return err('create_repo: repository already exists');
      const repo = forge.createRepo(owner, repoName, description, isPrivate, 'main');
      return ok(repoObject(forge, repo));
    }
    case 'get_repo': {
      const owner = argString(args, 'owner') ?? forge.viewer.login;
      let repoName = argString(args, 'repo', 'name');
      const fullName = argString(args, 'full_name', 'repository');
      if (repoName === undefined && fullName !== undefined && fullName.includes('/')) {
        repoName = fullName.split('/')[1] ?? undefined;
      }
      if (repoName === undefined) return rpcErr(-32602, 'get_repo: repo is required');
      const repo = forge.getRepo(owner, repoName);
      if (repo == null) return err(`get_repo: repository ${owner}/${repoName} not found`);
      return ok(repoObject(forge, repo));
    }
    case 'create_issue': {
      const owner = argString(args, 'owner') ?? forge.viewer.login;
      const repoName = argString(args, 'repo', 'repository');
      const title = argString(args, 'title');
      if (repoName === undefined || title === undefined) return rpcErr(-32602, 'create_issue: owner, repo and title are required');
      const repo = forge.getRepo(owner, repoName);
      if (repo == null) return err(`create_issue: repository ${owner}/${repoName} not found`);
      const body = argString(args, 'body') ?? '';
      const labels = Array.isArray(args.labels) ? args.labels.map(String) : [];
      try {
        const issue = forge.createIssue(repo, title, body, labels);
        return ok(issueObject(forge, repo, issue));
      } catch (e) {
        return err(`create_issue: ${(e as Error).message}`);
      }
    }
    case 'list_issues': {
      const owner = argString(args, 'owner') ?? forge.viewer.login;
      const repoName = argString(args, 'repo', 'repository');
      if (repoName === undefined) return rpcErr(-32602, 'list_issues: owner and repo are required');
      const repo = forge.getRepo(owner, repoName);
      if (repo == null) return err(`list_issues: repository ${owner}/${repoName} not found`);
      const state = argString(args, 'state') ?? 'open';
      let list = repo.issues.slice();
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      return ok({ total_count: list.length, issues: list.map((i) => issueObject(forge, repo, i)) });
    }
    case 'create_pull_request': {
      const owner = argString(args, 'owner') ?? forge.viewer.login;
      const repoName = argString(args, 'repo', 'repository');
      const title = argString(args, 'title');
      const head = argString(args, 'head', 'head_branch');
      const base = argString(args, 'base', 'base_branch');
      if (repoName === undefined || title === undefined || head === undefined || base === undefined) return rpcErr(-32602, 'create_pull_request: owner, repo, title, head and base are required');
      const repo = forge.getRepo(owner, repoName);
      if (repo == null) return err(`create_pull_request: repository ${owner}/${repoName} not found`);
      const body = argString(args, 'body') ?? '';
      try {
        const pull = forge.createPull(repo, title, body, head.replace(/^refs\/heads\//, ''), base.replace(/^refs\/heads\//, ''));
        return ok(pullObject(repo, pull));
      } catch (e) {
        return err(`create_pull_request: ${(e as Error).message}`);
      }
    }
    case 'merge_pull_request': {
      const owner = argString(args, 'owner') ?? forge.viewer.login;
      const repoName = argString(args, 'repo', 'repository');
      const numberRaw = args.pull_number ?? args.number ?? args.pull_request_number;
      if (repoName === undefined || numberRaw === undefined) return rpcErr(-32602, 'merge_pull_request: owner, repo and pull_number are required');
      const number = Number(numberRaw);
      const repo = forge.getRepo(owner, repoName);
      if (repo == null) return err(`merge_pull_request: repository ${owner}/${repoName} not found`);
      const pull = repo.pulls.find((p) => p.number === number);
      if (pull == null) return err(`merge_pull_request: pull request #${number} not found`);
      if (pull.merged) return err(`merge_pull_request: pull request #${number} already merged`);
      const merged = forge.mergePull(repo, pull, `Merge pull request #${number}`);
      return ok({ number, merged: true, sha: merged.sha, message: 'Pull request successfully merged' });
    }
    default:
      return rpcErr(-32602, `Unknown tool: ${name}`);
  }
}
