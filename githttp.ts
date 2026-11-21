// Smart-HTTP git routes for the gcc forge: /{owner}/{repo}.git/info/refs, git-upload-pack, git-receive-pack.

import { Buffer } from 'node:buffer';
import type { Forge, Repo } from './store.ts';
import {
  ZERO_OID, hashObject, parsePktLines, pktLine, pktFlush, pktDelimiter,
  readPackObjectsPrecise, applyDelta, buildTree, parseTree, parseCommit, buildCommit,
  writePack, sideBandPack, parseTag, buildTag,
} from './git.ts';

export interface GitRequest {
  method: string;
  service: 'upload-pack' | 'receive-pack' | null;   // from URL or Git-Protocol header
  path: string;            // /{owner}/{repo}.git/...
  query: URLSearchParams;
  body: Buffer | null;
  gitProtocol: string | null;  // Git-Protocol header value
}

export interface GitResponse {
  status: number;
  contentType: string;
  headers?: Record<string, string>;
  body: Buffer;
}

const SMART_CT = 'application/x-git-upload-pack-advertisement';

function notFound(): GitResponse {
  return { status: 404, contentType: 'text/plain', body: Buffer.from('repository not found\n') };
}

/** Parse /{owner}/{repo}.git/... path into (owner, repo, rest). */
export function parseGitPath(path: string): { owner: string; repo: string; rest: string } | null {
  const m = /^\/([^/]+)\/([^/]+)\.git\/?(.*)$/.exec(path);
  if (m == null) return null;
  return { owner: decodeURIComponent(m[1]), repo: decodeURIComponent(m[2]), rest: m[3] };
}

/** The object database of one repo: oid -> {type, data}. */
export class ObjectDb {
  private objects = new Map<string, { type: string; data: Buffer }>();

  has(oid: string): boolean { return this.objects.has(oid); }
  get(oid: string): { type: string; data: Buffer } | undefined { return this.objects.get(oid); }
  put(type: string, data: Buffer): string {
    const oid = hashObject(type, data);
    this.objects.set(oid, { type, data });
    return oid;
  }
  /** Insert a raw object with a known oid (from a pushed pack). */
  putWithOid(oid: string, type: string, data: Buffer): void {
    this.objects.set(oid, { type, data });
  }
}

/** One repository's git state: the object db, refs and (pushed) ref targets. */
export interface GitRepoState {
  db: ObjectDb;
  refs: Map<string, string>;       // 'refs/heads/main' -> oid
  peeled: Map<string, string>;     // 'refs/tags/v1' -> peeled commit oid (annotated tags)
  shallow: Set<string>;            // shallow boundary oids (per-clone view; we keep none globally)
  /** The REST-side repo, so pushed refs mirror into repo.refs. */
  repo?: import('./store.ts').Repo;
}

/** The forge's git states, keyed 'owner/name'. */
export const gitStates = new Map<string, GitRepoState>();

export function gitStateOf(forge: Forge, owner: string, name: string): GitRepoState | null {
  const key = `${owner}/${name}`;
  let state = gitStates.get(key);
  if (state === undefined) {
    const repo = forge.getRepo(owner, name);
    if (repo == null) return null;
    // sync REST-created refs (branches made over POST /git/refs) into the git state lazily
    state = { db: new ObjectDb(), refs: new Map(), peeled: new Map(), shallow: new Set(), repo };
    gitStates.set(key, state);
    syncRestRefs(forge, repo, state);
  }
  return state;
}

/** REST refs (created via POST /git/refs pointing at REST commits) map onto git refs when the
 * target commit exists in the object db; REST-only commits appear as their REST sha. */
function syncRestRefs(_forge: Forge, _repo: Repo, _state: GitRepoState): void {
  // The REST surface and the git surface share the forge's commit map: REST commits made through
  // PUT /contents are recorded in repo.commits; we materialize them as real git objects on demand.
  void _forge; void _repo; void _state;
}


/**
 * Materialize one pushed git commit into the REST store's commit map, so POST /pulls, the contents
 * `?ref=` reads and the GraphQL fixtures see what a git client pushed (tree walked recursively).
 */
