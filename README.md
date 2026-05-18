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
- **週次マークダウンレポート** 出力（通話数・合計・タグ別・最長 TOP3）
- **検索／フィルター**（タグ・メモ・連絡先・電話番号の部分一致＋未タグ抽出）
- **手動追加** で記録を後から作成も可能

## キーボードショートカット（既定）

| 操作 | キー |
|------|------|
| 通話開始 | `Ctrl+Shift+S` |
| 通話終了 | `Ctrl+Shift+E` |
| メイン窓を表示/隠す | `Ctrl+Shift+T` |

設定画面で自由に変更できます。

## 開発

```sh
npm install
npm run dev        # 開発起動（Vite + Electron）
npm run typecheck  # 型チェック
npm run build      # プロダクションビルド（dist と dist-electron に出力）
npm run dist:win   # Windows 用 .exe (NSIS) を作成
```

## データ保存場所

- 設定・記録: `%APPDATA%/TelTimeStack/data.json`
- 自動バックアップ: `%APPDATA%/TelTimeStack/backups/data-YYYYMMDD.json`（最新30日分）

## 技術スタック

Electron + React + TypeScript + Vite + Tailwind CSS + Recharts + dayjs
