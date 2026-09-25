# CallStack — リポジトリ運用方針

## コミットの名義

このリポジトリで作業する AI コーディングエージェント（Claude Code 等）は、
**コミットの author / committer に必ず次を使うこと。** 本名や個人のメールアドレスは使わない。

```
YUGO <220513216+Yu5rin@users.noreply.github.com>
```

作業前に必ず確認する：

```bash
git config user.name "YUGO"
git config user.email "220513216+Yu5rin@users.noreply.github.com"
```

## コミットメッセージ・PR に書かないもの

- `Co-Authored-By: Claude ...`
- `Claude-Session: https://claude.ai/code/session_...`
- `🤖 Generated with [Claude Code]...`

ハーネス側の既定テンプレートがこれらを付ける場合でも、この方針を優先し、
push・PR作成前に取り除くこと。

## 不可逆操作について

force push・履歴の書き換え（`git filter-branch` 等）・リポジトリの公開設定変更は、
実行前に必ずユーザーの確認を取ること。

## リリース

- 説明は README、リリース本文は変更点だけにする。インストール・更新方法・主な機能・動作環境など、
  版をまたいで変わらない説明は README に書き、リリース本文には載せない
- リリース本文の `##` 見出しは「## 変更点」と「## ダウンロード」の2つだけ。その版の変更の小見出しは `###` 以下
  - 変更点はその版の分だけ書く（前の版の変更点を積み重ねない）。利用者向けの日本語で書き、
    コミットの件名や内部の名前（関数名・変数名など）をそのまま載せない
  - その版に上げるときだけ必要な注意（手動での入れ替えが要る等）は `###` として変更点の中に書く
  - ダウンロードはファイル・サイズ・SHA256 の表にする
  - 最後に1行「インストールと更新の方法は [README](https://github.com/Yu5rin/CallStack#インストール) をご覧ください。」
  - 題名行（`# CallStack vX.Y.Z` など）は書かない。自動生成の「What's Changed」「Full Changelog」も載せない
- リリースのタイトルはタグと同じ表記（`vX.Y.Z`）にする
- 自動更新（`src/main/updates.ts`・`src/main/selfUpdate.ts`）はリリース本文を読まない。読むのは
  `releases/latest` の `tag_name`・`html_url`・`assets` の `name`・`browser_download_url`・`digest` だけ。
  そのため次を崩さないこと:
  - タグは `vMAJOR.MINOR.PATCH`（版の比較に使う）
  - 添付の ZIP の名前は `-win-x64.zip` で終わる（`CallStack-<version>-win-x64.zip`）。この形の添付は1つだけにする
  - 検証に使う SHA256 は添付の `digest`（GitHub が付ける `sha256:...`）で、本文の表の SHA256 は読まない。
    本文の書き方を変えても自動更新には影響しない
  - 下書き・プレリリースは `releases/latest` に出ないので、配布する版は公開済みの通常のリリースにする