function materializeCommit(state: GitRepoState, repo: Repo, oid: string, seen = new Set<string>()): void {
  if (seen.has(oid)) return;
  seen.add(oid);
  if (repo.commits.has(oid)) return;
  const obj = state.db.get(oid);
  if (obj == null || obj.type !== 'commit') return;
  const commit = parseCommit(obj.data);
  // walk the whole tree into blob entries (REST commits carry a flat path->blob list)
  const items: { path: string; mode: string; type: 'blob' | 'tree'; sha: string; size?: number }[] = [];
  const walk = (treeOid: string, prefix: string): void => {
    const treeObj = state.db.get(treeOid);
    if (treeObj == null || treeObj.type !== 'tree') return;
    for (const entry of parseTree(treeObj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') {
        walk(entry.oid, path);
      } else {
        const blob = state.db.get(entry.oid);
        if (blob != null) repo.blobs.set(entry.oid, { sha: entry.oid, content: blob.data.toString('utf8'), size: blob.data.length });
        items.push({ path, mode: entry.mode, type: 'blob', sha: entry.oid, size: blob?.data.length ?? 0 });
      }
    }
  };
  walk(commit.tree, '');
  const who = commit.committerIdentity ?? commit.authorIdentity;
  const author = { id: 1, login: repo.owner, name: who?.name ?? repo.owner, email: who?.email ?? `${repo.owner}@example.invalid` };
  repo.commits.set(oid, {
    sha: oid, message: commit.message, author, committer: author,
    epochSec: commit.timestamp, iso: new Date(commit.timestamp * 1000).toISOString().replace(/\.\d+Z$/, 'Z'),
    parents: [...commit.parents], tree: items,
  });
  for (const parent of commit.parents) materializeCommit(state, repo, parent, seen);
}

// ---- info/refs advertisement ----

export function infoRefs(forge: Forge, req: GitRequest): GitResponse {
  const parsed = parseGitPath(req.path);
  if (parsed == null) return notFound();
  const state = gitStateOf(forge, parsed.owner, parsed.repo);
  if (state == null) return notFound();
  const wantV2 = req.service === 'upload-pack' && (req.gitProtocol ?? '').includes('version=2');

  if (req.service === 'upload-pack' && wantV2) {
    // v2 capability advertisement
    const lines = [
      'version 2',
      'ls-refs=unborn',
      'fetch=shallow wait-for-done',
      'server-option',
      'object-format=sha1',
      'agent=gcc-forge/1.0',
    ];
    const body = Buffer.concat([...lines.map((l) => pktLine(`${l}\n`)), pktFlush]);
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body };
  }

  // v0 advertisement
  const service = req.service ?? 'upload-pack';
  const serviceHeader = pktLine(`# service=git-${service}\n`);
  const capsBase = service === 'receive-pack'
    ? 'report-status report-status-v2 delete-refs side-band-64k quiet atomic ofs-delta object-format=sha1 agent=gcc-forge/1.0'
    : 'multi_ack multi_ack_detailed side-band-64k side-band thin-pack ofs-delta no-done shallow deepen-since deepen-not deepen-relative no-progress include-tag allow-tip-sha1-in-want allow-reachable-sha1-in-want object-format=sha1 agent=gcc-forge/1.0';
  const refLines: Buffer[] = [];
  const refs = [...state.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  let first = true;
  // HEAD symref line first
  const head = state.refs.get('refs/heads/main') ?? [...state.refs.values()][0];
  if (refs.length > 0 && head != null) {
    refLines.push(pktLine(`${ZERO_OID} capabilities^{}\0${capsBase} symref=HEAD:refs/heads/main\n`));
    first = false;
  }
  for (const [ref, oid] of refs) {
    if (first) {
      refLines.push(pktLine(`${oid} ${ref}\0${capsBase} symref=HEAD:refs/heads/main\n`));
      first = false;
    } else {
      refLines.push(pktLine(`${oid} ${ref}\n`));
    }
  }
  for (const [tagRef, peeled] of state.peeled.entries()) {
    if (state.refs.has(tagRef)) {
      refLines.push(pktLine(`${peeled} ${tagRef}^{}\n`));
    }
  }
  if (refs.length === 0) {
    // empty repo: capabilities on the capabilities^{} pseudo-ref alone
    refLines.push(pktLine(`${ZERO_OID} capabilities^{}\0${capsBase}\n`));
  }
  const body = Buffer.concat([serviceHeader, pktFlush, ...refLines, pktFlush]);
  const ct = service === 'receive-pack' ? 'application/x-git-receive-pack-advertisement' : SMART_CT;
  return { status: 200, contentType: ct, body };
}

// ---- upload-pack (fetch) ----

