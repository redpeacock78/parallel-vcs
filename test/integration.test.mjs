import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
function cmd(cwd, ...args) {
  const cp = spawnSync(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    "--experimental-strip-types",
    script,
    ...args,
  ], { cwd, encoding: "utf8" });
  return { code: cp.status, out: cp.stdout, err: cp.stderr };
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

test("外部を指すsymlinkとdangling symlinkを拒否", () => {
  const d = mkdirTemp();
  try {
    ok(d, "init");
    symlinkSync(path.join(d, "missing"), path.join(d, "dangling"));
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
