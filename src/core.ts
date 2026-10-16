import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type Hash = string;
export type Tree = Record<string, Hash>;
type BlobObject = { kind: 'blob'; data: string };
type TreeObject = { kind: 'tree'; files: Tree };
export type Snapshot = {
  kind: 'snapshot'; parallel: string; seq: number; root: Hash;
  parents: Hash[]; seed: Hash | null; createdAt: string;
};
type ObjectValue = BlobObject | TreeObject | Snapshot;
export type State = { format: 1; active: string; heads: Record<string, Hash> };
export type Change = { path: string; base: Hash | null; left: Hash | null; right: Hash | null;
  outcome: Hash | null; conflict: boolean };
export type Candidate = { ref: string; hash: Hash | null; origin: string };
export type Composition = { base: Hash; left: Hash; right: Hash; changes: Change[];
  conflicts: Change[]; result: Tree; touched: number; clean: number; percentage: number };

const metaDir = '.pvc';
const hexRe = /^[a-f0-9]{64}$/;
const nameRe = /^[a-zA-Z][a-zA-Z0-9._-]*$/;
const ignored = new Set(['.pvc', '.git', 'node_modules']);

export class VcsError extends Error { constructor(message: string) { super(message); this.name = 'VcsError'; } }
export const short = (hash: Hash | null) => hash ? hash.slice(0, 10) : '∅';

