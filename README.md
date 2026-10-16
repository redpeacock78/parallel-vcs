# Parallel VCS / `pvc` v0.1.0

> **実験的な独立Snapshot型VCS** — ブランチの代わりに独立した並行世界（Parallel）を持ち、任意の過去SnapshotをSeedに派生し、Snapshot同士をComposeする。

標準的なGitのラッパーではなく、`.pvc/objects/`に独自のSHA-256 Content Addressable Storage (CAS) を持つ。データ構造は **Blob → Tree → Snapshot → Parent/Seed (Merkle DAG)**。

## 要件

- Node.js **22.6以上**（推奨24以上）
- データ構造とCLIはTypeScript。Nodeの組み込み型消去機構でそのまま実行できるため、**実行にnpm installは不要**。
- テストと開発用lintには`npm ci`が必要。
- POSIX環境では`bin/pvc`を実行可能（適宜`PATH`に追加）。以下の例では`pvc`がこのスクリプトを指すものとする。

```sh
# 解凍後、場所を固定して使う
export PATH="/path/to/parallel-vcs/bin:$PATH"
pvc help
```

`npm run pvc -- <commands>`でも実行できる。Nodeから直接起動する場合は、次のコマンドを使う。

```sh
node --experimental-strip-types /path/to/parallel-vcs/src/cli.ts <commands>
```

## 開発チェック

```sh
npm ci
npm test
npm run check
npm run lint
```

`npm run lint`はdprintの整形チェックとREADMEのtextlintを実行する。`npm run verify`はテスト、型チェック、lintをまとめて実行し、GitHub Actionsでも使う。

## 5分で試す

```sh
mkdir /tmp/pvc-playground && cd /tmp/pvc-playground
pvc init                       # main@0 = 空のS0
printf 'hello\n' > readme.txt
pvc shot readme.txt            # main@1
pvc parallel fork alternate    # main@1 をSeedに alternate@0

printf 'main only\n' > a.txt
pvc shot a.txt                 # main@2
pvc parallel switch alternate
printf 'alternate only\n' > b.txt
pvc stage b.txt                # alternate@1

pvc coverage main alternate    # Coverage: 100% (別ファイルなので無競合)
pvc parallel switch main
pvc compose alternate         # main@3 = 2つの親を持つSnapshot
pvc log main
```

### 競合を起こす例

```sh
pvc parallel fork variant
printf 'main\n' > readme.txt
pvc shot readme.txt
pvc parallel switch variant
printf 'variant\n' > readme.txt
pvc shot readme.txt
pvc coverage main variant
# ファイル競合が列挙される: left / right / base / 過去のSnapshot（削除状態も候補）
pvc parallel switch main
pvc compose variant                       # 未解決 → exit 2、何も保存しない
pvc compose variant --take readme.txt=right
# ↑ または --take readme.txt=main@1 など過去のSnapshotを採用
```

## コマンド一覧

| コマンド                                  | 説明                                                            |
| ----------------------------------------- | --------------------------------------------------------------- |
| `pvc init`                                | `main@0`を生成                                                  |
| `pvc status`                              | 作業ツリーの変更状態を表示                                      |
| `pvc verify`                              | CAS object storeとSnapshot DAGの整合性を確認                    |
| `pvc shot file1 [file2...]` / `pvc stage` | 選択変更の差分のみを使い、即Snapshot化。ステージング領域なし    |
| `pvc shot -A`                             | 未追跡追加・変更・削除を一括でShot                              |
| `pvc move from to`                        | 1回の改名につき1つのSnapshotを作成。Blobは再利用                |
| `pvc parallel list`                       | 世界ごとのHEAD                                                  |
| `pvc parallel fork NAME [--from REF]`     | 任意の過去Snapshotから独立S0を生成                              |
| `pvc parallel switch NAME`                | 並行世界を切替。未保存の変更や上書きを拒否                      |
| `pvc log [NAME]`                          | 世界固有の第一親Snapshot列（S0まで）                            |
| `pvc show REF`                            | CAS Snapshot内容                                                |
| `pvc diff A B`                            | ファイル単位差分                                                |
| `pvc coverage A B [--json]`               | 共通祖先ベースの3-way合成シミュレーションと候補列挙             |
| `pvc compose SOURCE [--into PARALLEL]`    | 合成先ParallelのHEADと任意SnapshotをCompose                     |
| `pvc compose SOURCE --take PATH=left`     | 競合ごとに明示選択。`right`, `base`, 過去のSnapshot参照も選択可 |
| `pvc compose SOURCE --dry-run`            | 参照/合成だけ行い、保存しない                                   |

参照には`HEAD`、Parallel名、`main@0`のような世代番号、SnapshotのSHA-256ハッシュ（7文字以上の一意な接頭辞）が使える。

次の手順で、任意の2つの過去SnapshotをComposeできます。

```sh
pvc parallel fork mix --from alpha@2
pvc compose beta@4 --into mix
```

