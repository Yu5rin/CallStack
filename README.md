# TelTimeStack

電話の通話時間をキーボードショートカットで記録するWindows向けデスクトップアプリ。

## 主な機能

- **グローバルショートカット** で通話の開始／終了を記録（既定 `Ctrl+Shift+S` / `Ctrl+Shift+E`）
- **累積記録** を JSON で永続化＋日次バックアップ
- **CSV エクスポート**（UTF-8 + BOM で Excel 対応）
- **通話時間サマリー**（合計／平均／最長／最短／今日・今週・今月）
- **統計ダッシュボード**（過去30日の棒グラフ、タグ別パイチャート、時間帯別ヒストグラム）
- **タグ／カテゴリ** とメモ、連絡先名・電話番号の事後編集
- **システムトレイ常駐** と **通話中の HUD ウィンドウ**（常時最前面、経過時間を1秒更新）
- **長電話アラート**（指定分経過で OS 通知）
- **音声フィードバック**（開始／終了時のビープ音）
- **週次マークダウンレポート** 出力
- **検索／フィルター**（タグ・メモ・連絡先・電話番号の部分一致＋未タグ抽出）
- **手動追加** で記録を後から作成も可能

## 前提条件

| 項目 | 必要バージョン |
|------|---------------|
| OS   | Windows 10 / 11（`.exe` ビルドの場合は必須） |
| Node.js | **18 以上**（推奨 20 LTS 以降） |
| npm  | Node.js 同梱版でOK |
| Git  | リポジトリのクローンに使用 |

確認コマンド（PowerShell またはコマンドプロンプト）：

```powershell
node --version    # v20.x.x など
npm --version     # 10.x.x など
git --version
```

Node.js が未インストールなら https://nodejs.org/ja から LTS 版をインストールしてください。

## セットアップ手順（はじめての方向け）

> ⚠️ **すべてのコマンドは「TelTimeStack フォルダの中」で実行します。**
> まず `cd` でこのプロジェクトのフォルダに移動してから npm コマンドを実行してください。

### 1. リポジトリをクローン（または既存フォルダへ移動）

PowerShell またはコマンドプロンプトを開き、好きな作業フォルダに移動してからクローン：

```powershell
# 例: ホーム配下に置く場合
cd $HOME
git clone https://github.com/Yu5rin/TelTimeStack.git
cd TelTimeStack
```

すでに `TelTimeStack` フォルダがあるなら、そのフォルダに `cd` してください：

```powershell
cd C:\path\to\TelTimeStack
```

ブランチが必要なら：

```powershell
git fetch origin
git checkout claude/call-tracking-app-aF1y4
```

### 2. 依存パッケージのインストール

**`package.json` があるフォルダ（= `TelTimeStack` 直下）** で：

```powershell
npm install
```

- 5〜10 分ほどかかります（Electron バイナリのダウンロードを含むため）
- 完了後、`node_modules` フォルダが作成されます
- 社内プロキシ環境などで Electron のダウンロードに失敗する場合は、後述の「よくあるエラー」を参照

### 3. 開発モードで起動

```powershell
npm run dev
```

- Vite 開発サーバーが立ち上がり、自動的に Electron ウィンドウが開きます
- ホットリロード対応：UI を変更するとすぐ反映されます
- 終了するには、ターミナルで `Ctrl+C`、またはアプリのトレイメニューから「終了」

### 4. プロダクションビルド（型チェック＋アセット出力）

```powershell
npm run build
```

- 型チェック → `dist/`（UI）と `dist-electron/`（main・preload）が生成されます
- まだ `.exe` にはなりません（次のステップで作ります）

### 5. Windows 用 `.exe` インストーラの作成

```powershell
npm run dist:win
```

- 完了後、`release/0.1.0/` フォルダに `TelTimeStack Setup 0.1.0.exe` が出力されます
- そのインストーラをダブルクリックしてインストールすれば、スタートメニューから起動できます

---

## キーボードショートカット（既定）

| 操作 | キー |
|------|------|
| 通話開始 | `Ctrl+Shift+S` |
| 通話終了 | `Ctrl+Shift+E` |
| メイン窓を表示/隠す | `Ctrl+Shift+T` |

アプリの「設定」ページで自由に変更できます。

## データの保存場所

| 内容 | パス |
|------|------|
| 設定・通話記録 | `%APPDATA%\TelTimeStack\data.json` |
| 自動バックアップ | `%APPDATA%\TelTimeStack\backups\data-YYYYMMDD.json`（最新30日分） |

エクスプローラーのアドレスバーに `%APPDATA%\TelTimeStack` と入れれば直接開けます。

## よくあるエラーと対処

### `'npm' は内部コマンドまたは外部コマンド…として認識されていません`
Node.js がインストールされていません。https://nodejs.org/ja から LTS 版をインストールし、ターミナルを開き直してください。

### `npm ERR! code ENOENT` / `package.json not found`
`package.json` のないフォルダで実行しています。`cd C:\path\to\TelTimeStack` でプロジェクトフォルダに移動してから再実行してください。`dir` で `package.json` が見えることを確認しましょう。

### `npm install` の途中で `Electron failed to install correctly` / ダウンロード失敗
社内ネットワーク・プロキシで Electron バイナリの取得に失敗するケース。以下のいずれかを試してください：

```powershell
# プロキシを設定
npm config set proxy http://your.proxy:port
npm config set https-proxy http://your.proxy:port

# Electron のミラーを指定（必要に応じて）
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"

# 再インストール
Remove-Item -Recurse -Force node_modules, package-lock.json
npm install
```

### `npm run dev` を打ったが何も起きない／ウィンドウが出ない
- ターミナルのログに `VITE v5...` が出るまで数秒待ってください
- Windows Defender が初回ブロックすることがあります。許可してください
- それでも出ない場合はログをコピーして共有してください

### `npm run dist:win` で「コード署名がありません」「サポートされていないプラットフォーム」など
- `.exe` ビルドは **Windows 上での実行が必須** です（macOS/Linux からはできません）
- 署名警告は通常運用上問題ありません（ローカル利用なら無視可）

### `Error: Cannot find module 'electron'`
`npm install` が完了していません。プロジェクトフォルダで `npm install` を再実行してください。

---

## スクリプト一覧

| コマンド | 用途 |
|----------|------|
| `npm install` | 依存をインストール（初回のみ／`package.json` 変更時） |
| `npm run dev` | 開発起動（ホットリロードあり） |
| `npm run typecheck` | TypeScript 型チェックのみ |
| `npm run build` | プロダクションビルド（`dist/` と `dist-electron/`） |
| `npm run dist:win` | Windows 用 `.exe`（NSIS）を `release/` に出力 |

## 技術スタック

Electron 33 + React 18 + TypeScript 5 + Vite 5 + Tailwind CSS 3 + Recharts + dayjs + nanoid

## ライセンス

MIT