function hashBytes(bytes: Uint8Array): Hash { return createHash('sha256').update(bytes).digest('hex'); }
function sortedTree(files: Tree): Tree {
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b, 'en')));
}
function same(a: Hash | undefined, b: Hash | undefined): boolean { return a === b; }
function exists(file: string): boolean { return fs.existsSync(file); }
function lstatMaybe(file: string): fs.Stats | null {
  try { return fs.lstatSync(file); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export class Repo {
  readonly root: string;
  readonly meta: string;
  constructor(directory: string = process.cwd()) {
    let dir = path.resolve(directory);
    while (!exists(path.join(dir, metaDir))) {
      const p = path.dirname(dir);
      if (p === dir) throw new VcsError('リポジトリではないよ: pvc init を実行してね');
      dir = p;
    }
    this.root = dir;
    this.meta = path.join(dir, metaDir);
  }

  static init(directory: string = process.cwd()): Repo {
    const root = path.resolve(directory);
    if (exists(path.join(root, metaDir))) throw new VcsError('すでに初期化済み');
    fs.mkdirSync(path.join(root, metaDir, 'objects'), { recursive: true });
    const repo = new Repo(root);
    const tree = repo.writeTree({});
    const s0 = repo.writeSnapshot('main', 0, tree, [], null);
    repo.saveState({ format: 1, active: 'main', heads: { main: s0 } });
    return repo;
  }

  get state(): State {
    let state: State;
    try { state = JSON.parse(fs.readFileSync(path.join(this.meta, 'state.json'), 'utf8')); }
    catch { throw new VcsError('state.json を読み込めない'); }
    if (state.format !== 1 || !state.heads || !state.active) throw new VcsError('無効なstate.json');
    return state;
  }
  saveState(state: State): void {
    const tmp = path.join(this.meta, `state.${process.pid}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    fs.renameSync(tmp, path.join(this.meta, 'state.json'));
  }
  private objectPath(id: Hash): string {
    if (!hexRe.test(id)) throw new VcsError(`無効なハッシュ: ${id}`);
    return path.join(this.meta, 'objects', id.slice(0, 2), id.slice(2));
  }
  put(value: ObjectValue): Hash {
    const bytes = Buffer.from(JSON.stringify(value));
    const id = hashBytes(bytes);
    const filename = this.objectPath(id);
    if (!exists(filename)) {
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, bytes, { flag: 'wx' });
    }
    return id;
  }
  get(id: Hash): ObjectValue {
    let bytes: Buffer;
    try { bytes = fs.readFileSync(this.objectPath(id)); }
    catch { throw new VcsError(`CASオブジェクトが見つからない: ${short(id)}`); }
    if (hashBytes(bytes) !== id) throw new VcsError(`CAS破損: ${short(id)}`);
    const obj: ObjectValue = JSON.parse(bytes.toString('utf8'));
    if (!['blob', 'tree', 'snapshot'].includes(obj.kind)) throw new VcsError('不明なCASオブジェクト');
    return obj;
  }
  blob(bytes: Uint8Array): Hash { return this.put({ kind: 'blob', data: Buffer.from(bytes).toString('base64') }); }
  readBlob(id: Hash): Buffer {
    const obj = this.get(id);
    if (obj.kind !== 'blob') throw new VcsError('blobではない');
    return Buffer.from(obj.data, 'base64');
  }
  writeTree(files: Tree): Hash { return this.put({ kind: 'tree', files: sortedTree(files) }); }
  readTree(id: Hash): Tree {
    const o = this.get(id);
    if (o.kind !== 'tree') throw new VcsError('treeではない');
    return { ...o.files };
  }
  writeSnapshot(parallel: string, seq: number, root: Hash, parents: Hash[], seed: Hash | null): Hash {
    return this.put({ kind: 'snapshot', parallel, seq, root, parents, seed, createdAt: new Date().toISOString() });
  }
  snapshot(id: Hash): Snapshot {
    const o = this.get(id);
    if (o.kind !== 'snapshot') throw new VcsError(`snapshotではない: ${short(id)}`);
    return o;
  }
  treeAt(ref: string): Tree { return this.readTree(this.snapshot(this.resolve(ref)).root); }
  head(parallel?: string): Hash {
    const state = this.state;
    const name = parallel || state.active;
    if (!(name in state.heads)) throw new VcsError(`存在しないParallel: ${name}`);
    return state.heads[name];
  }
  resolve(ref: string): Hash {
    const s = this.state;
    if (ref === 'HEAD' || ref === '@') return this.head();
    if (ref in s.heads) return s.heads[ref];
    const m = /^(.+)@(\d+)$/.exec(ref);
    if (m) {
      if (!(m[1] in s.heads)) throw new VcsError(`存在しないParallel: ${m[1]}`);
      const seq = Number(m[2]);
      let id = s.heads[m[1]];
      for (;;) {
        const snap = this.snapshot(id);
        if (snap.seq === seq && snap.parallel === m[1]) return id;
        if (snap.seq < seq || !snap.parents.length) break;
        id = snap.parents[0];
      }
      throw new VcsError(`Snapshotが見つからない: ${ref}`);
    }
    if (/^[a-f0-9]{7,64}$/.test(ref)) {
      const matches: Hash[] = [];
      const directory = path.join(this.meta, 'objects');
      for (const folder of fs.readdirSync(directory)) {
        if (!/^[a-f0-9]{2}$/.test(folder)) continue;
        for (const suffix of fs.readdirSync(path.join(directory, folder))) {
          const id = folder + suffix;
          if (id.startsWith(ref) && this.get(id).kind === 'snapshot') matches.push(id);
        }
      }
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) throw new VcsError('Snapshotハッシュが曖昧');
    }
    throw new VcsError(`参照が見つからない: ${ref}`);
  }
  lineage(parallel?: string): Array<{ id: Hash; snapshot: Snapshot }> {
    let id = this.head(parallel);
    const result = [];
    for (;;) {
      const snapshot = this.snapshot(id);
      result.push({ id, snapshot });
      if (snapshot.parents.length === 0) break;
      id = snapshot.parents[0];
    }
    return result;
  }
  fork(name: string, from: string = 'HEAD'): Hash {
    if (!nameRe.test(name) || name.includes('@')) throw new VcsError('Parallel名は英数字・.-_のみで先頭は英字');
    const state = this.state;
    if (name in state.heads) throw new VcsError(`既存のParallel: ${name}`);
    const source = this.resolve(from);
    const root = this.snapshot(source).root;
    const s0 = this.writeSnapshot(name, 0, root, [], source);
    state.heads[name] = s0;
    this.saveState(state);
    return s0;
  }

  // Root-relative POSIX paths only. Never trust a user-supplied absolute/parent path.
  normalize(input: string): string {
    const target = path.resolve(this.root, input);
    const rel = path.relative(this.root, target).split(path.sep).join('/');
    if (rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) throw new VcsError(`パスがリポジトリ外: ${input}`);
    if (rel.split('/').some(p => ignored.has(p))) throw new VcsError(`除外されたパス: ${input}`);
    return rel || '.';
  }
  private safeFile(relative: string): string {
    const rel = this.normalize(relative);
    if (rel === '.') throw new VcsError('ファイル名として . は使えない');
    let current = this.root;
    for (const part of rel.split('/')) {
      current = path.join(current, part);
      if (lstatMaybe(current)?.isSymbolicLink()) throw new VcsError(`symlinkは非対応: ${rel}`);
    }
    return current;
  }
  private walk(relative = '.'): string[] {
    const absolute = path.join(this.root, relative);
    if (!lstatMaybe(absolute)) return [];
    if (fs.lstatSync(absolute).isSymbolicLink()) throw new VcsError(`symlinkは非対応: ${relative}`);
    if (fs.statSync(absolute).isFile()) return [relative];
    if (!fs.statSync(absolute).isDirectory()) return [];
    const out: string[] = [];
    for (const name of fs.readdirSync(absolute).sort()) {
      if (ignored.has(name)) continue;
      const child = relative === '.' ? name : `${relative}/${name}`;
      out.push(...this.walk(child));
    }
    return out;
  }
  private fileHash(relative: string): Hash | null {
    const full = this.safeFile(relative);
    if (!exists(full)) return null;
    if (!fs.statSync(full).isFile()) throw new VcsError(`通常ファイルではない: ${relative}`);
    return this.blob(fs.readFileSync(full));
  }
  private liveBlob(relative: string): Buffer | null {
    const full = this.safeFile(relative);
    return exists(full) && fs.statSync(full).isFile() ? fs.readFileSync(full) : null;
  }
  private equalsLive(relative: string, hash: Hash | undefined): boolean {
    const current = this.liveBlob(relative);
    if (!hash) return current === null;
    return current !== null && current.equals(this.readBlob(hash));
  }
  status(): { modified: string[]; deleted: string[]; untracked: string[] } {
    const tracked = this.treeAt('HEAD');
    const files = this.walk();
    const modified = Object.keys(tracked).filter(p => !this.equalsLive(p, tracked[p]) && this.liveBlob(p) !== null);
    const deleted = Object.keys(tracked).filter(p => this.liveBlob(p) === null);
    const untracked = files.filter(p => !(p in tracked));
    return { modified, deleted, untracked };
  }
  private assertClean(): void {
    const s = this.status();
    if (s.modified.length || s.deleted.length) throw new VcsError(`未Shotの変更があるため操作を中止: ${[...s.modified, ...s.deleted].join(', ')}`);
  }
  shot(paths: string[], all = false): { id: Hash | null; changed: string[] } {
    if (!all && paths.length === 0) throw new VcsError('pvc shot <path...> か pvc shot -A');
    const state = this.state;
    const prevId = this.head();
    const prev = this.snapshot(prevId);
    const oldTree = this.readTree(prev.root);
    const tree: Tree = Object.assign(Object.create(null), oldTree);
    const selected = new Set<string>();
    if (all) {
      for (const p of Object.keys(oldTree)) selected.add(p);
      for (const p of this.walk()) selected.add(p);
    } else {
      for (const input of paths) {
        const rel = this.normalize(input);
        if (rel === '.') {
          for (const p of Object.keys(oldTree)) selected.add(p);
          for (const p of this.walk()) selected.add(p);
        } else {
          for (const p of Object.keys(oldTree)) if (p === rel || p.startsWith(`${rel}/`)) selected.add(p);
          for (const p of this.walk(rel)) selected.add(p);
          if (!selected.has(rel) && !Object.keys(oldTree).some(p => p.startsWith(`${rel}/`))) selected.add(rel);
        }
      }
    }
    for (const p of selected) {
      const newBlob = this.fileHash(p);
      if (newBlob === null) delete tree[p];
      else tree[p] = newBlob;
    }
    const changed = [...selected].filter(p => !same(oldTree[p], tree[p])).sort();
    if (!changed.length) return { id: null, changed: [] };
    const root = this.writeTree(tree);
    const id = this.writeSnapshot(state.active, prev.seq + 1, root, [prevId], null);
    state.heads[state.active] = id;
    this.saveState(state);
    return { id, changed };
  }
  move(source: string, destination: string): { id: Hash | null; changed: string[] } {
    const from = this.normalize(source);
    const to = this.normalize(destination);
    if (from === '.' || to === '.' || from === to) throw new VcsError('moveのファイル指定が無効');
    const tracked = this.treeAt('HEAD');
    if (!(from in tracked)) throw new VcsError(`未追跡ファイルはmoveできない: ${from}`);
    const src = this.safeFile(from);
    const dst = this.safeFile(to);
    if (!exists(src) || !fs.statSync(src).isFile() || !this.equalsLive(from, tracked[from])) {
      throw new VcsError(`move元に未Shotの変更がある: ${from}`);
    }
    if (exists(dst) || to in tracked) throw new VcsError(`move先が既に存在する: ${to}`);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.renameSync(src, dst);
    try { return this.shot([from, to]); }
    catch (error) { fs.renameSync(dst, src); throw error; }
  }

  // Validate before modifying anything so an untracked file cannot be destroyed on switch/compose.
  private applyTree(from: Tree, to: Tree): void {
    this.assertClean();
    const changes = [...new Set([...Object.keys(from), ...Object.keys(to)])].filter(p => from[p] !== to[p]);
    for (const rel of changes) {
      const full = this.safeFile(rel);
      if (!(rel in from) && exists(full)) throw new VcsError(`未追跡ファイルを上書きできない: ${rel}`);
      if (rel in to && exists(full) && !fs.statSync(full).isFile()) throw new VcsError(`通常ファイルではない: ${rel}`);
    }
    // Delete first, then write, supporting a file replaced by a directory and vice versa.
    for (const rel of changes) {
      const full = this.safeFile(rel);
      if (exists(full) && rel in from) fs.unlinkSync(full);
    }
    for (const rel of changes) {
      if (!(rel in to)) continue;
      const full = this.safeFile(rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, this.readBlob(to[rel]));
    }
  }
  switch(name: string): Hash {
    const state = this.state;
    if (!(name in state.heads)) throw new VcsError(`存在しないParallel: ${name}`);
    if (state.active === name) return this.head();
    const from = this.treeAt('HEAD');
    const to = this.readTree(this.snapshot(state.heads[name]).root);
    this.applyTree(from, to);
    state.active = name;
    this.saveState(state);
    return state.heads[name];
  }

  private ancestors(id: Hash): Map<Hash, number> {
    const distances = new Map<Hash, number>([[id, 0]]);
    const queue: Hash[] = [id];
    for (let i = 0; i < queue.length; i++) {
      const current = queue[i];
      const snap = this.snapshot(current);
      for (const prev of [...snap.parents, ...(snap.seed ? [snap.seed] : [])]) {
        if (distances.has(prev)) continue;
        distances.set(prev, distances.get(current)! + 1);
        queue.push(prev);
      }
    }
    return distances;
  }
  mergeBase(a: Hash, b: Hash): Hash {
    const left = this.ancestors(a);
    const right = this.ancestors(b);
    const common = [...left.keys()].filter(id => right.has(id));
    if (!common.length) throw new VcsError('共通祖先が存在しないためComposeできない');
    // A distance heuristic can silently choose a wrong base in criss-cross histories.
    // Use maximal common ancestors instead; reject ambiguity until virtual bases exist.
    const ancestryCache = new Map<Hash, Map<Hash, number>>();
    const isAncestor = (descendant: Hash, ancestor: Hash): boolean => {
      if (!ancestryCache.has(descendant)) ancestryCache.set(descendant, this.ancestors(descendant));
      return ancestryCache.get(descendant)!.has(ancestor);
    };
    const maximal = common.filter(id => !common.some(other => other !== id && isAncestor(other, id)));
    if (maximal.length !== 1) {
      throw new VcsError(`共通祖先が複数ある (${maximal.map(short).join(', ')})。仮想Baseの計算は未実装`);
    }
    return maximal[0];
  }
  compare(left: Hash, right: Hash): Composition {
    const base = this.mergeBase(left, right);
    const b = this.readTree(this.snapshot(base).root);
    const l = this.readTree(this.snapshot(left).root);
    const r = this.readTree(this.snapshot(right).root);
    const result: Tree = Object.assign(Object.create(null), l);
    const changes: Change[] = [];
    const keys = [...new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])].sort();
    for (const name of keys) {
      const bv = b[name], lv = l[name], rv = r[name];
      if (lv === bv && rv === bv) continue;
      const conflict = lv !== rv && lv !== bv && rv !== bv;
      const outcome = conflict || rv === bv ? lv : rv;
      changes.push({ path: name, base: bv || null, left: lv || null, right: rv || null,
        outcome: outcome || null, conflict });
      if (outcome) result[name] = outcome;
      else delete result[name];
    }
    const conflicts = changes.filter(c => c.conflict);
    return { base, left, right, changes, conflicts, result, touched: changes.length,
      clean: changes.length - conflicts.length,
      percentage: changes.length === 0 ? 100 : 100 * (changes.length - conflicts.length) / changes.length };
  }
  candidates(composition: Composition, file: string): Candidate[] {
    const conflict = composition.conflicts.find(c => c.path === file);
    if (!conflict) throw new VcsError(`競合パスではない: ${file}`);
    const output: Candidate[] = [];
    const seen = new Set<string>();
    const add = (ref: string, hash: Hash | null, origin: string) => {
      const key = hash || '∅';
      if (seen.has(key)) return;
      seen.add(key);
      output.push({ ref, hash, origin });
    };
    add('base', conflict.base, '共通祖先');
    add('left', conflict.left, '合成先');
    add('right', conflict.right, '合成元');
    const history = new Set([...this.ancestors(composition.left).keys(), ...this.ancestors(composition.right).keys()]);
    for (const id of history) {
      const snap = this.snapshot(id);
      const hash = this.readTree(snap.root)[file] || null;
      add(`${snap.parallel}@${snap.seq}`, hash, `履歴 ${short(id)}`);
    }
    return output;
  }
  compose(sourceRef: string, into?: string, resolutions: Record<string, string> = {}, dryRun = false):
    { composition: Composition; unresolved: string[]; id: Hash | null } {
    const state = this.state;
    const parallel = into || state.active;
    const left = this.head(parallel);
    const right = this.resolve(sourceRef);
    const comp = this.compare(left, right);
    const unresolved: string[] = [];
    for (const conflict of comp.conflicts) {
      const selection = resolutions[conflict.path];
      if (!selection) { unresolved.push(conflict.path); continue; }
      let outcome: Hash | null;
      if (selection === 'left') outcome = conflict.left;
      else if (selection === 'right') outcome = conflict.right;
      else if (selection === 'base') outcome = conflict.base;
      else {
        const choiceId = this.resolve(selection);
        const ancestry = new Set([...this.ancestors(left).keys(), ...this.ancestors(right).keys()]);
        if (!ancestry.has(choiceId)) throw new VcsError(`競合候補は合成元の履歴内から選んでね: ${selection}`);
        outcome = this.readTree(this.snapshot(choiceId).root)[conflict.path] || null;
      }
      if (outcome) comp.result[conflict.path] = outcome;
      else delete comp.result[conflict.path];
    }
    if (unresolved.length || dryRun) return { composition: comp, unresolved, id: null };
    if (left === right) return { composition: comp, unresolved, id: null };
    const old = this.readTree(this.snapshot(left).root);
    if (parallel === state.active) this.applyTree(old, comp.result);
    const root = this.writeTree(comp.result);
    const seq = this.snapshot(left).seq + 1;
    const id = this.writeSnapshot(parallel, seq, root, [left, right], null);
    state.heads[parallel] = id;
    this.saveState(state);
    return { composition: comp, unresolved, id };
  }
  diff(a: string, b: string): Array<{ path: string; before: Hash | null; after: Hash | null; status: string }> {
    const x = this.treeAt(a), y = this.treeAt(b);
    return [...new Set([...Object.keys(x), ...Object.keys(y)])].sort().filter(p => x[p] !== y[p]).map(p => ({
      path: p, before: x[p] || null, after: y[p] || null,
      status: !x[p] ? 'A' : !y[p] ? 'D' : 'M',
    }));
  }
}
