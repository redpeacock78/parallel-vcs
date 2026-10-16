import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type Hash = string;
export type Tree = Record<string, Hash>;
type BlobObject = { kind: "blob"; data: string };
type TreeObject = { kind: "tree"; files: Tree };
export type Snapshot = {
  kind: "snapshot";
  parallel: string;
  seq: number;
  root: Hash;
  parents: Hash[];
  seed: Hash | null;
  createdAt: string;
};
type ObjectValue = BlobObject | TreeObject | Snapshot;
type TransactionPhase = "preparing" | "ready" | "committed" | "rollingBack" | "rolledBack";
type TransactionEntry = {
  relative: string;
  temporary: string;
  index: number;
  hadOld: boolean;
  oldHash: Hash | null;
  newHash: Hash | null;
};
type TransactionJournal = {
  format: 1;
  ownerPid: number;
  phase: TransactionPhase;
  oldState: State;
  entries: TransactionEntry[];
};
type WorktreeTransaction = { commit(): void; rollback(): void };
type RepositoryLock = { directory: string; preserve(): void; release(): void };
type LockOwner = { format: 1; pid: number };
export type State = { format: 1; active: string; heads: Record<string, Hash> };
export type Change = {
  path: string;
  base: Hash | null;
  left: Hash | null;
  right: Hash | null;
  outcome: Hash | null;
  conflict: boolean;
};
export type Candidate = { ref: string; hash: Hash | null; origin: string };
export type Composition = {
  base: Hash;
  left: Hash;
  right: Hash;
  changes: Change[];
  conflicts: Change[];
  result: Tree;
  touched: number;
  clean: number;
  percentage: number;
};

const metaDir = ".pvc";
const hexRe = /^[a-f0-9]{64}$/;
const nameRe = /^[a-zA-Z][a-zA-Z0-9._-]*$/;
const windowsReservedNameRe = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i;
const ignored = new Set([".pvc", ".git", "node_modules"]);

export class VcsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VcsError";
  }
}
export const short = (hash: Hash | null) => hash ? hash.slice(0, 10) : "∅";

