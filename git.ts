// git.ts — the forge's own git object model and packfile codec, written for git-forge-core.
//
// Everything here is implemented from the git object format itself, on node:crypto (SHA-1)
// and node:zlib only: blobs, trees, commits and tags; packfiles version 2 with OFS_DELTA and
// REF_DELTA resolution; the pkt-line framing the smart-HTTP protocol speaks. No git binary is
// ever spawned and no other module is imported.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);

const TYPE_NUMBERS: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUMBER_TYPES: readonly GitObjectType[] = ['', 'commit', 'tree', 'blob', 'tag', '', '', ''] as unknown as readonly GitObjectType[];

/** The SHA-1 object id of a typed payload, exactly as git computes it ("<type> <len>\0" + data). */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** An in-memory object database for one repository. */
export class ObjectStore {
  readonly objects = new Map<string, GitObject>();

  put(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  putObject(oid: string, type: GitObjectType, data: Buffer): void {
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
  }

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  has(oid: string): boolean {
    return this.objects.has(oid);
  }
}

// -------------------------------------------------------------------------------------------------
// Trees, commits, tags
// -------------------------------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's raw bytes into its entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree ordering: names compare bytewise, directories as if their name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' || entry.mode === '040000' ? `${entry.name}/` : entry.name;
}

