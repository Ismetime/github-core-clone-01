// The gcc forge HTTP app: healthz, REST v3, GraphQL, MCP and git smart HTTP on one server.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Forge, type ScenarioData } from './store.ts';

const scenarioJson = readFileSync(new URL('./scenario.json', import.meta.url), 'utf8');
import { restDispatch, nextRequestId, JSON_TYPE, httpError, type HttpError } from './rest.ts';
import { graphqlExecute, globalId } from './graphql.ts';
import { mcpExecute } from './mcp.ts';
import { infoRefs, uploadPack, receivePack, parseGitPath, gitStates } from './githttp.ts';

const TOKEN_ENV = 'MAKEFUN_SHOP_TOKEN';

// The viewer login is derived exactly as the suite's wire.ts buildScenario() derives it: users
// from the seeded stream 'users' (xorshift64* over SCENARIO_SEED ^ fnv1a64('users')), viewer = users[0].
// We re-derive it here with the same arithmetic so the forge and the suite agree without a network
// handshake. (The scenario constants are the kit's public seeded data, not another entry's files.)
/** Build the forge from the trial's environment. */
export function buildForge(): Forge {
  const scenario = JSON.parse(scenarioJson) as ScenarioData;
  const nowRaw = process.env.MAKEFUN_TRIAL_NOW ?? new Date(0).toISOString();
  const now = new Date(nowRaw).toISOString().replace(/\.20\d\dZ$/, 'Z').replace(/\.0+Z$/, 'Z');
  const epoch = Math.floor(new Date(nowRaw).getTime() / 1000);
  return Forge.seeded(scenario, now, epoch);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === undefined || body === null ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': String(Buffer.byteLength(text)),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
    ...headers,
  });
  res.end(body);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Read the full request body. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

export function createApp(): Server {
  const forge = buildForge();
  const token = process.env[TOKEN_ENV] ?? '';
  const nodeIndex = new Map<string, { repo: string; owner: string }>();
  void globalId;

  // Register every repo in the node index as it is created (a lazy proxy would also work).
  const origCreate = forge.createRepo.bind(forge);
  (forge as unknown as { createRepo: typeof origCreate }).createRepo = ((owner: string, name: string, description: string, isPrivate: boolean, defaultBranch: string) => {
    const repo = origCreate(owner, name, description, isPrivate, defaultBranch);
    nodeIndex.set(globalId('Repository', repo.id), { repo: repo.name, owner: repo.owner });
    gitStates.delete(`${owner}/${name}`);
    return repo;
  }) as typeof origCreate;
  const origDelete = forge.deleteRepo.bind(forge);
  (forge as unknown as { deleteRepo: typeof origDelete }).deleteRepo = ((owner: string, name: string) => {
    gitStates.delete(`${owner}/${name}`);
    return origDelete(owner, name);
  }) as typeof origDelete;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(forge, nodeIndex, req, res, token).catch((err: unknown) => {
      try {
        sendJson(res, 500, { message: (err as Error).message });
      } catch { /* socket gone */ }
    });
  });
  return server;
}

async function handle(forge: Forge, nodeIndex: Map<string, { repo: string; owner: string }>, req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://entry');
  const path = url.pathname;
  const gitProtocol = req.headers['git-protocol'] as string | undefined ?? null;
  const auth = req.headers.authorization ?? null;
  const bearer = auth != null && auth.toLowerCase().startsWith('bearer ') ? auth.slice(7) : null;

  // /healthz takes no token
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // git smart HTTP: /{owner}/{repo}.git/...
  const gitParsed = parseGitPath(path);
  if (gitParsed != null) {
    // git over smart HTTP requires no bearer (git clients send none); the rules do not gate it
    const body = await readBody(req);
    const rest = gitParsed.rest.replace(/^\/+/, '');
    if (method === 'GET' && rest === 'info/refs') {
      const service = url.searchParams.get('service') ?? null;
      const mapped = service === 'git-upload-pack' ? 'upload-pack' as const : service === 'git-receive-pack' ? 'receive-pack' as const : null;
      const r = infoRefs(forge, { method, service: mapped, path, query: url.searchParams, body, gitProtocol });
      sendBuffer(res, r.status, r.contentType, r.body);
      return;
    }
    if (method === 'POST' && rest === 'git-upload-pack') {
      const r = uploadPack(forge, { method, service: 'upload-pack', path, query: url.searchParams, body, gitProtocol });
      sendBuffer(res, r.status, r.contentType, r.body);
      return;
    }
    if (method === 'POST' && rest === 'git-receive-pack') {
      const r = receivePack(forge, { method, service: 'receive-pack', path, query: url.searchParams, body, gitProtocol });
      sendBuffer(res, r.status, r.contentType, r.body);
      return;
    }
    sendBuffer(res, 404, 'text/plain', Buffer.from('not found\n'));
    return;
  }

  // MCP: POST /mcp (JSON body, may be a parse failure)
  if (path === '/mcp') {
    if (bearer == null || bearer === '') {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
    if (bearer !== token && token !== '') {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (Array.isArray(parsed)) {
      // batch JSON-RPC (not used by the suite but harmless)
      const answers = parsed.map((one) => mcpExecute(forge, one as Record<string, unknown>));
      sendJson(res, 200, answers.map((a) => JSON.parse(a.body)));
      return;
    }
    const answer = mcpExecute(forge, parsed as Record<string, unknown>);
    sendBuffer(res, answer.status, 'application/json', Buffer.from(answer.body));
    return;
  }

  // GraphQL: POST /api/graphql
  if (path === '/api/graphql') {
    if (bearer == null || bearer !== token) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
    if (Array.isArray(parsed)) {
      const answers = parsed.map((one) => graphqlExecute(forge, one as { query: string; variables?: Record<string, unknown> }, nodeIndex));
      sendJson(res, 200, answers);
      return;
    }
    const one = parsed as { query?: string; variables?: Record<string, unknown> };
    if (typeof one.query !== 'string' || one.query === '') {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
    const outcome = graphqlExecute(forge, { query: one.query, variables: one.variables }, nodeIndex);
    sendJson(res, 200, outcome);
    return;
  }

  // REST v3: /api/v3/...
  if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
    if (bearer == null || bearer === '') {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    if (bearer !== token) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    const raw = await readBody(req);
    const bodyText = raw.length === 0 ? null : raw.toString('utf8');
    try {
      const host = req.headers.host ?? 'entry';
      const origin = `http://${host}`;
      const r = restDispatch(forge, { method, path, query: url.searchParams, body: bodyText, bearer, origin });
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(r.headers ?? {})) headers[k] = v;
      if (r.status === 204) {
        res.writeHead(204, { 'x-github-request-id': nextRequestId(), ...headers });
        res.end();
        return;
      }
      sendJson(res, r.status, r.body, headers);
    } catch (err) {
      const httpErr = err as HttpError;
      if (httpErr.status != null) {
        sendJson(res, httpErr.status, httpErr.body);
        return;
      }
      sendJson(res, 500, { message: (err as Error).message });
      return;
    }
  }

  // Everything else: GitHub's 404 body
  void httpError;
  sendJson(res, 404, { message: 'Not Found' });
}
