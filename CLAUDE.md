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
