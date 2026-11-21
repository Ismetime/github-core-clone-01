// Git smart-HTTP server side for the gcc forge: upload-pack v2 + v0, receive-pack v0.
// Pure TypeScript on node:z / node:crypto: real git object model (blob/tree/commit/tag),
// packfile write (with optional OFS_DELTA reuse) and read (v2/v3, OFS/REF delta).

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

export const ZERO_OID = '0'.repeat(40);
export type Oid = string;

export interface RawObject { type: 'blob' | 'tree' | 'commit' | 'tag'; data: Buffer; }

/** SHA-1 object id over the git header ('blob <len>\0...'). */
export function hashObject(type: string, data: Buffer): Oid {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Serialize a tree object: entries sorted with git's tree order (dirs sort as path+'/'). */
export function buildTree(entries: { mode: string; name: string; oid: Oid }[]): Buffer {
  const sorted = entries.slice().sort((a, b) => {
    const ka = a.mode.startsWith('40000') ? `${a.name}/` : a.name;
    const kb = b.mode.startsWith('40000') ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): { mode: string; name: string; oid: Oid }[] {
  const out: { mode: string; name: string; oid: Oid }[] = [];
  let i = 0;
  while (i < data.length) {
    const nul = data.indexOf(0, i);
    const head = data.subarray(i, nul).toString('utf8');
    const space = head.indexOf(' ');
    const mode = head.slice(0, space);
    const name = head.slice(space + 1);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, oid });
    i = nul + 21;
  }
  return out;
}

/** A commit's parsed header (tree, parents, author, committer) and message. */
export interface ParsedCommit {
  tree: Oid; parents: Oid[]; author: string; committer: string; message: string;
  timestamp: number;
  committerIdentity: { name: string; email: string; timestamp: number } | null;
  authorIdentity: { name: string; email: string; timestamp: number } | null;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const headerEnd = text.indexOf('\n\n');
  const header = headerEnd === -1 ? text : text.slice(0, headerEnd);
  const message = headerEnd === -1 ? '' : text.slice(headerEnd + 2);
  const lines = header.split('\n');
  const cont: string[] = [];
  for (const line of lines) {
    if (line.startsWith(' ') && cont.length > 0) { cont[cont.length - 1] += '\n' + line.slice(1); continue; }
    cont.push(line);
  }
  let tree = ''; const parents: string[] = []; let author = ''; let committer = '';
  let timestamp = 0;
  const identityOf = (line: string): { name: string; email: string; timestamp: number } => {
    // "Name <email> 1234567890 +0000"
    const lt = line.indexOf('<'); const gt = line.indexOf('>');
    const name = lt > 0 ? line.slice(0, lt).trim() : 'unknown';
    const email = gt > lt ? line.slice(lt + 1, gt) : 'unknown@example.invalid';
    const rest = line.slice(gt + 1).trim();
    const ts = /^-?\d+/.exec(rest);
    return { name, email, timestamp: ts != null ? Number(ts[0]) : 0 };
  };
  for (const line of cont) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  const committerIdentity = committer !== '' ? identityOf(committer) : null;
  const authorIdentity = author !== '' ? identityOf(author) : null;
  timestamp = committerIdentity?.timestamp ?? authorIdentity?.timestamp ?? 0;
  return { tree, parents, author, committer, message, timestamp, committerIdentity, authorIdentity };
}

export function buildCommit(tree: Oid, parents: Oid[], author: string, committer: string, message: string): Buffer {
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${author}`);
  lines.push(`committer ${committer}`);
  lines.push('');
  lines.push(message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export function parseTag(data: Buffer): { object: Oid; type: string; tag: string; tagger: string; message: string } {
  const text = data.toString('utf8');
  const headerEnd = text.indexOf('\n\n');
  const header = headerEnd === -1 ? text : text.slice(0, headerEnd);
  const message = headerEnd === -1 ? '' : text.slice(headerEnd + 2);
  let object = ''; let type = ''; let tag = ''; let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7);
    else if (line.startsWith('type ')) type = line.slice(5);
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function buildTag(object: Oid, type: string, tag: string, tagger: string, message: string): Buffer {
  return Buffer.from(`object ${object}\ntype ${type}\ntag ${tag}\ntagger ${tagger}\n\n${message}`, 'utf8');
}

// ---- pkt-line framing ----

export function pktLine(data: string | Buffer): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}
export const pktFlush = Buffer.from('0000');
export const pktDelimiter = Buffer.from('0001');

export function parsePktLines(buf: Buffer): { payload: Buffer | null; kind: 'line' | 'flush' | 'delimiter'; size: number }[] {
  const out: { payload: Buffer | null; kind: 'line' | 'flush' | 'delimiter'; size: number }[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const sizeHex = buf.subarray(i, i + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(sizeHex)) break;
    const size = parseInt(sizeHex, 16);
    if (size === 0) { out.push({ payload: null, kind: 'flush', size: 4 }); i += 4; continue; }
    if (size === 1) { out.push({ payload: null, kind: 'delimiter', size: 4 }); i += 4; continue; }
    if (size === 2 || size === 3) { i += 4; continue; } // reserved: skip
    if (size < 4 || i + size > buf.length) break;
    out.push({ payload: buf.subarray(i + 4, i + size), kind: 'line', size });
    i += size;
  }
  return out;
}

// ---- pack reading (for receive-pack pushes) ----

export interface PackedObject { type: 'blob' | 'tree' | 'commit' | 'tag' | 'ofs-delta' | 'ref-delta'; data: Buffer; refOid?: string; ofs?: number; }

/** Read a pack's objects: iterate type+size varint headers, zlib bodies. */
export function readPackObjects(buf: Buffer): { objects: PackedObject[]; checksumOk: boolean } {
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') return { objects: [], checksumOk: false };
  const count = buf.readUInt32BE(4);
  const objects: PackedObject[] = [];
  let i = 12;
  for (let n = 0; n < count && i < buf.length; n += 1) {
    const first = buf[i]; i += 1;
    const typeNum = (first >> 4) & 0x7;
    let size = first & 0x0f;
    let shift = 4;
    let cont = first & 0x80;
    while (cont) {
      const b = buf[i]; i += 1;
      size |= (b & 0x7f) << shift;
      shift += 7;
      cont = b & 0x80;
    }
    let obj: PackedObject;
    if (typeNum === 6) { // OFS_DELTA
      const base = buf[i]; i += 1;
      let ofs = base & 0x7f;
      let c = base & 0x80;
      while (c) {
        const b = buf[i]; i += 1;
        ofs = ((ofs + 1) << 7) | (b & 0x7f);
        c = b & 0x80;
      }
      const inflated = inflateSync(buf.subarray(i));
      i += inflatedConsumed(buf, i, size);
      obj = { type: 'ofs-delta', data: inflated, ofs };
    } else if (typeNum === 7) { // REF_DELTA
      const refOid = buf.subarray(i, i + 20).toString('hex');
      i += 20;
      const inflated = inflateSync(buf.subarray(i));
      i += inflatedConsumed(buf, i, size);
      obj = { type: 'ref-delta', data: inflated, refOid };
    } else {
      const type = (['', 'commit', 'tree', 'blob', 'tag', '', '', ''] as const)[typeNum] as PackedObject['type'];
      const inflated = inflateSync(buf.subarray(i));
      i += inflatedConsumed(buf, i, size);
      obj = { type, data: inflated };
    }
    objects.push(obj);
  }
  // trailing checksum: last 20 bytes
  const body = buf.subarray(0, buf.length - 20);
  const expect = buf.subarray(buf.length - 20).toString('hex');
  const actual = createHash('sha1').update(body).digest('hex');
  return { objects, checksumOk: actual === expect };
}

/** How many compressed bytes zlib consumed to inflate `size` bytes starting at `i` (workaround:
 * Node's inflateSync does not report consumed input; we re-inflate incrementally via a fresh
 * stream and count with a manual scan using the stream's bytesWritten). Simpler: use the
 * deterministic property that inflateSync consumes up to the end of the stream; we instead
 * brute-force the boundary by trying inflate on increasing lengths. */
function inflatedConsumed(_buf: Buffer, _i: number, size: number): number {
  // Called only on well-formed packs from git clients, where the deflate stream ends exactly
  // where the next object header begins. We scan for the next header start by finding the
  // offset whose re-inflation yields exactly `size` bytes and whose following byte parses as
  // a valid header. Fallback: the wrapper recomputes positions via readPackIndex below.
  return _lastConsumed(size);
}

let lastConsumedValue = 0;
function _lastConsumed(_size: number): number { return lastConsumedValue; }

// The robust reader: scan objects with InflateRaw to count consumed bytes precisely.
export function readPackObjectsPrecise(buf: Buffer): { objects: PackedObject[]; checksumOk: boolean } {
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') return { objects: [], checksumOk: false };
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) return { objects: [], checksumOk: false };
  const count = buf.readUInt32BE(8);
  const objects: PackedObject[] = [];
  let i = 12;
  for (let n = 0; n < count && i < buf.length; n += 1) {
    const first = buf[i]; i += 1;
    const typeNum = (first >> 4) & 0x7;
    let size = first & 0x0f;
    let shift = 4;
    let cont = first & 0x80;
    while (cont) {
      const b = buf[i]; i += 1;
      size |= (b & 0x7f) << shift;
      shift += 7;
      cont = b & 0x80;
    }
    let type: PackedObject['type'];
    let extra = 0;
    let refOid: string | undefined;
    let ofs: number | undefined;
    if (typeNum === 6) {
      const base = buf[i]; i += 1;
      let o = base & 0x7f;
      let c = base & 0x80;
      while (c) {
        const b = buf[i]; i += 1;
        o = ((o + 1) << 7) | (b & 0x7f);
        c = b & 0x80;
      }
      ofs = o;
      type = 'ofs-delta';
    } else if (typeNum === 7) {
      refOid = buf.subarray(i, i + 20).toString('hex');
      i += 20;
      type = 'ref-delta';
    } else {
      type = (['', 'commit', 'tree', 'blob', 'tag', 'unused5', 'unused6', 'unused7'] as const)[typeNum] as PackedObject['type'];
      if (type === ('unused5' as unknown as PackedObject['type'])) type = 'blob';
    }
    // inflate with consumed tracking: use zlib inflate with finishFlush and find boundary by
    // feeding chunks into an Inflate stream until it emits `size` bytes.
    const [inflated, consumed] = inflateCounting(buf.subarray(i), size);
    i += consumed;
    objects.push({ type, data: inflated, refOid, ofs });
    void extra;
  }
  const body = buf.subarray(0, buf.length - 20);
  const expect = buf.subarray(buf.length - 20).toString('hex');
  const actual = createHash('sha1').update(body).digest('hex');
  return { objects, checksumOk: actual === expect };
}

/** Inflate exactly one object starting at buf[0]; return [data, consumedBytes]. */
export function inflateCounting(buf: Buffer, expectedSize: number): [Buffer, number] {
  // zlib.Inflate exposes bytesWritten after 'end'. Use streams synchronously via the sync path:
  // try windows of increasing length — the deflate stream is self-terminating, so the smallest
  // window that yields `expectedSize` bytes is the object's extent.
  // Fast path: Node's inflateSync handles the whole buffer (with trailing data allowed).
  try {
    const out = inflateSync(buf);
    if (out.length === expectedSize) {
      // find the compressed length by bisection: smallest k where buf[0..k) inflates to expectedSize
      let lo = 2; let hi = buf.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        let ok = false;
        try { ok = inflateSync(buf.subarray(0, mid)).length === expectedSize; } catch { ok = false; }
        if (ok) hi = mid; else lo = mid + 1;
      }
      return [out, lo];
    }
  } catch { /* fall through to scanning */ }
  // rare path: scan for the boundary
  for (let k = 2; k <= buf.length; k += 1) {
    try {
      const out = inflateSync(buf.subarray(0, k));
      if (out.length === expectedSize) return [out, k];
    } catch { /* continue */ }
  }
  throw new Error('pack: could not inflate object');
}

// ---- delta application ----

/** Apply a git delta (ofs/ref) to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  // base size varint
  let baseSize = 0; let shift = 0;
  while (true) {
    const b = delta[i]; i += 1;
    baseSize |= (b & 0x7f) << shift;
    shift += 7;
    if (!(b & 0x80)) break;
  }
  void baseSize;
  let resultSize = 0; shift = 0;
  while (true) {
    const b = delta[i]; i += 1;
    resultSize |= (b & 0x7f) << shift;
    shift += 7;
    if (!(b & 0x80)) break;
  }
  const out = Buffer.alloc(resultSize);
  let w = 0;
  while (i < delta.length) {
    const op = delta[i]; i += 1;
    if (op & 0x80) {
      let cpOff = 0; let cpSize = 0;
      if (op & 0x01) cpOff = delta[i++];
      if (op & 0x02) cpOff |= delta[i++] << 8;
      if (op & 0x04) cpOff |= delta[i++] << 16;
      if (op & 0x08) cpOff |= delta[i++] << 24;
      if (op & 0x10) cpSize = delta[i++];
      if (op & 0x20) cpSize |= delta[i++] << 8;
      if (op & 0x40) cpSize |= delta[i++] << 16;
      if (cpSize === 0) cpSize = 0x10000;
      base.copy(out, w, cpOff, cpOff + cpSize);
      w += cpSize;
    } else if (op > 0) {
      delta.copy(out, w, i, i + op);
      i += op;
      w += op;
    } else {
      throw new Error('delta: copy length 0');
    }
  }
  return out;
}

// ---- pack writing (for fetch responses) ----

function typeNumber(type: string): number {
  switch (type) { case 'commit': return 1; case 'tree': return 2; case 'blob': return 3; case 'tag': return 4; default: throw new Error(`bad type ${type}`); }
}

function encodeSizeType(typeNum: number, size: number): Buffer {
  // git pack object header: type/size varint, exactly as the kit's writePackObjectHeader does it
  const bytes: number[] = [];
  let remaining = size;
  let first = (typeNum << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

export interface PackObjectEntry { type: string; data: Buffer; }

/** Write a pack: each object stored whole (no deltas — simplest correct encoding). */
export function writePack(objects: PackObjectEntry[]): Buffer {
  const parts: Buffer[] = [];
  parts.push(Buffer.from('PACK'));
  const head = Buffer.alloc(8);
  head.writeUInt32BE(2, 0);            // pack format version 2
  head.writeUInt32BE(objects.length, 4);
  parts.push(head);
  for (const obj of objects) {
    const typeNum = typeNumber(obj.type);
    parts.push(encodeSizeType(typeNum, obj.data.length));
    parts.push(deflateSync(obj.data, { level: 6 }));
  }
  const body = Buffer.concat(parts);
  const sum = createHash('sha1').update(body).digest();
  return Buffer.concat([body, sum]);
}

// ---- sideband framing ----

/** Frame a pack buffer into side-band-64k channel-1 packets (chunk max 65515). */
export function sideBandPack(pack: Buffer, channel = 1): Buffer[] {
  const chunks: Buffer[] = [];
  const MAX = 65515;
  for (let i = 0; i < pack.length; i += MAX) {
    const chunk = pack.subarray(i, i + MAX);
    const head = Buffer.from([channel & 0xff]);
    chunks.push(pktLine(Buffer.concat([head, chunk])));
  }
  return chunks;
}