これで`mix@1`は`alpha@2`（Seed先の世界のrootを持つmix@0）と`beta@4`のデータを統合し、親は`mix@0`と`beta@4`になる。

## 不変条件と意味論

1. S0: forkで生成されるSnapshotは`seq=0, parents=[]`。`seed=<元Snapshot ID>`を別フィールドに保持し、S0の独立性と由来を両立する。
2. Shot: 作業ツリー中の選択ファイルと現在のHEADのTreeを比較し、差分があれば現在Parallelに`seq+1, parents=[HEAD]`でAppendする。addとcommitの二段階操作はない。
3. Compose: 既存のHEADと指定Snapshotの3-way比較。共通祖先はParentとSeedの両エッジを使い探索する。合成先に`parents=[oldHEAD, source]`のSnapshotをAppendする。
4. 3-way（ファイル単位）: `left==right`、`left==base`、`right==base`のいずれかなら競合しない。どれにも該当しないと競合。
5. Coverage: `(競合せず確定できる変更ファイル数 / 変更されたファイル数) × 100`。ファイル数基準、変更がなければ100%。行数や意味論の無競合率ではない。
6. 競合: 自動上書きしない。共通祖先、左右双方、到達可能な過去Snapshot中の異なるBlob候補（削除状態も含む）を提示し、明示的な`--take`を要求する。
7. 安全性: 未Shotの追跡ファイルと上書き対象の未追跡ファイルは保護する。CAS読み出し時はSHA-256を再計算する。symlinkはMVPでは拒否。
8. 作業ツリー更新: switchとactive ParallelへのComposeは、更新ファイルを先に一時領域へ準備してjournalを残す。同期I/Oエラーでは元へ戻し、プロセスが途中終了した場合は次回起動時に旧作業ツリーと旧stateへ復旧する。

## 内部データモデル

```ts
// .pvc/objects/xx/<sha256-of-json>
type Blob = { kind: "blob"; data: string }; // base64

type Tree = { kind: "tree"; files: Record<string, SHA256> };

type Snapshot = {
  kind: "snapshot";
  parallel: string;
  seq: number;
  root: SHA256; // Treeのハッシュ
  parents: SHA256[]; // Shot:1 / Compose:2 / S0:0
  seed: SHA256 | null;
  createdAt: string;
};
```

`.pvc/state.json`は`{format, active, heads}`だけを保持する。ファイル内容のBlobはSnapshotを超えて共有できる。

## 制約 / 今後の設計対象

**このバージョンは破壊的な実運用を想定しないPoC。必ずテスト用ディレクトリで試すこと。**

- ファイル単位の3-wayのみ。renameは1つのShot内の削除＋作成として記録され、Blobの同一性は保つが、操作の意味を独立したMutationとしてはまだ格納しない。
- 同名のファイル/ディレクトリ衝突、ファイルモード・実行権限・symlink、ignoreの外部設定、GC、remote/同期、pack圧縮、WAL、電源断耐性は未実装。
- Criss-crossによる複数の最大共通祖先は**恣意的に選択せずエラー**。仮想Base合成は未実装。
- Coverageはファイル数ベースであり、テキストの行／AST単位の非競合率ではない。
- journalによるプロセスクラッシュ復旧はswitchとactive Composeが対象。moveなど他コマンドの中断や電源断に対する永続性は保証しない。
- 中断後に復旧対象ファイルがjournalの旧/新内容と一致しない場合は、自動上書きを避けて復旧を停止する。
- fork、shot、move、switch、composeは`.pvc/txn-active`の排他slotを原子的に取得してからstateを読み、並行する更新を拒否する。switchとactive Composeはjournalでプロセスクラッシュから復旧する。
- `pvc verify`はCAS objectのhash、形式、blob/tree/snapshot間の参照、stateのHEADを確認する。中断した操作による未参照オブジェクトは許容する。
- Treeのファイルpathはroot-relative POSIX形式で保存する。
- absolute path、parent traversal、NUL byte、backslash、Windowsのdrive-relative pathはShotできない。Windowsで無効な文字、予約デバイス名、末尾の空白・ドットを含むpathもShotできない。
- Windowsで同じpathとして扱われるTree entryの衝突もShot時に拒否する。
- 復旧中にプロセスが再度停止すると`.pvc/txn-active/recovery.lock`が残る。復旧が動いていないことを確認してからこのlockを削除し、コマンドを再実行する。
- `origin`と`proof`をTopazoliteに接続する余地を設計上残しているが、**証明体系の実装は含まない**。

将来的には`Mutation`を第一級オブジェクトにし、テキスト/AST/Locus単位の競合分析と、合成由来を示すProofを検討する。
その後、Git/Hg Revisionバックエンド、Gitなしのリモート伝搬、scriptcによる単体バイナリ化を検討する。

## テスト

```sh
npm ci
npm test
npm run check
npm run lint
npm run verify  # まとめて実行
```