function hashBytes(bytes: Uint8Array): Hash {
  return createHash("sha256").update(bytes).digest("hex");
}
function hashBlob(bytes: Uint8Array): Hash {
  return hashBytes(Buffer.from(JSON.stringify({ kind: "blob", data: Buffer.from(bytes).toString("base64") })));
}
function sortedTree(files: Tree): Tree {
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b, "en")));
}
function same(a: Hash | undefined, b: Hash | undefined): boolean {
  return a === b;
}
function exists(file: string): boolean {
  return fs.existsSync(file);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isValidTreePath(filePath: string): boolean {
  const parts = filePath.split("/");
  return Boolean(filePath) && filePath !== "."
    && !path.posix.isAbsolute(filePath) && !path.win32.isAbsolute(filePath)
    && path.win32.parse(filePath).root === ""
    && !filePath.includes("\0") && !filePath.includes("\\")
    && path.posix.normalize(filePath) === filePath
    && !parts.some(part => {
      const deviceName = part.split(".", 1)[0].replace(/[ .]+$/g, "");
      return !part || part.length > 255 || part === "." || part === ".." || ignored.has(part.toLowerCase())
        || /[<>:"|?*\u0000-\u001f]/.test(part) || /[. ]$/.test(part)
        || windowsReservedNameRe.test(deviceName);
    });
}
function windowsCaseKey(value: string): string {
  let key = "";
  for (const character of value) {
    const uppercase = character.toUpperCase();
    key += [...uppercase].length === 1 ? uppercase : character;
  }
  return key;
}
function treePathCollisions(filePaths: Iterable<string>): string[] {
  const byCaseFoldedPath = new Map<string, string>();
  const collisions: string[] = [];
  for (const filePath of filePaths) {
    if (!isValidTreePath(filePath)) continue;
    const key = windowsCaseKey(filePath);
    const previous = byCaseFoldedPath.get(key);
    if (previous) collisions.push(`case-insensitive path collision between ${previous} and ${filePath}`);
    else byCaseFoldedPath.set(key, filePath);
  }
  for (const filePath of byCaseFoldedPath.values()) {
    let parent = path.posix.dirname(filePath);
    while (parent !== "." && parent !== "/") {
      const parentFile = byCaseFoldedPath.get(windowsCaseKey(parent));
      if (parentFile) collisions.push(`file/directory collision between ${parentFile} and ${filePath}`);
      parent = path.posix.dirname(parent);
    }
  }
  return collisions;
}
function lstatMaybe(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
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
      if (p === dir) throw new VcsError("リポジトリではないよ: pvc init を実行してね");
      dir = p;
    }
    this.root = dir;
    this.meta = path.join(dir, metaDir);
    this.cleanAbandonedLockClaims();
    this.recoverTransactions();
  }

  private transactionDirectory(): string {
    return path.join(this.meta, "txn-active");
  }
  private readLockOwner(filename: string): LockOwner | null {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(filename, "utf8"));
      if (!value || typeof value !== "object") return null;
      const owner = value as Partial<LockOwner>;
      if (owner.format !== 1 || !Number.isInteger(owner.pid) || owner.pid! <= 0) return null;
      return owner as LockOwner;
    } catch {
      return null;
    }
  }
  private cleanAbandonedLockClaims(): void {
    for (
      const name of fs.readdirSync(this.meta).filter(item =>
        item.startsWith("txn-claim-") || item.startsWith("txn-release-")
      )
    ) {
      const directory = path.join(this.meta, name);
      const stat = lstatMaybe(directory);
      if (!stat?.isDirectory() || stat.isSymbolicLink()) continue;
      const owner = this.readLockOwner(path.join(directory, "owner.json"));
      if (owner && !this.processIsAlive(owner.pid)) fs.rmSync(directory, { recursive: true, force: true });
    }
  }
  private retireTransactionDirectory(directory: string): void {
    const retired = path.join(this.meta, `txn-release-${process.pid}-${randomUUID()}`);
    fs.renameSync(directory, retired);
    fs.rmSync(retired, { recursive: true, force: true });
  }
  private acquireWriteLock(): RepositoryLock {
    const directory = this.transactionDirectory();
    const claim = fs.mkdtempSync(path.join(this.meta, `txn-claim-${process.pid}-`));
    try {
      fs.writeFileSync(
        path.join(claim, "owner.json"),
        `${JSON.stringify({ format: 1, pid: process.pid } satisfies LockOwner)}\n`,
        { flag: "wx" },
      );
      fs.renameSync(claim, directory);
    } catch (error) {
      fs.rmSync(claim, { recursive: true, force: true });
      if (!exists(directory)) throw error;
      const owner = this.readLockOwner(path.join(directory, "owner.json"));
      const detail = owner ? ` (pid ${owner.pid})` : "";
      throw new VcsError(`別のpvc処理がリポジトリを更新中${detail}`);
    }
    let preserve = false;
    return {
      directory,
      preserve: () => {
        preserve = true;
      },
      release: () => {
        if (!preserve) this.retireTransactionDirectory(directory);
      },
    };
  }
  private withWriteLock<T>(operation: (lock: RepositoryLock) => T): T {
    const lock = this.acquireWriteLock();
    try {
      return operation(lock);
    } finally {
      lock.release();
    }
  }

  private writeTransactionJournal(directory: string, journal: TransactionJournal): void {
    const filename = path.join(directory, "journal.json");
    const temporary = path.join(directory, `journal-${randomUUID()}.tmp`);
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(journal, null, 2)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, filename);
  }
  private processIsAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return false;
      if (code === "EPERM") return true;
      throw error;
    }
  }
  private validateJournal(value: unknown): TransactionJournal {
    if (!value || typeof value !== "object") throw new VcsError("transaction journalの形式が無効");
    const journal = value as Partial<TransactionJournal>;
    const phases: TransactionPhase[] = ["preparing", "ready", "committed", "rollingBack", "rolledBack"];
    if (
      journal.format !== 1 || !Number.isInteger(journal.ownerPid) || journal.ownerPid! <= 0
      || !journal.phase || !phases.includes(journal.phase) || !Array.isArray(journal.entries)
    ) {
      throw new VcsError("transaction journalの形式が無効");
    }
    const state = journal.oldState as State | undefined;
    if (
      !state || state.format !== 1 || typeof state.active !== "string" || !nameRe.test(state.active)
      || state.active.includes("@") || !state.heads
      || typeof state.heads !== "object" || Array.isArray(state.heads) || !(state.active in state.heads)
      || Object.entries(state.heads).some(([name, id]) =>
        !nameRe.test(name) || name.includes("@") || typeof id !== "string" || !hexRe.test(id)
      )
    ) {
      throw new VcsError("transaction journalの旧stateが無効");
    }
    const paths = new Set<string>();
    const indices = new Set<number>();
    for (const entry of journal.entries) {
      if (
        !entry || typeof entry !== "object" || typeof entry.relative !== "string"
        || typeof entry.temporary !== "string"
        || !Number.isInteger(entry.index) || entry.index < 0 || entry.index >= journal.entries.length
        || typeof entry.hadOld !== "boolean"
        || !(entry.oldHash === null || (typeof entry.oldHash === "string" && hexRe.test(entry.oldHash)))
        || !(entry.newHash === null || (typeof entry.newHash === "string" && hexRe.test(entry.newHash)))
        || (entry.oldHash === null && entry.newHash === null) || entry.hadOld !== (entry.oldHash !== null)
      ) {
        throw new VcsError("transaction journalのentryが無効");
      }
      if (
        this.normalize(entry.relative) !== entry.relative || entry.relative === "."
        || this.normalize(entry.temporary) !== entry.temporary || entry.temporary === "."
        || path.posix.dirname(entry.temporary) !== path.posix.dirname(entry.relative)
        || entry.temporary === entry.relative || paths.has(entry.relative) || indices.has(entry.index)
      ) {
        throw new VcsError("transaction journalのpath/indexが無効");
      }
      paths.add(entry.relative);
      indices.add(entry.index);
    }
    return journal as TransactionJournal;
  }
  private restoreTransactionFiles(directory: string, entries: TransactionEntry[]): void {
    const paths = entries.map(entry => entry.relative);
    for (const entry of entries) {
      const full = this.safeFile(entry.relative);
      const stat = lstatMaybe(full);
      if (!stat || stat.isDirectory()) continue;
      if (!stat.isFile()) throw new VcsError(`復旧対象が通常ファイルではない: ${entry.relative}`);
      const current = hashBlob(fs.readFileSync(full));
      if (current !== entry.oldHash && current !== entry.newHash) {
        throw new VcsError(`中断後に復旧対象が変更されている: ${entry.relative}`);
      }
    }
    for (const entry of entries) this.removeTransactionFile(entry.temporary);
    for (const relative of paths) this.removeTransactionFile(relative);
    this.pruneEmptyParents([...paths, ...entries.map(entry => entry.temporary)]);
    for (const entry of entries) {
      if (!entry.hadOld) continue;
      const backup = path.join(directory, "old", String(entry.index));
      if (!exists(backup)) throw new VcsError(`復旧用ファイルが見つからない: ${entry.relative}`);
      const backupStat = fs.lstatSync(backup);
      if (!backupStat.isFile() || backupStat.isSymbolicLink()) {
        throw new VcsError(`復旧用ファイルが無効: ${entry.relative}`);
      }
      if (hashBlob(fs.readFileSync(backup)) !== entry.oldHash) {
        throw new VcsError(`復旧用ファイルが破損: ${entry.relative}`);
      }
      const destination = this.safeFile(entry.relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const temporary = this.safeFile(entry.temporary);
      fs.copyFileSync(backup, temporary, fs.constants.COPYFILE_EXCL);
      fs.renameSync(temporary, destination);
    }
  }
  private recoverTransactions(): void {
    const directory = this.transactionDirectory();
    if (!exists(directory)) return;
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new VcsError("transaction slotが無効");

    const owner = this.readLockOwner(path.join(directory, "owner.json"));
    if (!owner) throw new VcsError(`transaction slotのownerが無効。内容を確認してから削除してね: ${directory}`);
    if (this.processIsAlive(owner.pid)) {
      throw new VcsError(`別のpvc処理がリポジトリを更新中: pid ${owner.pid}`);
    }

    const recoveryLock = path.join(directory, "recovery.lock");
    try {
      fs.mkdirSync(recoveryLock);
    } catch {
      const recoveryOwner = this.readLockOwner(path.join(recoveryLock, "owner.json"));
      const detail = recoveryOwner
        ? `pid ${recoveryOwner.pid} が復旧中`
        : "復旧lockが残っている";
      throw new VcsError(`${detail}。復旧が中断している場合は ${recoveryLock} を削除して再実行してね`);
    }
    const journalPath = path.join(directory, "journal.json");
    try {
      fs.writeFileSync(
        path.join(recoveryLock, "owner.json"),
        `${JSON.stringify({ format: 1, pid: process.pid } satisfies LockOwner)}\n`,
        { flag: "wx" },
      );
      if (!exists(journalPath)) {
        this.retireTransactionDirectory(directory);
        return;
      }
      if (!fs.lstatSync(journalPath).isFile()) throw new VcsError(`transaction journalが無効: ${directory}`);

      let journal: TransactionJournal;
      try {
        journal = this.validateJournal(JSON.parse(fs.readFileSync(journalPath, "utf8")));
      } catch (error) {
        throw new VcsError(`transaction journalを読めない: ${String(error)}`);
      }
      if (owner.pid !== journal.ownerPid) throw new VcsError(`transaction ownerが一致しない: ${directory}`);

      if (journal.phase === "ready" || journal.phase === "rollingBack") {
        try {
          this.restoreTransactionFiles(directory, journal.entries);
          this.saveState(journal.oldState);
          journal.phase = "rolledBack";
          this.writeTransactionJournal(directory, journal);
        } catch (error) {
          throw new VcsError(`transactionの自動復旧に失敗。復旧データを保持: ${directory} (${String(error)})`);
        }
      } else if (journal.phase !== "preparing" && journal.phase !== "committed" && journal.phase !== "rolledBack") {
        throw new VcsError(`transaction phaseが不明: ${journal.phase}`);
      }
      this.retireTransactionDirectory(directory);
    } catch (error) {
      if (exists(recoveryLock)) fs.rmSync(recoveryLock, { recursive: true, force: true });
      throw error;
    }
  }

  static init(directory: string = process.cwd()): Repo {
    const root = path.resolve(directory);
    if (exists(path.join(root, metaDir))) throw new VcsError("すでに初期化済み");
    fs.mkdirSync(path.join(root, metaDir, "objects"), { recursive: true });
    const repo = new Repo(root);
    const tree = repo.writeTree({});
    const s0 = repo.writeSnapshot("main", 0, tree, [], null);
    repo.saveState({ format: 1, active: "main", heads: { main: s0 } });
    return repo;
  }

  get state(): State {
    let state: State;
    try {
      state = JSON.parse(fs.readFileSync(path.join(this.meta, "state.json"), "utf8"));
    } catch {
      throw new VcsError("state.json を読み込めない");
    }
    if (state.format !== 1 || !state.heads || !state.active) throw new VcsError("無効なstate.json");
    return state;
  }
  saveState(state: State): void {
    const tmp = path.join(this.meta, `state.${process.pid}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    fs.renameSync(tmp, path.join(this.meta, "state.json"));
  }
  private objectPath(id: Hash): string {
    if (!hexRe.test(id)) throw new VcsError(`無効なハッシュ: ${id}`);
    return path.join(this.meta, "objects", id.slice(0, 2), id.slice(2));
  }
  put(value: ObjectValue): Hash {
    const bytes = Buffer.from(JSON.stringify(value));
    const id = hashBytes(bytes);
    const filename = this.objectPath(id);
    if (!exists(filename)) {
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      const temporaryDirectory = path.join(this.meta, "object-temp");
      fs.mkdirSync(temporaryDirectory, { recursive: true });
      const temporary = path.join(temporaryDirectory, `${process.pid}-${randomUUID()}.tmp`);
      try {
        fs.writeFileSync(temporary, bytes, { flag: "wx" });
        if (!exists(filename)) fs.renameSync(temporary, filename);
      } finally {
        if (exists(temporary)) fs.rmSync(temporary, { force: true });
      }
    }
    return id;
  }
  get(id: Hash): ObjectValue {
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(this.objectPath(id));
    } catch {
      throw new VcsError(`CASオブジェクトが見つからない: ${short(id)}`);
    }
    if (hashBytes(bytes) !== id) throw new VcsError(`CAS破損: ${short(id)}`);
    const obj: ObjectValue = JSON.parse(bytes.toString("utf8"));
    if (!["blob", "tree", "snapshot"].includes(obj.kind)) throw new VcsError("不明なCASオブジェクト");
    return obj;
  }
  verify(): { objectCount: number; errors: string[] } {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.verificationHasActiveTransaction()) {
        return { objectCount: 0, errors: ["repository is being updated; retry verification"] };
      }
      const before = this.readStateForVerification();
      const report = this.verifyUnlocked();
      if (this.verificationHasActiveTransaction()) {
        return { ...report, errors: [...report.errors, "repository is being updated; retry verification"] };
      }
      const after = this.readStateForVerification();
      if (this.sameStateForVerification(before, after)) return report;
      if (attempt === 1) {
        return { ...report, errors: [...report.errors, "repository changed during verification; please retry"] };
      }
    }
    return { objectCount: 0, errors: ["repository changed during verification; please retry"] };
  }
  private verificationHasActiveTransaction(): boolean {
    try {
      return lstatMaybe(this.transactionDirectory()) !== null;
    } catch {
      return true;
    }
  }
  private readStateForVerification(): { bytes: Buffer | null; error: string | null } {
    try {
      return { bytes: fs.readFileSync(path.join(this.meta, "state.json")), error: null };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return { bytes: null, error: code || String(error) };
    }
  }
  private sameStateForVerification(
    left: { bytes: Buffer | null; error: string | null },
    right: { bytes: Buffer | null; error: string | null },
  ): boolean {
    if (left.error !== right.error) return false;
    if (left.bytes === null || right.bytes === null) return left.bytes === right.bytes;
    return left.bytes.equals(right.bytes);
  }
  private verifyUnlocked(): { objectCount: number; errors: string[] } {
    const errors: string[] = [];
    const objects = new Map<Hash, ObjectValue>();
    const types = new Map<Hash, ObjectValue["kind"]>();
    let objectCount = 0;
    const objectDirectory = path.join(this.meta, "objects");
    let directoryStat: fs.Stats | null = null;
    let directoryStatFailed = false;
    try {
      directoryStat = lstatMaybe(objectDirectory);
    } catch (error) {
      directoryStatFailed = true;
      errors.push(`.pvc/objects: cannot inspect CAS object directory (${String(error)})`);
    }
    if (!directoryStatFailed && (!directoryStat || !directoryStat.isDirectory() || directoryStat.isSymbolicLink())) {
      errors.push(".pvc/objects: CAS object directory is missing or invalid");
    } else if (directoryStat) {
      let buckets: fs.Dirent[] = [];
      try {
        buckets = fs.readdirSync(objectDirectory, { withFileTypes: true });
      } catch (error) {
        errors.push(`.pvc/objects: cannot enumerate object buckets (${String(error)})`);
      }
      for (const bucket of buckets) {
        const bucketPath = path.join(objectDirectory, bucket.name);
        if (
          !bucket.isDirectory() || bucket.isSymbolicLink() || bucket.name.length !== 2
          || !/^[a-f0-9]{2}$/.test(bucket.name)
        ) {
          errors.push(`${path.relative(this.meta, bucketPath)}: invalid object bucket`);
          continue;
        }
        let files: fs.Dirent[];
        try {
          files = fs.readdirSync(bucketPath, { withFileTypes: true });
        } catch (error) {
          errors.push(`${path.relative(this.meta, bucketPath)}: cannot enumerate object bucket (${String(error)})`);
          continue;
        }
        for (const file of files) {
          const filePath = path.join(bucketPath, file.name);
          const relativePath = path.relative(this.meta, filePath).split(path.sep).join("/");
          if (!file.isFile() || file.isSymbolicLink() || file.name.length !== 62 || !/^[a-f0-9]{62}$/.test(file.name)) {
            errors.push(`${relativePath}: invalid object entry`);
            continue;
          }
          objectCount++;
          const id = bucket.name + file.name;
          let bytes: Buffer;
          try {
            bytes = fs.readFileSync(filePath);
          } catch (error) {
            errors.push(`${relativePath}: cannot read object (${String(error)})`);
            continue;
          }
          if (hashBytes(bytes) !== id) {
            errors.push(`${relativePath}: CAS hash mismatch`);
            continue;
          }
          let value: unknown;
          try {
            value = JSON.parse(bytes.toString("utf8"));
          } catch (error) {
            errors.push(`${relativePath}: invalid JSON (${String(error)})`);
            continue;
          }
          if (!isRecord(value) || !["blob", "tree", "snapshot"].includes(String(value.kind))) {
            errors.push(`${relativePath}: unknown CAS object format`);
            continue;
          }

          if (value.kind === "blob") {
            if (
              typeof value.data !== "string"
              || Buffer.from(value.data, "base64").toString("base64") !== value.data
            ) {
              errors.push(`${relativePath}: invalid blob data`);
              continue;
            }
            objects.set(id, value as unknown as BlobObject);
            types.set(id, "blob");
          } else if (value.kind === "tree") {
            if (!isRecord(value.files)) {
              errors.push(`${relativePath}: tree files must be an object`);
              continue;
            }
            let valid = true;
            for (const [filePath, blobId] of Object.entries(value.files)) {
              if (!isValidTreePath(filePath)) {
                errors.push(`${relativePath}: invalid tree path ${JSON.stringify(filePath)}`);
                valid = false;
              }
              if (typeof blobId !== "string" || !hexRe.test(blobId)) {
                errors.push(`${relativePath}: invalid blob reference for ${JSON.stringify(filePath)}`);
                valid = false;
              }
            }
            for (const collision of treePathCollisions(Object.keys(value.files))) {
              errors.push(`${relativePath}: ${collision}`);
              valid = false;
            }
            if (!valid) continue;
            objects.set(id, value as unknown as TreeObject);
            types.set(id, "tree");
          } else {
            if (
              typeof value.parallel !== "string" || !nameRe.test(value.parallel) || value.parallel.includes("@")
              || !Number.isSafeInteger(value.seq) || (value.seq as number) < 0
              || typeof value.root !== "string" || !hexRe.test(value.root)
              || !Array.isArray(value.parents) || value.parents.length > 2
              || value.parents.some(parent => typeof parent !== "string" || !hexRe.test(parent))
              || !(value.seed === null || (typeof value.seed === "string" && hexRe.test(value.seed)))
              || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
            ) {
              errors.push(`${relativePath}: invalid snapshot format`);
              continue;
            }
            objects.set(id, value as unknown as Snapshot);
            types.set(id, "snapshot");
          }
        }
      }
    }

    const requireType = (id: string, type: ObjectValue["kind"], location: string): ObjectValue | undefined => {
      if (types.get(id) !== type) {
        errors.push(`${location}: referenced ${type} ${short(id)} is missing or has the wrong type`);
        return undefined;
      }
      return objects.get(id);
    };
    for (const [id, object] of objects) {
      if (object.kind === "tree") {
        for (const [filePath, blobId] of Object.entries(object.files)) {
          requireType(blobId, "blob", `tree ${short(id)} (${filePath})`);
        }
      } else if (object.kind === "snapshot") {
        requireType(object.root, "tree", `snapshot ${short(id)} root`);
        for (const [index, parentId] of object.parents.entries()) {
          requireType(parentId, "snapshot", `snapshot ${short(id)} parent ${index + 1}`);
        }
        if (object.seed) requireType(object.seed, "snapshot", `snapshot ${short(id)} seed`);

        if (!object.parents.length) {
          if (object.seq !== 0) errors.push(`snapshot ${short(id)}: parentless snapshot must have seq 0`);
          if (object.seed) {
            const seed = objects.get(object.seed);
            if (seed?.kind === "snapshot" && seed.root !== object.root) {
              errors.push(`snapshot ${short(id)}: seed and snapshot trees differ`);
            }
          }
        } else {
          if (object.seed !== null) errors.push(`snapshot ${short(id)}: only a parentless snapshot can have a seed`);
          const parent = objects.get(object.parents[0]);
          if (parent?.kind === "snapshot") {
            if (parent.parallel !== object.parallel) {
              errors.push(`snapshot ${short(id)}: first parent belongs to another Parallel`);
            }
            if (parent.seq + 1 !== object.seq) {
              errors.push(`snapshot ${short(id)}: sequence does not follow its first parent`);
            }
          }
          if (object.parents.length === 2 && object.parents[0] === object.parents[1]) {
            errors.push(`snapshot ${short(id)}: duplicate parents`);
          }
        }
      }
    }

    let state: unknown;
    try {
      state = JSON.parse(fs.readFileSync(path.join(this.meta, "state.json"), "utf8"));
    } catch (error) {
      errors.push(`.pvc/state.json: cannot read state (${String(error)})`);
      return { objectCount, errors };
    }
    if (
      !isRecord(state) || state.format !== 1 || typeof state.active !== "string"
      || !isRecord(state.heads) || !nameRe.test(state.active) || state.active.includes("@")
      || !Object.hasOwn(state.heads, state.active)
    ) {
      errors.push(".pvc/state.json: invalid state format");
      return { objectCount, errors };
    }
    for (const [name, id] of Object.entries(state.heads)) {
      if (!nameRe.test(name) || name.includes("@") || typeof id !== "string" || !hexRe.test(id)) {
        errors.push(`.pvc/state.json: invalid head entry ${JSON.stringify(name)}`);
        continue;
      }
      const head = requireType(id, "snapshot", `.pvc/state.json head ${name}`);
      if (head?.kind === "snapshot" && head.parallel !== name) {
        errors.push(`.pvc/state.json: head ${name} points to Parallel ${head.parallel}`);
      }
    }
    return { objectCount, errors };
  }
  blob(bytes: Uint8Array): Hash {
    return this.put({ kind: "blob", data: Buffer.from(bytes).toString("base64") });
  }
  readBlob(id: Hash): Buffer {
    const obj = this.get(id);
    if (obj.kind !== "blob") throw new VcsError("blobではない");
    return Buffer.from(obj.data, "base64");
  }
  writeTree(files: Tree): Hash {
    this.assertValidTree(files);
    return this.put({ kind: "tree", files: sortedTree(files) });
  }
  readTree(id: Hash): Tree {
    const o = this.get(id);
    if (o.kind !== "tree") throw new VcsError("treeではない");
    return { ...o.files };
  }
  writeSnapshot(parallel: string, seq: number, root: Hash, parents: Hash[], seed: Hash | null): Hash {
    return this.put({ kind: "snapshot", parallel, seq, root, parents, seed, createdAt: new Date().toISOString() });
  }
  snapshot(id: Hash): Snapshot {
    const o = this.get(id);
    if (o.kind !== "snapshot") throw new VcsError(`snapshotではない: ${short(id)}`);
    return o;
  }
  treeAt(ref: string): Tree {
    return this.readTree(this.snapshot(this.resolve(ref)).root);
  }
  head(parallel?: string): Hash {
    const state = this.state;
    const name = parallel || state.active;
    if (!(name in state.heads)) throw new VcsError(`存在しないParallel: ${name}`);
    return state.heads[name];
  }
  resolve(ref: string): Hash {
    const s = this.state;
    if (ref === "HEAD" || ref === "@") return this.head();
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
      const directory = path.join(this.meta, "objects");
      for (const folder of fs.readdirSync(directory)) {
        if (!/^[a-f0-9]{2}$/.test(folder)) continue;
        for (const suffix of fs.readdirSync(path.join(directory, folder))) {
          const id = folder + suffix;
          if (id.startsWith(ref) && this.get(id).kind === "snapshot") matches.push(id);
        }
      }
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) throw new VcsError("Snapshotハッシュが曖昧");
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
  fork(name: string, from: string = "HEAD"): Hash {
    return this.withWriteLock(() => {
      if (!nameRe.test(name) || name.includes("@")) throw new VcsError("Parallel名は英数字・.-_のみで先頭は英字");
      const state = this.state;
      if (name in state.heads) throw new VcsError(`既存のParallel: ${name}`);
      const source = this.resolve(from);
      const root = this.snapshot(source).root;
      const s0 = this.writeSnapshot(name, 0, root, [], source);
      state.heads[name] = s0;
      this.saveState(state);
      return s0;
    });
  }

  // Root-relative POSIX paths only. Never trust a user-supplied absolute/parent path.
  normalize(input: string): string {
    if (input.includes("\0")) throw new VcsError(`NUL byteを含むパスは使えない: ${input}`);
    const target = path.resolve(this.root, input);
    const rel = path.relative(this.root, target).split(path.sep).join("/");
    if (rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) {
      throw new VcsError(`パスがリポジトリ外: ${input}`);
    }
    if (rel.split("/").some(p => ignored.has(p.toLowerCase()))) throw new VcsError(`除外されたパス: ${input}`);
    return rel || ".";
  }
  private safeFile(relative: string): string {
    const rel = this.normalize(relative);
    if (rel === ".") throw new VcsError("ファイル名として . は使えない");
    let current = this.root;
    for (const part of rel.split("/")) {
      current = path.join(current, part);
      if (lstatMaybe(current)?.isSymbolicLink()) throw new VcsError(`symlinkは非対応: ${rel}`);
    }
    return current;
  }
  private walk(relative = "."): string[] {
    const absolute = path.join(this.root, relative);
    if (!lstatMaybe(absolute)) return [];
    if (fs.lstatSync(absolute).isSymbolicLink()) throw new VcsError(`symlinkは非対応: ${relative}`);
    if (fs.statSync(absolute).isFile()) return [relative];
    if (!fs.statSync(absolute).isDirectory()) return [];
    const out: string[] = [];
    for (const name of fs.readdirSync(absolute).sort()) {
      if (ignored.has(name.toLowerCase())) continue;
      const child = relative === "." ? name : `${relative}/${name}`;
      out.push(...this.walk(child));
    }
    return out;
  }
  private fileHash(relative: string): Hash | null {
    const full = this.safeFile(relative);
    if (!exists(full)) return null;
    const stat = fs.statSync(full);
    if (stat.isDirectory()) return null;
    if (!stat.isFile()) throw new VcsError(`通常ファイルではない: ${relative}`);
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
    const tracked = this.treeAt("HEAD");
    const files = this.walk();
    const modified = Object.keys(tracked).filter(p => !this.equalsLive(p, tracked[p]) && this.liveBlob(p) !== null);
    const deleted = Object.keys(tracked).filter(p => this.liveBlob(p) === null);
    const untracked = files.filter(p => !(p in tracked));
    return { modified, deleted, untracked };
  }
  private assertClean(): void {
    const s = this.status();
    if (s.modified.length || s.deleted.length) {
      throw new VcsError(`未Shotの変更があるため操作を中止: ${[...s.modified, ...s.deleted].join(", ")}`);
    }
  }
  shot(paths: string[], all = false): { id: Hash | null; changed: string[] } {
    return this.withWriteLock(() => this.shotLocked(paths, all));
  }
  private shotLocked(paths: string[], all: boolean): { id: Hash | null; changed: string[] } {
    if (!all && paths.length === 0) throw new VcsError("pvc shot <path...> か pvc shot -A");
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
        if (rel === ".") {
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
    return this.withWriteLock(() => {
      const from = this.normalize(source);
      const to = this.normalize(destination);
      if (from === "." || to === "." || from === to) throw new VcsError("moveのファイル指定が無効");
      const tracked = this.treeAt("HEAD");
      if (!(from in tracked)) throw new VcsError(`未追跡ファイルはmoveできない: ${from}`);
      const src = this.safeFile(from);
      const dst = this.safeFile(to);
      if (!exists(src) || !fs.statSync(src).isFile() || !this.equalsLive(from, tracked[from])) {
        throw new VcsError(`move元に未Shotの変更がある: ${from}`);
      }
      if (exists(dst) || to in tracked) throw new VcsError(`move先が既に存在する: ${to}`);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.renameSync(src, dst);
      try {
        return this.shotLocked([from, to], false);
      } catch (error) {
        fs.renameSync(dst, src);
        throw error;
      }
    });
  }

  private assertValidTree(tree: Tree): void {
    const files = new Set(Object.keys(tree));
    for (const file of files) {
      if (!isValidTreePath(file)) throw new VcsError(`Tree pathが無効: ${JSON.stringify(file)}`);
    }
    const collisions = treePathCollisions(files);
    if (collisions.length) throw new VcsError(`Tree内でpathが衝突する: ${collisions.join("; ")}`);
  }
  private pruneEmptyParents(paths: string[]): void {
    const directories = new Set<string>();
    for (const file of paths) {
      let parent = path.posix.dirname(file);
      while (parent !== ".") {
        directories.add(parent);
        parent = path.posix.dirname(parent);
      }
    }
    const deepestFirst = [...directories].sort((a, b) => b.split("/").length - a.split("/").length);
    for (const relative of deepestFirst) {
      const full = path.join(this.root, ...relative.split("/"));
      try {
        fs.rmdirSync(full);
      } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
      }
    }
  }
  private removeTransactionFile(relative: string): void {
    const full = this.safeFile(relative);
    const stat = lstatMaybe(full);
    if (!stat || stat.isDirectory()) return;
    if (!stat.isFile()) throw new VcsError(`通常ファイルではない: ${relative}`);
    fs.unlinkSync(full);
  }
  private installTransactionFile(source: string, destination: string, temporary: string): void {
    try {
      fs.renameSync(source, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
      fs.renameSync(temporary, destination);
      fs.unlinkSync(source);
    }
  }

  // Persist a recovery journal before touching the worktree. Keep backups until state
  // and journal agree so a later Repo construction can roll back an interrupted update.
  private applyTree(from: Tree, to: Tree, lock: RepositoryLock): WorktreeTransaction {
    this.assertClean();
    this.assertValidTree(from);
    this.assertValidTree(to);
    const changes = [...new Set([...Object.keys(from), ...Object.keys(to)])].filter(p => from[p] !== to[p]);
    for (const rel of changes) {
      const full = this.safeFile(rel);
      const stat = lstatMaybe(full);
      if (!(rel in from) && stat) {
        if (!stat.isDirectory()) throw new VcsError(`未追跡ファイルを上書きできない: ${rel}`);
        const descendants = this.walk(rel);
        if (!descendants.length || descendants.some(p => !(p in from) || p in to)) {
          throw new VcsError(`未追跡ファイルを上書きできない: ${rel}`);
        }
      }
      if (rel in to && stat && !stat.isFile() && !stat.isDirectory()) {
        throw new VcsError(`通常ファイルではない: ${rel}`);
      }
    }

    const transactionDir = lock.directory;
    const staged = changes.map((relative, index) => ({
      relative,
      temporary: path.posix.join(
        path.posix.dirname(relative) === "." ? "" : path.posix.dirname(relative),
        `.pvc-txn-${process.pid}-${randomUUID()}-${index}`,
      ),
      old: path.join(transactionDir, "old", String(index)),
      next: path.join(transactionDir, "next", String(index)),
    }));
    for (const item of staged) {
      if (lstatMaybe(this.safeFile(item.temporary))) throw new VcsError(`一時パスが既に存在する: ${item.temporary}`);
    }
    const oldState = JSON.parse(JSON.stringify(this.state)) as State;
    const journal: TransactionJournal = {
      format: 1,
      ownerPid: process.pid,
      phase: "preparing",
      oldState,
      entries: staged.map((item, index) => ({
        relative: item.relative,
        temporary: item.temporary,
        index,
        hadOld: Boolean(from[item.relative]),
        oldHash: from[item.relative] || null,
        newHash: to[item.relative] || null,
      })),
    };
    try {
      this.writeTransactionJournal(transactionDir, journal);
      for (let i = 0; i < changes.length; i++) {
        const relative = changes[i];
        let originalMode: number | undefined;
        if (from[relative]) {
          originalMode = fs.statSync(this.safeFile(relative)).mode & 0o777;
          fs.mkdirSync(path.dirname(staged[i].old), { recursive: true });
          fs.writeFileSync(staged[i].old, this.readBlob(from[relative]), { flag: "wx" });
          fs.chmodSync(staged[i].old, originalMode);
        }
        if (to[relative]) {
          fs.mkdirSync(path.dirname(staged[i].next), { recursive: true });
          fs.writeFileSync(staged[i].next, this.readBlob(to[relative]), { flag: "wx" });
          if (originalMode !== undefined) fs.chmodSync(staged[i].next, originalMode);
        }
      }
      journal.phase = "ready";
      this.writeTransactionJournal(transactionDir, journal);
    } catch (error) {
      throw error;
    }

    let finished = false;
    const rollback = () => {
      if (finished) return;
      try {
        journal.phase = "rollingBack";
        this.writeTransactionJournal(transactionDir, journal);
        this.restoreTransactionFiles(transactionDir, journal.entries);
        this.saveState(oldState);
        journal.phase = "rolledBack";
        this.writeTransactionJournal(transactionDir, journal);
      } catch (error) {
        lock.preserve();
        throw new VcsError(`作業ツリーのロールバックに失敗。復旧データを保持: ${transactionDir} (${String(error)})`);
      }
      finished = true;
    };
    try {
      // Remove tracked leaves first, then prune empty directories for file/directory transitions.
      for (const relative of changes) {
        if (!from[relative]) continue;
        const full = this.safeFile(relative);
        const stat = lstatMaybe(full);
        if (stat?.isFile()) fs.unlinkSync(full);
      }
      this.pruneEmptyParents(changes);
      for (const item of staged) {
        if (!to[item.relative]) continue;
        const full = this.safeFile(item.relative);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        this.installTransactionFile(item.next, full, this.safeFile(item.temporary));
      }
    } catch (error) {
      try {
        rollback();
      } catch (rollbackError) {
        throw new VcsError(`${String(error)}; ${String(rollbackError)}`);
      }
      throw error;
    }
    return {
      commit: () => {
        if (finished) return;
        journal.phase = "committed";
        this.writeTransactionJournal(transactionDir, journal);
        finished = true;
      },
      rollback,
    };
  }
  switch(name: string): Hash {
    return this.withWriteLock(lock => this.switchLocked(name, lock));
  }
  private switchLocked(name: string, lock: RepositoryLock): Hash {
    const state = this.state;
    if (!(name in state.heads)) throw new VcsError(`存在しないParallel: ${name}`);
    if (state.active === name) return this.head();
    const from = this.treeAt("HEAD");
    const to = this.readTree(this.snapshot(state.heads[name]).root);
    const transaction = this.applyTree(from, to, lock);
    const nextState: State = { ...state, active: name, heads: { ...state.heads } };
    try {
      this.saveState(nextState);
      transaction.commit();
    } catch (error) {
      try {
        transaction.rollback();
      } catch (rollbackError) {
        throw new VcsError(`${String(error)}; ${String(rollbackError)}`);
      }
      throw error;
    }
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
    if (!common.length) throw new VcsError("共通祖先が存在しないためComposeできない");
    // A distance heuristic can silently choose a wrong base in criss-cross histories.
    // Use maximal common ancestors instead; reject ambiguity until virtual bases exist.
    const ancestryCache = new Map<Hash, Map<Hash, number>>();
    const isAncestor = (descendant: Hash, ancestor: Hash): boolean => {
      if (!ancestryCache.has(descendant)) ancestryCache.set(descendant, this.ancestors(descendant));
      return ancestryCache.get(descendant)!.has(ancestor);
    };
    const maximal = common.filter(id => !common.some(other => other !== id && isAncestor(other, id)));
    if (maximal.length !== 1) {
      throw new VcsError(`共通祖先が複数ある (${maximal.map(short).join(", ")})。仮想Baseの計算は未実装`);
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
      changes.push({
        path: name,
        base: bv || null,
        left: lv || null,
        right: rv || null,
        outcome: outcome || null,
        conflict,
      });
      if (outcome) result[name] = outcome;
      else delete result[name];
    }
    const conflicts = changes.filter(c => c.conflict);
    return {
      base,
      left,
      right,
      changes,
      conflicts,
      result,
      touched: changes.length,
      clean: changes.length - conflicts.length,
      percentage: changes.length === 0 ? 100 : 100 * (changes.length - conflicts.length) / changes.length,
    };
  }
  candidates(composition: Composition, file: string): Candidate[] {
    const conflict = composition.conflicts.find(c => c.path === file);
    if (!conflict) throw new VcsError(`競合パスではない: ${file}`);
    const output: Candidate[] = [];
    const seen = new Set<string>();
    const add = (ref: string, hash: Hash | null, origin: string) => {
      const key = hash || "∅";
      if (seen.has(key)) return;
      seen.add(key);
      output.push({ ref, hash, origin });
    };
    add("base", conflict.base, "共通祖先");
    add("left", conflict.left, "合成先");
    add("right", conflict.right, "合成元");
    const history = new Set([...this.ancestors(composition.left).keys(), ...this.ancestors(composition.right).keys()]);
    for (const id of history) {
      const snap = this.snapshot(id);
      const hash = this.readTree(snap.root)[file] || null;
      add(`${snap.parallel}@${snap.seq}`, hash, `履歴 ${short(id)}`);
    }
    return output;
  }
  compose(
    sourceRef: string,
    into?: string,
    resolutions: Record<string, string> = {},
    dryRun = false,
  ): { composition: Composition; unresolved: string[]; id: Hash | null } {
    return this.withWriteLock(lock => this.composeLocked(sourceRef, into, resolutions, dryRun, lock));
  }
  private composeLocked(
    sourceRef: string,
    into: string | undefined,
    resolutions: Record<string, string>,
    dryRun: boolean,
    lock: RepositoryLock,
  ): { composition: Composition; unresolved: string[]; id: Hash | null } {
    const state = this.state;
    const parallel = into || state.active;
    const left = this.head(parallel);
    const right = this.resolve(sourceRef);
    const comp = this.compare(left, right);
    const unresolved: string[] = [];
    for (const conflict of comp.conflicts) {
      const selection = resolutions[conflict.path];
      if (!selection) {
        unresolved.push(conflict.path);
        continue;
      }
      let outcome: Hash | null;
      if (selection === "left") outcome = conflict.left;
      else if (selection === "right") outcome = conflict.right;
      else if (selection === "base") outcome = conflict.base;
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
    const root = this.writeTree(comp.result);
    const seq = this.snapshot(left).seq + 1;
    const id = this.writeSnapshot(parallel, seq, root, [left, right], null);
    const nextState: State = { ...state, heads: { ...state.heads, [parallel]: id } };
    if (parallel === state.active) {
      const old = this.readTree(this.snapshot(left).root);
      const transaction = this.applyTree(old, comp.result, lock);
      try {
        this.saveState(nextState);
        transaction.commit();
      } catch (error) {
        try {
          transaction.rollback();
        } catch (rollbackError) {
          throw new VcsError(`${String(error)}; ${String(rollbackError)}`);
        }
        throw error;
      }
    } else this.saveState(nextState);
    return { composition: comp, unresolved, id };
  }
  diff(a: string, b: string): Array<{ path: string; before: Hash | null; after: Hash | null; status: string }> {
    const x = this.treeAt(a), y = this.treeAt(b);
    return [...new Set([...Object.keys(x), ...Object.keys(y)])].sort().filter(p => x[p] !== y[p]).map(p => ({
      path: p,
      before: x[p] || null,
      after: y[p] || null,
      status: !x[p] ? "A" : !y[p] ? "D" : "M",
    }));
  }
}
