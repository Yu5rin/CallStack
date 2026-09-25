このフォルダに whisper.cpp の Windows ビルドを配置してください。

== 手順 ==

1. https://github.com/ggerganov/whisper.cpp/releases にアクセス
2. お使いの環境に合う Windows 用 zip を1つダウンロード
   - 一般的: whisper-blas-bin-x64.zip （CPU + BLAS、まず最初に試す）
   - 旧バージョン: whisper-bin-x64.zip
   - NVIDIA GPU: whisper-cublas-XX.X.X-bin-x64.zip （CUDA ランタイム必須）
   ※ x64 が無い古い PC のみ Win32 版を使用
3. zip を解凍し、「解凍された全ファイル」をこのフォルダに置く
4. 実行ファイル名を確認:
   - ファイル名が whisper-cli.exe ならそのまま
   - ファイル名が main.exe（古いビルド）の場合は whisper-cli.exe に
     リネーム

== 必要なファイル例 ==

resources/whisper/ に下記が並んでいれば OK（バージョン差で名前は微増減）:

  whisper-cli.exe        ← 必須（実行ファイル本体）
  whisper.dll
  ggml.dll
  ggml-base.dll
  ggml-cpu.dll
  ggml-cpu-haswell.dll   （任意、ある場合のみ）
  libopenblas.dll        （BLAS 版の場合）

注意: exe 単体だけだと起動時に「STATUS_DLL_NOT_FOUND (0xC0000135)」で
失敗します。zip の中身は丸ごとコピーしてください。

== モデルファイル ==

ggml-*.bin はアプリの設定画面「文字起こし」→「モデル」から
ダウンロードできます（%APPDATA%\CallStack\models\ に保存）。

== アプリからダウンロードする場合 ==

設定画面の「whisper.cpp をダウンロード」を使うと、このフォルダではなく
%APPDATA%\CallStack\whisper\ に保存され、こちらが優先して使われます。

== 自動更新について ==

このフォルダに手で置いたファイルは、アプリの自動更新のあと、最初の起動時に
新しい版の同じフォルダへ引き継がれます（新しい版に同名のファイルがある場合は
新しい版のものを使います）。

== 開発者向けの上書きパス ==

このフォルダ以外に置きたい場合は環境変数で上書き可能:

  TELTIMESTACK_WHISPER_BIN=C:\path\to\whisper-cli.exe

（同フォルダにある DLL も同時にそこから読まれます）
