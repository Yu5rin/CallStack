/**
 * 内部・英語のエラーメッセージをユーザー向けの日本語メッセージへ変換する。
 * スタックトレースや絶対パスなど、ユーザーに見せるべきでない情報は取り除く。
 */

// Windows の絶対パス（例: C:\Users\foo\bar.txt）
const WIN_PATH_RE = /[A-Za-z]:\\[^\s"')]+/g;
// POSIX の絶対パス（例: /Users/foo/bar.txt）
const POSIX_PATH_RE = /(?:^|[\s(])\/(?:[^\s"')]+\/)+[^\s"')]*/g;

function stripPaths(msg: string): string {
  return msg.replace(WIN_PATH_RE, '').replace(POSIX_PATH_RE, ' ');
}

// Electron の IPC 呼び出しが付与するプレフィックスを取り除く
// 例: "Error invoking remote method 'foo': Error: bar" -> "bar"
function stripIpcPrefix(msg: string): string {
  return msg
    .replace(/^Error invoking remote method '[^']*':\s*/i, '')
    .replace(/^Error:\s*/, '');
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err === null || err === undefined) return '';
  try {
    return String(err);
  } catch {
    return '';
  }
}

// メッセージが概ね日本語（ひらがな・カタカナ・漢字）で構成されているかを判定する。
// 英語主体の内部エラーはそのまま出さず fallback にする。
function isMostlyJapanese(msg: string): boolean {
  const jp = msg.match(/[\u3040-\u30ff\u3400-\u9fff]/g)?.length ?? 0;
  const letters = msg.match(/[A-Za-z\u3040-\u30ff\u3400-\u9fff]/g)?.length ?? 0;
  if (letters === 0) return false;
  return jp / letters >= 0.5;
}

export function toUserMessage(err: unknown, fallback = '予期しないエラーが発生しました'): string {
  const raw = extractMessage(err).trim();
  if (!raw) return fallback;

  let msg = stripIpcPrefix(raw);

  if (/\bEACCES\b|\bEPERM\b/.test(msg)) {
    return 'ファイルへのアクセス権がありません（別のアプリで開いていないか、保存先の権限を確認してください）';
  }
  if (/\bENOSPC\b/.test(msg)) return 'ディスクの空き容量が不足しています';
  if (/\bENOENT\b/.test(msg)) return 'ファイルまたはフォルダが見つかりません';
  if (/\bEBUSY\b/.test(msg)) return 'ファイルが使用中です';
  if (/SyntaxError/.test(msg) && /(Unexpected token|JSON)/i.test(msg)) {
    return 'ファイルの形式が正しくありません（JSON として読み込めませんでした）';
  }
  if (/\bENOTFOUND\b|\bECONNRESET\b|\bETIMEDOUT\b|net::ERR_/.test(msg)) {
    return 'インターネットに接続できません';
  }
  if (/NotAllowedError|Permission denied/i.test(msg)) {
    return 'マイクへのアクセスが許可されていません。Windows の設定 → プライバシー → マイク を確認してください';
  }
  if (/NotFoundError/.test(msg)) return 'マイクが見つかりません';
  const httpMatch = msg.match(/HTTP (\d+)/);
  if (httpMatch) return `サーバーエラー (HTTP ${httpMatch[1]})`;

  msg = stripPaths(msg).replace(/\s{2,}/g, ' ').trim();
  if (!msg) return fallback;

  return isMostlyJapanese(msg) ? msg : fallback;
}
