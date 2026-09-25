import { app, net } from 'electron';
import { logInfo } from './log';
import { describeNetError } from './whisperBinary';

/** 更新確認 API の全体タイムアウト（応答が来ないまま「確認中…」に固まるのを防ぐ） */
const CHECK_TIMEOUT_MS = 15_000;

/**
 * GitHub Releases を使った軽量な更新チェック（通知型）。
 * コード署名なしでも安全に使えるよう、自動インストールはせず
 * 新バージョンの存在を知らせてリリースページへ誘導する。
 */

const LATEST_API = 'https://api.github.com/repos/Yu5rin/CallStack/releases/latest';
export const RELEASES_PAGE = 'https://github.com/Yu5rin/CallStack/releases/latest';

export interface UpdateCheckResult {
  ok: boolean;
  current: string;
  latest?: string;
  hasUpdate?: boolean;
  url?: string;
  error?: string;
  /** Windows 用 zip アセットの直リンク（自己更新に使う。見つからない場合は undefined） */
  assetUrl?: string;
  /** アセットの SHA256（GitHub が算出した digest。'sha256:'は取り除いた16進文字列） */
  assetSha256?: string;
}

function parseVer(v: string): number[] {
  const m = v.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function isNewer(latest: string, current: string): boolean {
  const a = parseVer(latest);
  const b = parseVer(current);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

export function checkForUpdate(): Promise<UpdateCheckResult> {
  const current = app.getVersion();
  return new Promise((resolve) => {
    const req = net.request({ url: LATEST_API, method: 'GET', redirect: 'follow' });
    req.setHeader('Accept', 'application/vnd.github+json');
    let settled = false;
    const finish = (result: UpdateCheckResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    // 応答が来ないまま「確認中…」に固まらないよう、全体タイムアウトを設ける
    const timer = setTimeout(() => {
      req.abort();
      finish({ ok: false, current, error: describeNetError(new Error('timeout')) });
    }, CHECK_TIMEOUT_MS);
    req.on('response', (res) => {
      let body = '';
      res.on('data', (c: Buffer) => { body += c.toString(); });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          // 非公開リポジトリやオフラインでは取得できない。エラーは静かに返す。
          finish({ ok: false, current, error: describeNetError(new Error(`HTTP ${res.statusCode}`), res.statusCode) });
          return;
        }
        try {
          const json = JSON.parse(body) as {
            tag_name?: string;
            html_url?: string;
            assets?: Array<{ name: string; browser_download_url: string; digest?: string | null }>;
          };
          const latest = json.tag_name ?? '';
          // Windows 用 zip 配布アセット（例: CallStack-2.6.0-win-x64.zip）を探す
          const asset = (json.assets ?? []).find((a) => /-win-x64\.zip$/i.test(a.name));
          const digestMatch = asset?.digest?.match(/^sha256:([0-9a-f]{64})$/i);
          finish({
            ok: true,
            current,
            latest: latest.replace(/^v/, ''),
            hasUpdate: isNewer(latest, current),
            url: json.html_url ?? RELEASES_PAGE,
            assetUrl: asset?.browser_download_url,
            assetSha256: digestMatch ? digestMatch[1].toLowerCase() : undefined,
          });
        } catch (err) {
          finish({ ok: false, current, error: describeNetError(err) });
        }
      });
      res.on('aborted', () => finish({ ok: false, current, error: describeNetError(new Error('aborted')) }));
      res.on('error', (err: Error) => finish({ ok: false, current, error: describeNetError(err) }));
    });
    req.on('error', (err) => finish({ ok: false, current, error: describeNetError(err) }));
    req.end();
  });
}

/** 起動時の静かな更新確認。新版があるときだけ true を返す。 */
export async function checkOnStartup(): Promise<UpdateCheckResult | null> {
  const r = await checkForUpdate();
  logInfo('update', r.ok
    ? `check: current=${r.current} latest=${r.latest} hasUpdate=${r.hasUpdate}`
    : `check failed: ${r.error}`);
  if (r.ok && r.hasUpdate) return r;
  return null;
}
