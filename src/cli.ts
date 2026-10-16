#!/usr/bin/env -S node --experimental-strip-types
import { Repo, short, VcsError } from "./core.ts";

const help = `Parallel VCS 0.1.0  |  independent snapshot universes

使い方: pvc <command> [args]

  init                               .pvc を初期化 (main@0)
  status                             作業ツリーの変更を表示
  verify                             CAS object storeとSnapshot DAGを検査
  shot <file|dir...>                 選択した変更を即Snapshot化
  shot -A                            全ファイルの差分をSnapshot化
  stage <file|dir...>                shot の別名 (indexなし)
  move <old> <new>                   改名を単一Snapshotにする
  parallel list                      Parallelを一覧表示
  parallel fork <name> [--from REF]  任意Snapshotを種に独立S0を生成
  parallel switch <name>             作業ツリーとParallelを切替
  log [parallel]                     独立Snapshot列を表示
  show <ref>                         Snapshot情報とファイル一覧
  diff <left> <right>                ファイル単位で差分を表示
  coverage <left> <right> [--json]   合成可能率と競合候補を表示
  compose <source> [--into NAME]     指定ParallelのHEADと任意Snapshotを合成
         [--take path=left|right|base|REF]... [--dry-run]

参照: HEAD, main, main@0, other@3, Snapshot IDの先頭7文字以上
内部: SHA-256 CAS / Merkle DAG / Seed / 3-way Compose
注意: MVPの競合判定はファイル単位。rename検出や行単位の合成は未対応。
`;
const argv = process.argv.slice(2);
const command = argv.shift();
function fail(message: string): never {
  throw new VcsError(message);
}
function repo(): Repo {
  return new Repo();
}
function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  if (!args[i + 1]) fail(`${flag} の値が必要`);
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}
function takeAll(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (;;) {
    const v = valueAfter(args, flag);
    if (v === undefined) return out;
    out.push(v);
  }
}
function only(args: string[], count: number): void {
  if (args.length !== count) fail(`引数が違うよ（必要: ${count}, 指定: ${args.length}）`);
}
function printCoverage(r: Repo, a: string, b: string, json: boolean) {
  const left = r.resolve(a), right = r.resolve(b);
  const c = r.compare(left, right);
  const conflicts = c.conflicts.map(x => ({ path: x.path, options: r.candidates(c, x.path) }));
  if (json) {
    console.log(JSON.stringify(
      {
        base: c.base,
        left,
        right,
        total: c.touched,
        clean: c.clean,
        conflicts,
        coverage: c.percentage,
      },
      null,
      2,
    ));
    return;
  }
  console.log(`Base: ${short(c.base)}  A: ${short(left)}  B: ${short(right)}`);
  console.log(`Coverage: ${c.percentage.toFixed(1)}%  (${c.clean}/${c.touched} 非競合, ${c.conflicts.length} 競合)`);
  for (const conflict of conflicts) {
    console.log(`\n!! ${conflict.path}`);
    for (const o of conflict.options) console.log(`   ${o.ref.padEnd(16)} ${short(o.hash).padEnd(12)} ${o.origin}`);
  }
}
try {
  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(help);
      break;
    case "init": {
      only(argv, 0);
      const r = Repo.init();
      console.log(`Initialized ${r.meta}  main@0=${short(r.head())}`);
      break;
    }
    case "status": {
      only(argv, 0);
      const r = repo(), s = r.status();
      console.log(`Parallel: ${r.state.active}  HEAD ${short(r.head())}`);
      for (const p of s.modified) console.log(` M ${p}`);
      for (const p of s.deleted) console.log(` D ${p}`);
      for (const p of s.untracked) console.log(` ? ${p}`);
      if (!s.modified.length && !s.deleted.length && !s.untracked.length) console.log("clean");
      break;
    }
    case "verify": {
      only(argv, 0);
      const report = repo().verify();
      if (report.errors.length) {
        for (const error of report.errors) console.error(`error: ${error}`);
        console.error(`検証失敗: ${report.errors.length}件 / ${report.objectCount} objects`);
        process.exitCode = 1;
      } else console.log(`Verified ${report.objectCount} objects`);
      break;
    }
    case "shot":
    case "stage": {
      const all = argv.includes("-A") || argv.includes("--all");
      const paths = argv.filter(p => p !== "-A" && p !== "--all");
      const r = repo(), out = r.shot(paths, all);
      console.log(
        out.id
          ? `Snapshot ${r.state.active}@${r.snapshot(out.id).seq} ${short(out.id)}: ${out.changed.join(", ")}`
          : "差分なし (Snapshotは増えない)",
      );
      break;
    }
    case "move":
    case "mv": {
      only(argv, 2);
      const r = repo(), out = r.move(argv[0], argv[1]);
      console.log(`Moved ${argv[0]} → ${argv[1]}  Snapshot ${short(out.id)}`);
      break;
    }
    case "parallel": {
      const sub = argv.shift();
      const r = repo();
      if (sub === "list" || !sub) {
        only(argv, 0);
        const s = r.state;
        for (const [name, id] of Object.entries(s.heads)) {
          console.log(`${name === s.active ? "*" : " "} ${name.padEnd(16)} @${r.snapshot(id).seq} ${short(id)}`);
        }
      } else if (sub === "fork" || sub === "create") {
        const from = valueAfter(argv, "--from") || "HEAD";
        only(argv, 1);
        const id = r.fork(argv[0], from);
        console.log(`Fork ${argv[0]}@0 ${short(id)}  Seed: ${from}`);
      } else if (sub === "switch") {
        only(argv, 1);
        const id = r.switch(argv[0]);
        console.log(`Switched to ${argv[0]} ${short(id)}`);
      } else fail(`不明なparallel操作: ${sub}`);
      break;
    }
    case "log": {
      if (argv.length > 1) fail("log [parallel]");
      const r = repo();
      for (const { id, snapshot: s } of r.lineage(argv[0])) {
        console.log(
          `${s.parallel}@${s.seq} ${short(id)} ${s.parents.length === 2 ? " [compose]" : ""}${
            s.seed ? ` [seed ${short(s.seed)}]` : ""
          }`,
        );
      }
      break;
    }
    case "show": {
      only(argv, 1);
      const r = repo(), id = r.resolve(argv[0]), s = r.snapshot(id);
      console.log(JSON.stringify({ id, ...s, files: r.readTree(s.root) }, null, 2));
      break;
    }
    case "diff": {
      only(argv, 2);
      const r = repo();
      for (const d of r.diff(argv[0], argv[1])) {
        console.log(`${d.status} ${d.path}  ${short(d.before)} → ${short(d.after)}`);
      }
      break;
    }
    case "coverage": {
      const json = argv.includes("--json");
      const a = argv.filter(p => p !== "--json");
      only(a, 2);
      printCoverage(repo(), a[0], a[1], json);
      break;
    }
    case "compose": {
      const into = valueAfter(argv, "--into");
      const takes = takeAll(argv, "--take");
      const dry = argv.includes("--dry-run");
      const remaining = argv.filter(p => p !== "--dry-run");
      only(remaining, 1);
      const choices: Record<string, string> = {};
      for (const t of takes) {
        const i = t.indexOf("=");
        if (i < 1 || i === t.length - 1) fail("--take path=left|right|base|REF を指定してね");
        choices[t.slice(0, i)] = t.slice(i + 1);
      }
      const r = repo();
      const { composition: c, unresolved, id } = r.compose(remaining[0], into, choices, dry);
      console.log(
        `Coverage: ${c.percentage.toFixed(1)}%  (${c.clean}/${c.touched} 非競合, ${c.conflicts.length} 競合)`,
      );
      if (unresolved.length) {
        console.log("Composeは未実行。以下を選択してね:");
        for (const p of unresolved) {
          console.log(` !! ${p}`);
          for (const o of r.candidates(c, p)) console.log(`    ${o.ref} (${short(o.hash)}) ${o.origin}`);
        }
        console.log("例: pvc compose other --take file.txt=right");
        process.exitCode = 2;
      } else if (dry) console.log("Dry-run: Snapshot・作業ツリーは未変更");
      else if (id) {
        console.log(
          `Composed ${into || r.state.active}@${r.snapshot(id).seq} ${short(id)}  parents=[${short(c.left)}, ${
            short(c.right)
          }]`,
        );
      } else console.log("Compose不要");
      break;
    }
    default:
      fail(`不明なコマンド: ${command}\npvc help を参照`);
  }
} catch (e) {
  if (e instanceof VcsError) {
    console.error(`pvc: ${e.message}`);
    process.exitCode = 1;
  } else throw e;
}
