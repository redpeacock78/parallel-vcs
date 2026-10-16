import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const mkdirTemp = () => mkdtempSync(path.join(tmpdir(), "pvc-test-"));
function runCommand(cwd, args, options = {}) {
  const cp = spawnSync(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    "--experimental-strip-types",
    script,
    ...args,
  ], { cwd, encoding: "utf8", ...options });
  return { code: cp.status, out: cp.stdout || "", err: cp.stderr || "", error: cp.error };
}
function cmd(cwd, ...args) {
  return runCommand(cwd, args);
}
function cmdWithOptions(cwd, options, ...args) {
  return runCommand(cwd, args, options);
}
function ok(cwd, ...args) {
  const result = cmd(cwd, ...args);
  assert.equal(result.code, 0, `${args.join(" ")}: ${result.err} ${result.out}`);
  return result.out;
}
const write = (dir, file, data) => {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), data);
};
const read = (dir, file) => readFileSync(path.join(dir, file), "utf8");
const blobHash = (data) =>
  createHash("sha256").update(JSON.stringify({ kind: "blob", data: Buffer.from(data).toString("base64") })).digest(
    "hex",
  );
const objectHash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

test("独立S0・Shot・任意Snapshot派生・過去地点の参照", () => {
  const d = mkdirTemp();
  try {
    ok(d, "init");
    write(d, "hello.txt", "zero");
    ok(d, "stage", "hello.txt");
    write(d, "hello.txt", "one");
    ok(d, "shot", "hello.txt");
    ok(d, "parallel", "fork", "alt", "--from", "main@1");
    assert.match(ok(d, "show", "alt@0"), /"seq": 0/);
    assert.match(ok(d, "diff", "main@1", "alt@0"), /^$/);
    assert.match(ok(d, "diff", "main@2", "alt@0"), /hello.txt/);
    ok(d, "parallel", "switch", "alt");
    assert.equal(read(d, "hello.txt"), "zero");
    ok(d, "shot", "hello.txt"); // no change
    assert.match(ok(d, "log"), /alt@0/);
    assert.doesNotMatch(ok(d, "log"), /alt@1/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("非競合Composeは両方を採用し2つの親を保持", () => {
  const d = mkdirTemp();
  try {
    ok(d, "init");
    write(d, "base", "origin");
    ok(d, "shot", "-A");
    ok(d, "parallel", "fork", "alt");
    write(d, "left", "A");
    ok(d, "shot", "left");
    ok(d, "parallel", "switch", "alt");
    write(d, "right", "B");
    ok(d, "stage", "right");
    assert.match(ok(d, "coverage", "main", "alt"), /100.0%/);
    ok(d, "parallel", "switch", "main");
    const out = ok(d, "compose", "alt");
    assert.match(out, /parents=\[/);
    assert.equal(read(d, "left"), "A");
    assert.equal(read(d, "right"), "B");
    const snap = JSON.parse(ok(d, "show", "HEAD"));
    assert.equal(snap.parents.length, 2);
    assert.match(ok(d, "log"), /\[compose\]/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("競合候補表示・解決未選択なら不変更・履歴から解決可能", () => {
  const d = mkdirTemp();
  try {
    ok(d, "init");
    write(d, "file", "base");
    ok(d, "shot", "file");
    ok(d, "parallel", "fork", "alt");
    write(d, "file", "left");
    ok(d, "shot", "file");
    ok(d, "parallel", "switch", "alt");
    write(d, "file", "right");
    ok(d, "shot", "file");
    const cov = JSON.parse(ok(d, "coverage", "main", "alt", "--json"));
    assert.equal(cov.coverage, 0);
    assert.ok(cov.conflicts[0].options.length >= 3);
    ok(d, "parallel", "switch", "main");
    const failed = cmd(d, "compose", "alt");
    assert.equal(failed.code, 2);
    assert.equal(read(d, "file"), "left");
    assert.match(ok(d, "log"), /main@2/);
    ok(d, "compose", "alt", "--take", "file=main@1");
    assert.equal(read(d, "file"), "base");
    assert.match(ok(d, "log"), /main@3/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("未Shotの変更・未追跡上書きを保護し削除も記録", () => {
  const d = mkdirTemp();
  try {
    ok(d, "init");
    write(d, "x", "hello");
    ok(d, "shot", "-A");
    ok(d, "parallel", "fork", "alt");
    write(d, "x", "dirty");
    assert.equal(cmd(d, "parallel", "switch", "alt").code, 1);
    assert.equal(read(d, "x"), "dirty");
    write(d, "x", "hello");
    ok(d, "parallel", "switch", "alt");
    write(d, "extra", "tracked in alt");
    ok(d, "shot", "extra");
    ok(d, "parallel", "switch", "main");
    write(d, "extra", "untracked");
    assert.equal(cmd(d, "parallel", "switch", "alt").code, 1);
    assert.equal(read(d, "extra"), "untracked");
    rmSync(path.join(d, "extra"));
    ok(d, "parallel", "switch", "alt");
    rmSync(path.join(d, "x"));
    assert.match(ok(d, "status"), / D x/);
    ok(d, "shot", "x");
    assert.ok(!existsSync(path.join(d, "x")));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("dry-run, SHA hash ref, no changes, traversal invalid", () => {
  const d = mkdirTemp();
  try {
    ok(d, "init");
    write(d, "f", "0");
    ok(d, "shot", "-A");
    assert.match(ok(d, "shot", "-A"), /差分なし/);
    assert.equal(cmd(d, "shot", "../outside").code, 1);
    ok(d, "parallel", "fork", "child");
    write(d, "f", "1");
    ok(d, "shot", "-A");
    const snap = JSON.parse(ok(d, "show", "HEAD"));
    assert.match(ok(d, "show", snap.id.slice(0, 12)), /"seq": 2/);
    const out = ok(d, "compose", "child", "--dry-run");
    assert.match(out, /Dry-run/);
    assert.match(ok(d, "log"), /main@2/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("renameの一操作一Snapshot化とCAS blobの同一性", () => {
  const d = mkdirTemp();
  try {
    ok(d, "init");
    write(d, "one.txt", "payload");
    ok(d, "shot", "one.txt");
    const before = JSON.parse(ok(d, "show", "HEAD"));
    ok(d, "move", "one.txt", "nested/two.txt");
    const after = JSON.parse(ok(d, "show", "HEAD"));
    assert.equal(after.seq, before.seq + 1);
    assert.equal(after.files["nested/two.txt"], before.files["one.txt"]);
    assert.ok(!("one.txt" in after.files));
    assert.equal(read(d, "nested/two.txt"), "payload");
    assert.match(ok(d, "diff", "main@1", "main@2"), /D one.txt/);
    assert.match(ok(d, "diff", "main@1", "main@2"), /A nested\/two.txt/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("特殊なファイル名とCAS破損検出", () => {
  const d = mkdirTemp();
  try {
    ok(d, "init");
    write(d, "__proto__", "literal filename");
    ok(d, "shot", "__proto__");
    const snap = JSON.parse(ok(d, "show", "HEAD"));
    assert.ok(Object.hasOwn(snap.files, "__proto__"));
    assert.match(ok(d, "status"), /clean/);
    const cas = path.join(d, ".pvc", "objects", snap.id.slice(0, 2), snap.id.slice(2));
    writeFileSync(cas, "{\"kind\":\"snapshot\",\"corrupt\":true}");
    assert.equal(cmd(d, "show", "HEAD").code, 1);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("verifyが正常なobject storeを受け入れ、hash破損を検出する", () => {
  const d = mkdirTemp();
  try {
    ok(d, "init");
    write(d, "file", "content");
    ok(d, "shot", "file");
    assert.match(ok(d, "verify"), /^Verified \d+ objects/);

    const snapshot = JSON.parse(ok(d, "show", "HEAD"));
    const treePath = path.join(d, ".pvc", "objects", snapshot.root.slice(0, 2), snapshot.root.slice(2));
    writeFileSync(treePath, JSON.stringify({ kind: "tree", files: {} }));
    const report = cmd(d, "verify");
    assert.equal(report.code, 1);
    assert.match(report.err, /CAS hash mismatch/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("verifyがCAS objectの欠落参照を検出する", () => {
  const d = mkdirTemp();
  try {
    ok(d, "init");
    const tree = { kind: "tree", files: { ghost: "f".repeat(64) } };
    const id = objectHash(tree);
    const objectPath = path.join(d, ".pvc", "objects", id.slice(0, 2), id.slice(2));
    mkdirSync(path.dirname(objectPath), { recursive: true });
    writeFileSync(objectPath, JSON.stringify(tree));

    const report = cmd(d, "verify");
    assert.equal(report.code, 1);
    assert.match(report.err, /referenced blob .* is missing or has the wrong type/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("gcは全Parallelの履歴を残し、到達不能なCAS objectを削除する", () => {
  const d = mkdirTemp();
  try {
    ok(d, "init");
    write(d, "tracked.txt", "reachable");
    ok(d, "shot", "tracked.txt");
    ok(d, "parallel", "fork", "alt");

    const orphanBlob = { kind: "blob", data: Buffer.from("orphan").toString("base64") };
    const orphanBlobId = objectHash(orphanBlob);
    const orphanTree = { kind: "tree", files: { "orphan.txt": orphanBlobId } };
    const orphanTreeId = objectHash(orphanTree);
    const orphanSnapshot = {
      kind: "snapshot",
      parallel: "orphan",
      seq: 0,
      root: orphanTreeId,
      parents: [],
      seed: null,
      createdAt: new Date().toISOString(),
    };
    const orphanSnapshotId = objectHash(orphanSnapshot);
    for (
      const [id, object] of [
        [orphanBlobId, orphanBlob],
        [orphanTreeId, orphanTree],
        [orphanSnapshotId, orphanSnapshot],
      ]
    ) {
      const objectPath = path.join(d, ".pvc", "objects", id.slice(0, 2), id.slice(2));
      mkdirSync(path.dirname(objectPath), { recursive: true });
      writeFileSync(objectPath, JSON.stringify(object));
    }

    assert.match(ok(d, "verify"), /^Verified 9 objects/);
    assert.match(ok(d, "gc", "--dry-run"), /Would remove 3 unreachable objects/);
    assert.match(ok(d, "verify"), /^Verified 9 objects/);
    assert.match(ok(d, "gc"), /Removed 3 unreachable objects/);
    assert.match(ok(d, "verify"), /^Verified 6 objects/);
    assert.match(ok(d, "show", "main@0"), /"seq": 0/);
    assert.match(ok(d, "show", "alt@0"), /"seq": 0/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("gcは破損したobject storeを変更しない", () => {
  const d = mkdirTemp();
  try {
    ok(d, "init");
    const id = "a".repeat(64);
    const objectPath = path.join(d, ".pvc", "objects", id.slice(0, 2), id.slice(2));
    mkdirSync(path.dirname(objectPath), { recursive: true });
    writeFileSync(objectPath, JSON.stringify({ kind: "blob", data: "corrupt" }));

    const result = cmd(d, "gc");
    assert.equal(result.code, 1);
    assert.match(result.err, /CAS検証に失敗したためGCを中止/);
    assert.ok(existsSync(objectPath));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("verifyが絶対path、NUL byte、Windows形式の区切りを含むTreeを終了せず拒否する", () => {
  const d = mkdirTemp();
  try {
    ok(d, "init");
    const invalidPaths = [
      "/bad",
      "bad\0path",
      "a\\..\\..\\outside",
      "C:foo",
      "dir/C:foo",
      "dir/file:stream",
      "dir/CON.txt",
      "dir/COM¹.log",
      "dir/trailing.",
      "dir/trailing ",
      ".PVC/state.json",
      "Node_Modules/package.json",
      "a".repeat(256),
    ];
    for (const invalidPath of invalidPaths) {
      const tree = { kind: "tree", files: { [invalidPath]: "f".repeat(64) } };
      const id = objectHash(tree);
      const objectPath = path.join(d, ".pvc", "objects", id.slice(0, 2), id.slice(2));
      mkdirSync(path.dirname(objectPath), { recursive: true });
      writeFileSync(objectPath, JSON.stringify(tree));
    }

    const report = cmdWithOptions(d, { timeout: 3000 }, "verify");
    assert.equal(report.error, undefined);
    assert.equal(report.code, 1);
    for (const invalidPath of invalidPaths) {
      assert.ok(
        report.err.includes(JSON.stringify(invalidPath)),
        `missing invalid-path diagnostic for ${JSON.stringify(invalidPath)}`,
      );
    }
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("verifyはcase-insensitiveなTree path衝突を拒否する", () => {
  const cases = [
    {
      files: { foo: "f".repeat(64), FOO: "e".repeat(64) },
      diagnostic: /case-insensitive path collision between foo and FOO/,
    },
    {
      files: { foo: "f".repeat(64), "FOO/bar": "e".repeat(64) },
      diagnostic: /file\/directory collision between foo and FOO\/bar/,
    },
    {
      files: { S: "f".repeat(64), "ſ": "e".repeat(64) },
      diagnostic: /case-insensitive path collision between S and ſ/,
    },
  ];
  const d = mkdirTemp();
  try {
    ok(d, "init");
    for (const { files, diagnostic } of cases) {
      const tree = { kind: "tree", files };
      const id = objectHash(tree);
      const objectPath = path.join(d, ".pvc", "objects", id.slice(0, 2), id.slice(2));
      mkdirSync(path.dirname(objectPath), { recursive: true });
      writeFileSync(objectPath, JSON.stringify(tree));

      const report = cmd(d, "verify");
      assert.equal(report.code, 1);
      assert.match(report.err, diagnostic);
    }
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("shotはcase-insensitiveなTree path衝突を拒否する", t => {
  if (process.platform === "win32") {
    t.skip("Case-distinct filesystem entries are required to test portable path collisions");
    return;
  }
  for (const entries of [["foo", "FOO"], ["foo", "FOO/bar"], ["S", "ſ"]]) {
    const repo = mkdirTemp();
    try {
      ok(repo, "init");
      for (const [index, file] of entries.entries()) write(repo, file, `content ${index}`);
      const shot = cmd(repo, "shot", "-A");
      assert.equal(shot.code, 1);
      assert.match(shot.err, /Tree内でpathが衝突する/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test("supplementary-plane case pairは別のTree pathとして扱う", () => {
  const d = mkdirTemp();
  try {
    ok(d, "init");
    write(d, "𐐀", "capital");
    write(d, "𐐨", "small");
    assert.match(ok(d, "shot", "-A"), /Snapshot/);
    assert.match(ok(d, "verify"), /^Verified \d+ objects/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("walkは除外directoryをcase-insensitiveに無視する", t => {
  if (process.platform === "win32") {
    t.skip("Case-distinct directory names are required for this POSIX regression test");
    return;
  }
  const d = mkdirTemp();
  try {
    ok(d, "init");
    write(d, ".PVC/state-copy.json", "ignored");
    write(d, "Node_Modules/package.json", "ignored");
    assert.match(ok(d, "status"), /^Parallel: main .*\nclean/m);
    assert.match(ok(d, "shot", "-A"), /差分なし/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("shotがPOSIX上のbackslash名を拒否してverifyと書き込み規則を揃える", t => {
  if (process.platform === "win32") {
    t.skip("Windows does not allow backslashes in file names");
    return;
  }
  const d = mkdirTemp();
  try {
    ok(d, "init");
    write(d, "a\\b", "content");
    assert.match(ok(d, "status"), /\? a\\b/);
    const report = cmd(d, "shot", "-A");
    assert.equal(report.code, 1);
    assert.match(report.err, /Tree pathが無効/);
    assert.match(ok(d, "verify"), /^Verified \d+ objects/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("verifyが読み取れないobject bucketを報告する", t => {
  if (process.platform === "win32" || typeof process.getuid !== "function") {
    t.skip("POSIX permissions are required");
    return;
  }
  const childUser = process.getuid() === 0 ? { uid: 65534, gid: 65534 } : {};
  const d = mkdirTemp();
  let bucketPath;
  let metaPath;
  try {
    ok(d, "init");
    const objects = path.join(d, ".pvc", "objects");
    metaPath = path.join(d, ".pvc");
    const bucket = readdirSync(objects).find(name => /^[a-f0-9]{2}$/.test(name));
    assert.ok(bucket);
    bucketPath = path.join(objects, bucket);
    chmodSync(d, 0o755);
    chmodSync(metaPath, 0o555);
    chmodSync(objects, 0o755);
    const accessProbe = cmdWithOptions(d, childUser, "verify");
    const scriptInaccessible = accessProbe.err.includes("MODULE_NOT_FOUND") && accessProbe.err.includes(script);
    if (
      accessProbe.error?.code === "EACCES" || /EACCES|permission denied/i.test(accessProbe.err)
      || scriptInaccessible
    ) {
      t.skip("pvc script or Node is not accessible to the unprivileged child");
      return;
    }
    assert.equal(accessProbe.code, 0, `access probe: ${accessProbe.err} ${accessProbe.out}`);
    chmodSync(bucketPath, 0);

    const report = cmdWithOptions(d, childUser, "verify");
    assert.equal(report.code, 1);
    assert.match(report.err, /cannot enumerate object bucket/);
    assert.match(report.err, /検証失敗:/);
    assert.doesNotMatch(report.err, /^\s+at .*\.ts:/m);
  } finally {
    if (bucketPath) chmodSync(bucketPath, 0o755);
    if (metaPath) chmodSync(metaPath, 0o755);
    rmSync(d, { recursive: true, force: true });
  }
});

test("verifyがstateのHEAD参照を確認する", () => {
  const d = mkdirTemp();
  try {
    ok(d, "init");
    const statePath = path.join(d, ".pvc", "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.heads.main = "f".repeat(64);
    writeFileSync(statePath, JSON.stringify(state));

    const report = cmd(d, "verify");
    assert.equal(report.code, 1);
    assert.match(report.err, /state\.json head main: referenced snapshot .* is missing or has the wrong type/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("外部を指すsymlinkとdangling symlinkを拒否", t => {
  const d = mkdirTemp();
  try {
    ok(d, "init");
    try {
      symlinkSync(path.join(d, "missing"), path.join(d, "dangling"));
    } catch (error) {
      if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error.code)) {
        t.skip("Symlink privileges are unavailable on this Windows runner");
        return;
      }
      throw error;
    }
    assert.equal(cmd(d, "shot", "dangling").code, 1);
    assert.equal(cmd(d, "shot", "-A").code, 1);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("switchでtracked fileとdirectoryを安全に置き換える", () => {
  const d = mkdirTemp();
  try {
    ok(d, "init");
    write(d, "node", "file version");
    ok(d, "shot", "-A");
    ok(d, "parallel", "fork", "nested");
    ok(d, "parallel", "switch", "nested");
    rmSync(path.join(d, "node"));
    write(d, "node/child", "directory version");
    ok(d, "shot", "-A");
    ok(d, "parallel", "switch", "main");
    assert.equal(read(d, "node"), "file version");
    ok(d, "parallel", "switch", "nested");
    assert.equal(read(d, "node/child"), "directory version");
    ok(d, "parallel", "switch", "main");
    assert.equal(read(d, "node"), "file version");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("起動時に中断transactionの作業ツリーとstateを復旧する", () => {
  const d = mkdirTemp();
  try {
    ok(d, "init");
    write(d, "file", "old");
    ok(d, "shot", "-A");
    ok(d, "parallel", "fork", "newer");
    ok(d, "parallel", "switch", "newer");
    write(d, "file", "new");
    ok(d, "shot", "-A");
    ok(d, "parallel", "switch", "main");

    const meta = path.join(d, ".pvc");
    const oldState = JSON.parse(readFileSync(path.join(meta, "state.json"), "utf8"));
    const transaction = path.join(meta, "txn-active");
    mkdirSync(path.join(transaction, "old"), { recursive: true });
    writeFileSync(path.join(transaction, "owner.json"), JSON.stringify({ format: 1, pid: 2147483647 }));
    copyFileSync(path.join(d, "file"), path.join(transaction, "old/0"));
    write(d, "file", "new");
    writeFileSync(path.join(meta, "state.json"), JSON.stringify({ ...oldState, active: "newer" }));
    writeFileSync(
      path.join(transaction, "journal.json"),
      JSON.stringify({
        format: 1,
        ownerPid: 2147483647,
        phase: "ready",
        oldState,
        entries: [{
          relative: "file",
          temporary: ".pvc-txn-interrupted",
          index: 0,
          hadOld: true,
          oldHash: blobHash("old"),
          newHash: blobHash("new"),
        }],
      }),
    );

    assert.match(ok(d, "status"), /clean/);
    assert.equal(read(d, "file"), "old");
    assert.equal(JSON.parse(readFileSync(path.join(meta, "state.json"), "utf8")).active, "main");
    assert.equal(existsSync(transaction), false);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("実行中のtransaction slotが別プロセスの更新を拒否する", () => {
  const d = mkdirTemp();
  try {
    ok(d, "init");
    const transaction = path.join(d, ".pvc", "txn-active");
    mkdirSync(transaction);
    writeFileSync(path.join(transaction, "owner.json"), JSON.stringify({ format: 1, pid: process.pid }));

    const blocked = cmd(d, "parallel", "fork", "overlap");
    assert.equal(blocked.code, 1);
    assert.match(blocked.err, /別のpvc処理がリポジトリを更新中/);
    assert.equal(JSON.parse(readFileSync(path.join(d, ".pvc", "state.json"), "utf8")).heads.overlap, undefined);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