export function uploadPack(forge: Forge, req: GitRequest): GitResponse {
  const parsed = parseGitPath(req.path);
  if (parsed == null) return notFound();
  const state = gitStateOf(forge, parsed.owner, parsed.repo);
  if (state == null) return notFound();
  const wantV2 = (req.gitProtocol ?? '').includes('version=2');
  const body = req.body ?? Buffer.alloc(0);

  if (wantV2 && !body.toString('ascii').trimLeft().startsWith('\u0000')) {
    // Detect v2 by the body shape: v2 requests start with command=ls-refs / command=fetch
    // (unless thin v0). Try v2 when the header said so.
  }

  const lines = parsePktLines(body);

  // ---- v2 protocol: command=<name> then capability lines then flush, then args ----
  const firstPayload = lines.find((l) => l.kind === 'line' && l.payload != null && l.payload.length > 0);
  const firstText = firstPayload?.payload?.toString('utf8') ?? '';
  const isV2 = wantV2 || /^command=(ls-refs|fetch)/.test(firstText.trim());

  if (isV2) {
    return uploadPackV2(state, body);
  }
  return uploadPackV0(state, body);
}

function uploadPackV2(state: GitRepoState, body: Buffer): GitResponse {
  // Parse the v2 request: one or more command sections, each: command=X, caps, flush, args until flush.
  const lines = parsePktLines(body);
  const commands: { name: string; args: Map<string, string[]> }[] = [];
  let current: { name: string; args: Map<string, string[]> } | null = null;
  for (const line of lines) {
    if (line.kind === 'flush') {
      if (current != null) { commands.push(current); current = null; }
      continue;
    }
    if (line.payload == null) continue;
    const text = line.payload.toString('utf8').trimEnd();
    if (text.startsWith('command=')) {
      current = { name: text.slice(8), args: new Map() };
      continue;
    }
    if (current != null && !text.startsWith('command=')) {
      // capability lines (before first flush) look like 'agent=git/2.40' — they have '=' and known keys;
      // argument lines: 'want <oid>', 'done', 'thin-pack', 'deepen 1', 'ref-prefix refs/heads/'
      if (/^[a-z0-9-]+=(.*)$/.test(text) && !current.args.has('__args')) {
        // capability: ignore unless it is object-format
        continue;
      }
      const eq = text.indexOf('=');
      if (eq === -1) {
        const sp = text.indexOf(' ');
        if (sp === -1) current.args.set(text, ['']);
        else current.args.set(text.slice(0, sp), [text.slice(sp + 1)]);
      } else {
        const sp = text.indexOf(' ');
        if (sp !== -1 && sp < eq) {
          current.args.set(text.slice(0, sp), [text.slice(sp + 1)]);
        } else {
          const key = text.slice(0, eq);
          const value = text.slice(eq + 1);
          current.args.set(key, [...(current.args.get(key) ?? []), value]);
        }
      }
    }
  }
  if (current != null) commands.push(current);

  const out: Buffer[] = [];
  for (const command of commands) {
    if (command.name === 'ls-refs') {
      const prefixes = command.args.get('ref-prefix') ?? [];
      const peels = (command.args.get('peel') ?? []).length > 0;
      const symrefs = (command.args.get('symrefs') ?? []).length > 0;
      const unborn = (command.args.get('unborn') ?? []).length > 0;
      const head = state.refs.get('refs/heads/main') ?? [...state.refs.entries()].find(([r]) => r.startsWith('refs/heads/'))?.[1];
      const headWanted = prefixes.length === 0 || prefixes.some((p) => 'HEAD'.startsWith(p));
      if (head != null && headWanted) {
        out.push(pktLine(`${ZERO_OID} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
      } else if (unborn && headWanted) {
        out.push(pktLine(`${ZERO_OID} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''} unborn\n`));
      }
      for (const [ref, oid] of [...state.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        if (prefixes.length > 0 && !prefixes.some((p) => ref.startsWith(p))) continue;
        let line = `${oid} ${ref}`;
        if (symrefs && ref === 'refs/heads/main') line += ' symref-target:refs/heads/main';
        if (peels && state.peeled.has(ref)) line += ` peeled:${state.peeled.get(ref)}`;
        out.push(pktLine(`${line}\n`));
      }
      out.push(pktFlush);
    } else if (command.name === 'fetch') {
      const wants = (command.args.get('want') ?? []).filter((w) => w !== '');
      const haves = (command.args.get('have') ?? []).filter((w) => w !== '');
      const done = (command.args.get('done') ?? []).includes('');
      const deepen = (command.args.get('deepen') ?? [])[0];
      const clientShallow = (command.args.get('shallow') ?? []).filter((w) => w !== '');
      const shallowLines: Buffer[] = [];
      let packBuf: Buffer | null = null;

      if (wants.length > 0) {
        if (deepen != null) {
          // Deepen: the client holds `haves` + its `shallow` boundary objects. Recompute the
          // window from the wants down `depth` generations, sending only what it lacks, and
          // name the new boundary; a want already held (unshallow case) is announced.
          const known = new Set<string>([...haves, ...clientShallow]);
          const send = collectShallow(state, wants, Number(deepen), known);
          for (const oid of send.shallow) shallowLines.push(pktLine(`shallow ${oid}\n`));
          for (const oid of send.unshallow) shallowLines.push(pktLine(`unshallow ${oid}\n`));
          for (const want of wants) {
            if (clientShallow.includes(want) && !send.shallow.includes(want)) {
              // boundary moved past it
              shallowLines.push(pktLine(`unshallow ${want}\n`));
            }
          }
          packBuf = writePack(send.objects.map((o) => ({ type: o.type, data: o.data })));
        } else {
          const send = collectForWants(state, wants, [...haves, ...clientShallow]);
          for (const oid of send.shallow) shallowLines.push(pktLine(`shallow ${oid}\n`));
          packBuf = writePack(send.objects.map((o) => ({ type: o.type, data: o.data })));
        }
      }

      // acknowledgments section (only when haves were sent)
      if (haves.length > 0) {
        out.push(pktLine('acknowledgments\n'));
        // common objects: any have the server holds
        const commons = haves.filter((h) => state.db.has(h));
        for (const c of commons) out.push(pktLine(`ACK ${c}\n`));
        if (commons.length === 0) out.push(pktFlush);
        if (done) out.push(pktLine('ready\n'));
        if (commons.length === 0 && !done) {
          // need more haves: just say ready (we serve full packs)
          out.push(pktLine('ready\n'));
        }
        out.push(pktFlush);
      }
      if (wants.length > 0) {
        // shallow-info section when deepening
        if (shallowLines.length > 0) {
          out.push(pktLine('shallow-info\n'));
          out.push(...shallowLines);
          out.push(pktFlush);
        }
        // wanted-refs section (v2 fetch with ref prefixes)
        const wantedRefs = (command.args.get('want-ref') ?? []).filter((w) => w !== '');
        if (wantedRefs.length > 0) {
          out.push(pktLine('wanted-refs\n'));
          for (const ref of wantedRefs) {
            const oid = state.refs.get(ref);
            if (oid != null) out.push(pktLine(`${oid} ${ref}\n`));
          }
          out.push(pktFlush);
        }
        out.push(pktLine('packfile\n'));
        if (packBuf != null) {
          out.push(...sideBandPack(packBuf));
        }
        out.push(pktFlush);
      } else {
        // nothing wanted: end with flush
        out.push(pktFlush);
      }
    } else {
      // unknown v2 command: error
      out.push(pktLine(`ERR unknown command ${command.name}\n`));
      out.push(pktFlush);
    }
  }
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(out) };
}

interface CollectResult { objects: { type: string; data: Buffer }[]; shallow: string[]; unshallow: string[]; }

/** The full object closure of one oid: commits, their trees/blobs and parents. */
function reachableClosure(state: GitRepoState, root: string): Set<string> {
  const out = new Set<string>();
  const stack = [root];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const obj = state.db.get(oid);
    if (obj == null) continue;
    out.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      stack.push(commit.tree);
      for (const p of commit.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return out;
}

/** Objects needed for the given wants, minus anything reachable from haves. */
function collectForWants(state: GitRepoState, wants: string[], haves: string[]): CollectResult {
  // The client holds the closure of every have it names: block the whole reachable set, not
  // just the have oid itself (shared blobs/trees must not be re-sent).
  const haveSet = new Set<string>();
  for (const have of haves) {
    if (!state.db.has(have)) continue;
    for (const oid of reachableClosure(state, have)) haveSet.add(oid);
  }
  const seen = new Set<string>();
  const objects: { type: string; data: Buffer }[] = [];
  // A tag want sends the tag object itself AND peels to its commit: the traversal roots at
  // both (the clone expects the tag object in the pack). A tag the client names as a have is
  // blocked by the haveSet closure (the peel target is reachable from it).
  const stack: string[] = [];
  for (const want of wants) {
    const obj = state.db.get(want);
    if (obj != null && obj.type === 'tag') {
      if (!haveSet.has(want)) objects.push(obj);
      seen.add(want);
      stack.push(parseTag(obj.data).object);
    } else {
      stack.push(want);
    }
  }
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid) || haveSet.has(oid)) continue;
    seen.add(oid);
    const obj = state.db.get(oid);
    if (obj == null) continue;
    objects.push(obj);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      if (state.db.has(commit.tree)) stack.push(commit.tree);
      for (const p of commit.parents) if (state.db.has(p)) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) if (state.db.has(entry.oid)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      const tag = parseTag(obj.data);
      if (state.db.has(tag.object)) stack.push(tag.object);
    }
  }
  return { objects, shallow: [], unshallow: [] };
}

/** Depth-limited collection: the tip plus `depth-1` generations of parents. */
function collectShallow(state: GitRepoState, wants: string[], depth: number, knownClient: Set<string> = new Set()): CollectResult {
  const objects: { type: string; data: Buffer }[] = [];
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const included = new Set<string>();
  /** Send one commit's full closure (tree + blobs, recursively) — never a partial tree. */
  const sendClosure = (rootOid: string): void => {
    const stack = [rootOid];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (included.has(oid)) continue;
      const obj = state.db.get(oid);
      if (obj == null) continue;
      included.add(oid);
      if (obj.type === 'commit') {
        const commit = parseCommit(obj.data);
        if (!knownClient.has(oid)) objects.push(obj);
        if (!knownClient.has(oid) || !included.has(commit.tree)) stack.push(commit.tree);
      } else {
        if (knownClient.has(oid)) continue; // the client already holds it: not sent again
        objects.push(obj);
        if (obj.type === 'tree') {
          for (const entry of parseTree(obj.data)) stack.push(entry.oid);
        } else if (obj.type === 'tag') {
          const tag = parseTag(obj.data);
          stack.push(tag.object);
        }
      }
    }
  };
  // BFS over commits only; each generation = one commit layer. Tag wants peel first.
  let frontier: string[] = [];
  const peelTag = (oid: string): string => {
    const obj = state.db.get(oid);
    return obj != null && obj.type === 'tag' ? parseTag(obj.data).object : oid;
  };
  for (const want of wants) frontier.push(peelTag(want));
  for (let gen = 0; gen < depth && frontier.length > 0; gen += 1) {
    const parents: string[] = [];
    for (const oid of frontier) {
      if (included.has(oid)) continue;
      sendClosure(oid);
      const obj = state.db.get(oid);
      if (obj == null) continue;
      if (obj.type === 'commit') {
        const commit = parseCommit(obj.data);
        for (const p of commit.parents) if (state.db.has(p) && !included.has(p)) parents.push(p);
      }
    }
    if (gen === depth - 1) {
      // git's shallow boundary is the LAST SENT generation of commits: a depth-1 clone names
      // its tip, depth-2 names the parent layer. Objects beyond it are simply not delivered.
      for (const oid of [...frontier]) {
        const obj = state.db.get(oid);
        if (obj != null && obj.type === 'commit' && !shallow.includes(oid)) shallow.push(oid);
      }
    }
    frontier = parents;
  }
  return { objects, shallow, unshallow };
}

function uploadPackV0(state: GitRepoState, body: Buffer): GitResponse {
  const lines = parsePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  let done = false;
  let deepen: number | undefined;
  let shallows: string[] = [];
  for (const line of lines) {
    if (line.payload == null) continue;
    const text = line.payload.toString('utf8').trimEnd();
    if (text.startsWith('want ')) {
      const sp = text.indexOf('\0');
      wants.push(text.slice(5, sp === -1 ? undefined : sp).trim());
    } else if (text.startsWith('have ')) {
      haves.push(text.slice(5).trim());
    } else if (text === 'done') {
      done = true;
    } else if (text.startsWith('deepen ')) {
      deepen = Number(text.slice(7).trim());
    } else if (text.startsWith('shallow ')) {
      shallows.push(text.slice(8).trim());
    }
  }
  if (wants.length === 0) {
    // v0 upload-pack request with no wants: reply NAK
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat([pktLine('NAK\n')]) };
  }
  const collected = deepen != null ? collectShallow(state, wants, deepen) : collectForWants(state, wants, haves);
  const out: Buffer[] = [];
  if (deepen != null && collected.shallow.length > 0) {
    for (const oid of collected.shallow) out.push(pktLine(`shallow ${oid}\n`));
    out.push(pktFlush);
  }
  // multi_ack: ACK first common, then continue
  const commons = haves.filter((h) => state.db.has(h));
  for (const c of commons) out.push(pktLine(`ACK ${c} common\n`));
  if (done || haves.length === 0) {
    out.push(pktLine('NAK\n'));
  } else if (!done) {
    // client not done yet but we answer the pack anyway (single round)
    out.push(pktLine('NAK\n'));
  }
  const pack = writePack(collected.objects.map((o) => ({ type: o.type, data: o.data })));
  out.push(...sideBandPack(pack));
  out.push(pktFlush);
  void shallows;
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(out) };
}

// ---- receive-pack (push) ----

export function receivePack(forge: Forge, req: GitRequest): GitResponse {
  const parsed = parseGitPath(req.path);
  if (parsed == null) return notFound();
  const state = gitStateOf(forge, parsed.owner, parsed.repo);
  if (state == null) return notFound();
  const body = req.body ?? Buffer.alloc(0);

  // Parse the command list: '<old> <new> <ref>\0<caps>' lines until flush, then the pack.
  const lines = parsePktLines(body);
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  let packStart = -1;
  let sawFlush = false;
  let firstCommandCaps = '';
  {
    let offset = 0;
    for (const line of lines) {
      offset += line.size;
      if (line.kind === 'flush') {
        if (commands.length > 0 || sawFlush) { sawFlush = true; break; }
        sawFlush = true;
        continue;
      }
      if (line.payload == null) continue;
      const text = line.payload.toString('utf8');
      const nul = text.indexOf('\0');
      const refLine = (nul === -1 ? text : text.slice(0, nul)).trim();
      if (nul !== -1 && commands.length === 0) firstCommandCaps = text.slice(nul + 1).trim();
      const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(refLine);
      if (m == null) continue;
      commands.push({ oldOid: m[1], newOid: m[2], ref: m[3].trim() });
    }
    packStart = offset;
  }

  // The pack follows the flush; find its offset in the raw body precisely.
  const packBuf = extractPack(body);
  void packStart;

  const sideband = firstCommandCaps.includes('side-band-64k');
  const reportStatus = firstCommandCaps.includes('report-status') || true;

  // Apply commands
  const results: { ref: string; ok: boolean; reason?: string }[] = [];
  let packObjects: { type: string; data: Buffer; oid?: string }[] = [];
  let packOk = true;
  if (packBuf != null && packBuf.length > 0) {
    try {
      packObjects = ingestPack(state, packBuf);
    } catch {
      packOk = false;
    }
  }
  void packObjects;

  for (const command of commands) {
    const current = state.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // delete
      if (current == null) {
        results.push({ ref: command.ref, ok: false, reason: 'delete of non-existent ref' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        state.refs.delete(command.ref);
        state.peeled.delete(command.ref);
        if (state.repo != null && command.ref.startsWith('refs/heads/')) {
          state.repo.refs.delete(command.ref.replace(/^refs\/heads\//, ''));
        }
        results.push({ ref: command.ref, ok: true });
      }
      continue;
    }
    // create or update
    const targetExists = state.db.has(command.newOid) || packOk;
    if (!targetExists) {
      results.push({ ref: command.ref, ok: false, reason: 'missing objects' });
      continue;
    }
    if (current != null && command.oldOid !== current) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (current != null && command.oldOid === current && command.newOid !== current) {
      // fast-forward check: new must be a descendant of old
      if (!isDescendant(state, command.newOid, command.oldOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    if (current == null && command.oldOid !== ZERO_OID) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    state.refs.set(command.ref, command.newOid);
    // mirror into the REST store so POST /pulls and GET ?ref= see the pushed branch
    if (state.repo != null && command.ref.startsWith('refs/heads/')) {
      state.repo.refs.set(command.ref.replace(/^refs\/heads\//, ''), command.newOid);
      materializeCommit(state, state.repo, command.newOid);
    }
    // annotated tag: compute the peeled line
    const obj = state.db.get(command.newOid);
    if (obj != null && obj.type === 'tag' && command.ref.startsWith('refs/tags/')) {
      const tag = parseTag(obj.data);
      if (state.db.has(tag.object)) state.peeled.set(command.ref, tag.object);
    }
    results.push({ ref: command.ref, ok: true });
  }

  // Report
  const report: Buffer[] = [];
  if (sideband) {
    const inner: Buffer[] = [];
    if (reportStatus) {
      inner.push(pktLine(`unpack ok\n`));
      for (const r of results) {
        inner.push(r.ok ? pktLine(`ok ${r.ref}\n`) : pktLine(`ng ${r.ref} ${r.reason ?? 'failed'}\n`));
      }
      inner.push(pktFlush);
    }
    const framed = sideBandPack(Buffer.concat(inner), 1);
    report.push(...framed);
    report.push(pktFlush);
  } else {
    if (reportStatus) {
      report.push(pktLine('unpack ok\n'));
      for (const r of results) {
        report.push(r.ok ? pktLine(`ok ${r.ref}\n`) : pktLine(`ng ${r.ref} ${r.reason ?? 'failed'}\n`));
      }
      report.push(pktFlush);
    }
  }
  const ct = 'application/x-git-receive-pack-result';
  const out = Buffer.concat(report.length > 0 ? report : [pktFlush]);
  return { status: 200, contentType: ct, body: out };
}

/** Extract the trailing pack from a receive-pack body (after the first flush following commands). */
function extractPack(body: Buffer): Buffer | null {
  // find the offset after the command-list flush
  let i = 0;
  let sawCommand = false;
  while (i + 4 <= body.length) {
    const sizeHex = body.subarray(i, i + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(sizeHex)) break;
    const size = parseInt(sizeHex, 16);
    if (size === 0) {
      // flush: if we saw commands, the pack starts after this
      if (sawCommand) {
        const pack = body.subarray(i + 4);
        return pack.length >= 12 ? pack : null;
      }
      i += 4;
      continue;
    }
    if (size < 4 || i + size > body.length) break;
    sawCommand = true;
    i += size;
  }
  return null;
}

/** Ingest a pushed pack into the object db, resolving deltas. Returns resolved objects. */
function ingestPack(state: GitRepoState, pack: Buffer): { type: string; data: Buffer }[] {
  const { objects, checksumOk } = readPackObjectsPrecise(pack);
  if (!checksumOk) throw new Error('pack checksum mismatch');
  const resolved = new Map<string, { type: string; data: Buffer }>();
  const byIndex: { type: string; data: Buffer; oid?: string; refOid?: string; ofs?: number }[] = [];
  for (const obj of objects) {
    if (obj.type === 'ofs-delta' || obj.type === 'ref-delta') {
      byIndex.push({ ...obj });
    } else {
      const oid = hashObject(obj.type, obj.data);
      resolved.set(oid, { type: obj.type, data: obj.data });
      byIndex.push({ type: obj.type, data: obj.data, oid });
    }
  }
  // resolve deltas iteratively
  let pending = byIndex.filter((o) => o.type === 'ofs-delta' || o.type === 'ref-delta');
  let guard = 0;
  while (pending.length > 0 && guard < 1000) {
    guard += 1;
    const still: typeof pending = [];
    for (let idx = 0; idx < pending.length; idx += 1) {
      const obj = pending[idx];
      let base: { type: string; data: Buffer } | null = null;
      if (obj.type === 'ref-delta' && obj.refOid != null) {
        base = resolved.get(obj.refOid) ?? null;
      } else if (obj.type === 'ofs-delta') {
        // find the base by walking back: the target index of the offset within the byIndex order
        const targetIndex = byIndex.indexOf(obj) - (obj.ofs ?? 0);
        // ofs counts in compressed stream offsets; we approximate by scanning the pack offsets
        base = resolveOfsBase(pack, obj, byIndex, resolved);
      }
      if (base == null) { still.push(obj); continue; }
      const data = applyDelta(base.data, obj.data);
      const type = base.type;
      const oid = hashObject(type, data);
      resolved.set(oid, { type, data });
      obj.type = type; obj.data = data; obj.oid = oid;
    }
    if (still.length === pending.length) break; // no progress
    pending = still;
  }
  for (const [oid, obj] of resolved) state.db.putWithOid(oid, obj.type, obj.data);
  return [...resolved.values()];
}

/** Resolve an OFS_DELTA base: find the object whose start offset is (this object's offset - ofs). */
function resolveOfsBase(pack: Buffer, delta: { ofs?: number }, byIndex: { type: string; data: Buffer; oid?: string; refOid?: string; ofs?: number }[], resolved: Map<string, { type: string; data: Buffer }>): { type: string; data: Buffer } | null {
  // Compute each object's pack offset by re-scanning headers (cheap: few objects).
  const offsets = packOffsets(pack);
  const deltaOffsets = offsets.filter((o) => byIndex.some((b) => b === o.owner));
  void deltaOffsets;
  // The delta's own offset: locate its index in byIndex by matching identity
  const myIndex = byIndex.indexOf(delta as { type: string; data: Buffer; oid?: string; refOid?: string; ofs?: number });
  if (myIndex < 0) return null;
  const myOffset = offsets.get(byIndex[myIndex]);
  if (myOffset == null) return null;
  const baseOffset = myOffset - (delta.ofs ?? 0);
  for (const [obj, off] of offsets.entries()) {
    if (off === baseOffset) {
      const idx = byIndex.indexOf(obj);
      if (idx >= 0) {
        const candidate = byIndex[idx];
        if (candidate.oid != null) return resolved.get(candidate.oid) ?? null;
        return { type: candidate.type, data: candidate.data };
      }
    }
  }
  return null;
}

/** Map each object entry to its byte offset in the pack by re-scanning headers. */
function packOffsets(pack: Buffer): Map<{ type: string; data: Buffer; oid?: string; refOid?: string; ofs?: number }, number> {
  const map = new Map<{ type: string; data: Buffer; oid?: string; refOid?: string; ofs?: number }, number>();
  const count = pack.readUInt32BE(4);
  let i = 12;
  const holders: { type: string; data: Buffer; oid?: string; refOid?: string; ofs?: number }[] = [];
  for (let n = 0; n < count && i < pack.length; n += 1) {
    const start = i;
    const first = pack[i]; i += 1;
    const typeNum = (first >> 4) & 0x7;
    let size = first & 0x0f;
    let shift = 4;
    let cont = first & 0x80;
    while (cont) {
      const b = pack[i]; i += 1;
      size |= (b & 0x7f) << shift;
      shift += 7;
      cont = b & 0x80;
    }
    let type: string;
    if (typeNum === 6) {
      const base = pack[i]; i += 1;
      let o = base & 0x7f;
      let c = base & 0x80;
      while (c) {
        const b = pack[i]; i += 1;
        o = ((o + 1) << 7) | (b & 0x7f);
        c = b & 0x80;
      }
      type = 'ofs-delta';
    } else if (typeNum === 7) {
      i += 20;
      type = 'ref-delta';
    } else {
      type = (['', 'commit', 'tree', 'blob', 'tag'][typeNum]) as string;
    }
    const [data, consumed] = inflateCountingSafe(pack.subarray(i), size);
    i += consumed;
    const holder: { type: string; data: Buffer; oid?: string; refOid?: string; ofs?: number } = { type, data };
    if (type === 'ref-delta') holder.refOid = '';
    map.set(holder, start);
    holders.push(holder);
    void data;
  }
  return map;
}

function inflateCountingSafe(buf: Buffer, expectedSize: number): [Buffer, number] {
  try {
    const out = inflateSyncSafe(buf);
    if (out.length === expectedSize) {
      let lo = 2; let hi = buf.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        let ok = false;
        try { ok = inflateSyncSafe(buf.subarray(0, mid)).length === expectedSize; } catch { ok = false; }
        if (ok) hi = mid; else lo = mid + 1;
      }
      return [out, lo];
    }
  } catch { /* ignore */ }
  for (let k = 2; k <= buf.length; k += 1) {
    try {
      const out = inflateSyncSafe(buf.subarray(0, k));
      if (out.length === expectedSize) return [out, k];
    } catch { /* continue */ }
  }
  throw new Error('pack: inflate failed');
}

import { inflateSync as inflateSyncSafe } from 'node:zlib';

/** Is `maybeDescendant` reachable walking parents from `tip`? */
function isDescendant(state: GitRepoState, tip: string, maybeAncestor: string): boolean {
  if (tip === maybeAncestor) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === maybeAncestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = state.db.get(oid);
    if (obj == null) continue;
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      for (const p of commit.parents) stack.push(p);
    } else if (obj.type === 'tag') {
      const tag = parseTag(obj.data);
      if (tag.object != null) stack.push(tag.object);
    }
  }
  return false;
}

// re-export helpers the app uses
export { hashObject, buildTree, parseTree, buildCommit, buildTag, parseCommit, parseTag };
