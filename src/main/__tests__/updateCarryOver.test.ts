import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCarryOver, USER_PLACED_RESOURCE_DIRS } from '../updateCarryOver.ts';

// 自動更新はインストール先をフォルダごと入れ替え、旧フォルダ(.old)を次回起動時に消す。
// 配布 zip の resources\whisper には README.txt しか無いので、利用者が手で置いた
// whisper.cpp を引き継がないと更新のたびに消えていた。その引き継ぎ対象の決め方を固定する。

test('手で置いた whisper.cpp の exe と DLL は、更新後のフォルダへ引き継ぐ', () => {
  const oldEntries = ['README.txt', 'whisper-cli.exe', 'whisper.dll', 'ggml.dll', 'ggml-base.dll', 'ggml-cpu.dll'];
  const newEntries = ['README.txt'];
  assert.deepEqual(planCarryOver(oldEntries, newEntries, true), [
    'whisper-cli.exe', 'whisper.dll', 'ggml.dll', 'ggml-base.dll', 'ggml-cpu.dll',
  ]);
});

test('新しい版に同梱されたファイル（README.txt 等）は新しい側を正とし、旧版のもので上書きしない', () => {
  assert.deepEqual(planCarryOver(['README.txt'], ['README.txt'], true), []);
});

test('Windows ではファイル名の大文字小文字を区別しないので、表記違いの同名ファイルも上書きしない', () => {
  assert.deepEqual(planCarryOver(['readme.TXT', 'Whisper-CLI.exe'], ['README.txt'], true), ['Whisper-CLI.exe']);
  // 区別するファイルシステムでは別物として扱う
  assert.deepEqual(planCarryOver(['readme.TXT'], ['README.txt'], false), ['readme.TXT']);
});

test('手で置いたモデルやサブフォルダも、消さずにそのまま引き継ぐ', () => {
  assert.deepEqual(planCarryOver(['ggml-base.bin', 'whisper-bin-x64'], ['README.txt'], true), ['ggml-base.bin', 'whisper-bin-x64']);
});

test('新しい側のフォルダが無い（将来 README を同梱しなくなった）場合も全部引き継ぐ', () => {
  assert.deepEqual(planCarryOver(['whisper-cli.exe'], [], true), ['whisper-cli.exe']);
});

test('旧フォルダが README.txt だけ（手で何も置いていない）なら何もしない', () => {
  assert.deepEqual(planCarryOver(['README.txt'], ['README.txt'], true), []);
  assert.deepEqual(planCarryOver([], ['README.txt'], true), []);
});

test('引き継ぎ対象は、README で手置きを案内している resources\\whisper', () => {
  assert.deepEqual([...USER_PLACED_RESOURCE_DIRS], ['whisper']);
});