/** Serialize tree entries (any order in, git's order out). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object: headers, blank line, then the message. */
export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit object from its parts. */
export function buildCommit(view: CommitView): Buffer {
  const lines = [`tree ${view.tree}`];
  for (const parent of view.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${view.author}`);
  lines.push(`committer ${view.committer}`);
  const message = view.message.endsWith('\n') ? view.message : `${view.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

/** The commit a tag object points at, peeling tag-of-tag chains through the store. */
export function peelToCommit(store: ObjectStore, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = store.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
    if (match === null) return null;
    current = match[1];
  }
  return null;
}

/** The object a tag peels to for advertisement purposes (one step of `^{}`), or null. */
export function peelTagOnce(store: ObjectStore, oid: string): string | null {
  const object = store.get(oid);
  if (object === undefined || object.type !== 'tag') return null;
  const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
  return match === null ? null : match[1];
}

// -------------------------------------------------------------------------------------------------
// pkt-line framing
// -------------------------------------------------------------------------------------------------

/** Encode one pkt-line: a 4-hex length prefix (counting itself) plus the payload. */
export function encodePkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export interface DecodedPacket {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/**
 * Decode pkt-lines from `offset` until a flush packet or the end of the buffer. Returns the
 * packets and the offset just past the flush (where a packfile, if any, begins).
 */
export function decodePkts(buffer: Buffer, offset = 0): { packets: DecodedPacket[]; end: number } {
  const packets: DecodedPacket[] = [];
  let at = offset;
  while (at + 4 <= buffer.length) {
    const header = buffer.subarray(at, at + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      at += 4;
      return { packets, end: at };
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      at += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      at += 4;
      continue;
    }
    if (length < 4 || at + length > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(at + 4, at + length) });
    at += length;
  }
  return { packets, end: at };
}

// -------------------------------------------------------------------------------------------------
// Packfiles
// -------------------------------------------------------------------------------------------------

/** Encode the variable-length object header a pack entry starts with. */
function packEntryHeader(type: GitObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let value = size;
  let first = (TYPE_NUMBERS[type] << 4) | (value & 0x0f);
  value >>= 4;
  if (value > 0) first |= 0x80;
  bytes.push(first);
  while (value > 0) {
    let byte = value & 0x7f;
    value >>= 7;
    if (value > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Build a complete packfile (header, plain objects, SHA-1 trailer) from resolved objects. */
export function writePack(objects: readonly (GitObject & { oid: string })[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packEntryHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Apply a git delta payload to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset];
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset];
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset |= delta[offset] << (8 * bit);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          copySize |= delta[offset] << (8 * bit);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op > 0) {
      out.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

/**
 * The exact compressed length of the zlib stream starting at `offset`: inflateSync tolerates
 * trailing bytes but refuses a truncated stream, so the smallest prefix that inflates is the
 * stream's own length. Found by binary search.
 */
function zlibStreamLength(buffer: Buffer, offset: number): number {
  const remaining = buffer.length - offset;
  let low = 1;
  let high = remaining;
  // First prove the whole remainder inflates; then narrow to the smallest working prefix.
  inflateSync(buffer.subarray(offset));
  while (low < high) {
    const mid = (low + high) >> 1;
    try {
      inflateSync(buffer.subarray(offset, offset + mid));
      high = mid;
    } catch {
      low = mid + 1;
    }
  }
  return low;
}

interface RawPackEntry {
  type: GitObjectType | 'ofs-delta' | 'ref-delta';
  data: Buffer;
  baseOid?: string;
  baseOffset?: number;
  start: number;
}

/**
 * Read a packfile and resolve every object in it. `externalBase` supplies objects the pack
 * deltas against but does not carry (a thin pack's bases, from the receiving store).
 */
export function readPack(
  pack: Buffer,
  externalBase: (oid: string) => GitObject | undefined = () => undefined,
): (GitObject & { oid: string })[] {
  if (pack.length < 12 + 20 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const raw: RawPackEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = offset;
    let byte = pack[offset];
    offset += 1;
    const typeNumber = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let type: RawPackEntry['type'];
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (typeNumber === 6) {
      type = 'ofs-delta';
      byte = pack[offset];
      offset += 1;
      let back = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset];
        offset += 1;
        back = ((back + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = start - back;
    } else if (typeNumber === 7) {
      type = 'ref-delta';
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else {
      type = NUMBER_TYPES[typeNumber];
      if (type === '' || type === undefined) throw new Error(`bad pack object type ${typeNumber}`);
    }
    const compressedLength = zlibStreamLength(pack, offset);
    const data = inflateSync(pack.subarray(offset, offset + compressedLength));
    if (data.length !== size) throw new Error('pack object size mismatch');
    offset += compressedLength;
    raw.push({ type, data, baseOid, baseOffset, start });
  }

  const byStart = new Map<number, number>();
  raw.forEach((entry, index) => byStart.set(entry.start, index));
  const resolved: (GitObject & { oid: string })[] = new Array(raw.length);
  const resolving = new Set<number>();
  const resolve = (index: number): GitObject & { oid: string } => {
    const done = resolved[index];
    if (done !== undefined) return done;
    if (resolving.has(index)) throw new Error('delta cycle in pack');
    resolving.add(index);
    const entry = raw[index];
    let object: GitObject;
    if (entry.type === 'ofs-delta' || entry.type === 'ref-delta') {
      let base: GitObject | undefined;
      if (entry.type === 'ofs-delta') {
        const baseIndex = byStart.get(entry.baseOffset ?? -1);
        if (baseIndex === undefined) throw new Error('ofs-delta base is not in the pack');
        base = resolve(baseIndex);
      } else {
        const baseOid = entry.baseOid ?? '';
        base = externalBase(baseOid);
        if (base === undefined) {
          // The base may be a plain entry of this same pack: resolve candidates lazily by hash.
          for (let candidateIndex = 0; candidateIndex < raw.length; candidateIndex += 1) {
            const candidate = raw[candidateIndex];
            if (candidate.type === 'ofs-delta' || candidate.type === 'ref-delta') continue;
            if (hashObject(candidate.type as GitObjectType, candidate.data) === baseOid) {
              base = resolve(candidateIndex);
              break;
            }
          }
        }
        if (base === undefined) throw new Error(`ref-delta base ${baseOid} is unavailable`);
      }
      const data = applyDelta(base.data, entry.data);
      object = { type: base.type, data };
    } else {
      object = { type: entry.type as GitObjectType, data: entry.data };
    }
    const withId = { ...object, oid: hashObject(object.type, object.data) };
    resolved[index] = withId;
    resolving.delete(index);
    return withId;
  };
  for (let index = 0; index < raw.length; index += 1) resolve(index);
  return resolved;
}

// -------------------------------------------------------------------------------------------------
// Reachability
// -------------------------------------------------------------------------------------------------

/** Every object reachable from `tips` (commits walk their parents, trees recurse, tags peel). */
export function collectReachable(store: ObjectStore, tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      const target = peelTagOnce(store, oid);
      if (target !== null) stack.push(target);
    }
  }
  return seen;
}

/** True when `ancestor` is `descendant` itself or one of its ancestors. */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

/** The best common ancestor of two commits, or null when their histories do not meet. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const ancestorsOfA = new Map<string, number>();
  let frontier = [a];
  let distance = 0;
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (ancestorsOfA.has(oid)) continue;
      ancestorsOfA.set(oid, distance);
      const object = store.get(oid);
      if (object !== undefined && object.type === 'commit') next.push(...parseCommit(object.data).parents);
    }
    frontier = next;
    distance += 1;
  }
  const seen = new Set<string>();
  frontier = [b];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (ancestorsOfA.has(oid)) return oid;
      const object = store.get(oid);
      if (object !== undefined && object.type === 'commit') next.push(...parseCommit(object.data).parents);
    }
    frontier = next;
  }
  return null;
}

/** Flatten a tree (recursively) into a path -> entry map. */
export function flattenTree(store: ObjectStore, treeOid: string): Map<string, TreeEntry> {
  const out = new Map<string, TreeEntry>();
  const walk = (oid: string, prefix: string): void => {
    const object = store.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '40000' || entry.mode === '040000') walk(entry.oid, `${prefix}${entry.name}/`);
      else out.set(`${prefix}${entry.name}`, entry);
    }
  };
  walk(treeOid, '');
  return out;
}

/** Rebuild a tree hierarchy from a flattened path map; returns the root tree's oid. */
export function buildTreeFromFlat(store: ObjectStore, flat: ReadonlyMap<string, TreeEntry>): string {
  interface Node {
    files: Map<string, TreeEntry>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index];
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name) as Node;
    }
    node.files.set(segments[segments.length - 1], entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return store.put('tree', buildTree(entries));
  };
  return build(root);
}
