# HDS分割ツール v0.0.1

## 概要
X68000 の SCSI HDD イメージ (`.hds`) が複数パーティションを持つ場合に、
**1 パーティション = 1 ファイル**の `.hds` へ分割する Node.js ツールです。

## インストール
実行にはNode.jsが必要です。下記からダウンロードしてインストールしてください。  
https://nodejs.org/ja

## 使い方

```sh
# パーティション構成を確認する
node hds-split.mjs list SCSIHDD1.HDS

# ルートディレクトリと使用量も見る
node hds-split.mjs list SCSIHDD1.HDS --dir

# 分割する
node hds-split.mjs split SCSIHDD1.HDS

# 分割後のイメージが元イメージとバイト単位で一致するか確認する
node hds-split.mjs verify SCSIHDD1.HDS SCSIHDD1-p2-Human68k.hds
```

出力は `<元の名前>-p<スロット番号>-<パーティション名>.hds`

### オプション (`split`)

| オプション | 説明 |
|---|---|
| `-o`, `--out-dir <dir>` | 出力先ディレクトリ (既定: 入力ファイルと同じ場所) |
| `--prefix <name>` | 出力ファイル名の先頭 (既定: 入力ファイル名から拡張子を除いたもの) |
| `--only <1,3>` | 指定したスロットのみ出力する (list に表示されるスロット番号) |
| `--reserve <n>` | 予約領域のサイズを 1024 B 単位で指定 |
| `--keep-start` | パーティション開始セクタを元の値のまま保持する |
| `--entry-flag <n>` | パーティションエントリのフラグバイト (+0x08) の値 |
| `--overwrite` | 既存の出力ファイルを上書きする |
| `--dry-run` | 書き込まず出力予定のみ表示する |

入力イメージは常に読み取り専用で開きます。元ファイルは書き換えません。

## リリースノート

### 0.0.1

初版
