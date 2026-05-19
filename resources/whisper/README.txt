このフォルダに whisper.cpp の Windows 実行ファイルを配置してください。

手順:
1. https://github.com/ggerganov/whisper.cpp/releases から
   最新の Windows ビルドを取得（例: whisper-blas-bin-x64.zip）
2. zip 内の `main.exe` または `whisper-cli.exe` をこのフォルダにコピー
3. `whisper-cli.exe` という名前にリネーム（または同名のファイル名そのまま）

ファイル例:
  resources/whisper/whisper-cli.exe

開発時にこのフォルダ以外の場所に置きたい場合は環境変数
  TELTIMESTACK_WHISPER_BIN=C:\path\to\whisper-cli.exe
を設定すると優先されます。

モデルファイル（ggml-*.bin）は設定画面の「文字起こし」セクションから
自動でダウンロードできます（%APPDATA%/TelTimeStack/models/ に保存）。
