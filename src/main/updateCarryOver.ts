/**
 * 自動更新でインストール先フォルダを入れ替えたあと、旧フォルダ（<インストール先>.old）から
 * 新しいフォルダへ「利用者が手で置いたもの」を引き継ぐための判断ロジック。
 *
 * なぜ必要か:
 *   自己更新（selfUpdate.ts）はインストール先をフォルダごと入れ替え、旧フォルダは
 *   次回起動時に丸ごと削除する。ところが resources\whisper\README.txt は利用者に
 *   「whisper.cpp の exe と DLL をこのフォルダに置く」よう案内しており、配布 zip の
 *   同フォルダには README.txt しか入っていない。そのため、手で置いた whisper.cpp は
 *   更新のたびに旧フォルダと一緒に消え、文字起こしが突然できなくなっていた。
 *   （アプリ内からダウンロードした whisper.cpp とモデルは userData 側
 *   = %APPDATA%\CallStack\whisper / models にあるので、入れ替えの影響は受けない）
 *
 * 外の世界に触れない。フォルダの中身は呼び出し側が調べて渡す。
 */

/** インストール先の中で、利用者が手でファイルを置くよう案内している場所（resources からの相対） */
export const USER_PLACED_RESOURCE_DIRS = ['whisper'] as const;

/**
 * 旧フォルダから新しいフォルダへ移す項目名を返す。
 * 新しい側に同名のもの（新しい版に同梱された README.txt など）があれば、新しい側を正として移さない。
 * Windows ではファイル名の大文字小文字を区別しないので、caseInsensitive で比較を合わせる。
 */
export function planCarryOver(oldEntries: readonly string[], newEntries: readonly string[], caseInsensitive: boolean): string[] {
  const norm = (n: string) => (caseInsensitive ? n.toLowerCase() : n);
  const existing = new Set(newEntries.map(norm));
  return oldEntries.filter((name) => !existing.has(norm(name)));
}
