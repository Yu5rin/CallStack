このフォルダに whisper.cpp の Windows ビルドを配置してください。

手順:
1. https://github.com/ggerganov/whisper.cpp/releases から
   最新の Windows ビルドを取得（例: whisper-bin-x64.zip）
2. zip を解凍し、その「中身を丸ごと」このフォルダにコピー
   - whisper-cli.exe
   - whisper.dll
   - ggml.dll / ggml-base.dll / ggml-cpu.dll  など
   ※ exe 単体だけだと STATUS_DLL_NOT_FOUND (0xC0000135) で失敗します
3. 実行ファイル名が main.exe の古いビルドの場合は whisper-cli.exe にリネーム

ファイル例:
  resources/whisper/whisper-cli.exe
  resources/whisper/whisper.dll
  resources/whisper/ggml.dll
  resources/whisper/ggml-base.dll
  resources/whisper/ggml-cpu.dll

開発時にこのフォルダ以外の場所に置きたい場合は環境変数
  TELTIMESTACK_WHISPER_BIN=C:\path\to\whisper-cli.exe
を設定すると優先されます（同フォルダの DLL もそちらから読まれます）。

モデルファイル（ggml-*.bin）は設定画面の「文字起こし」セクションから
自動でダウンロードできます（%APPDATA%/TelTimeStack/models/ に保存）。
