import { app, net } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { logInfo } from './log';
import { describeNetError } from './whisperBinary';
import {
  parseVersion,
  isNewer,
  buildAtomUrl,
  buildDownloadUrl,
  buildReleasePageUrl,
  buildLatestReleasePageUrl,
  extractLatestTagFromAtom,
} from './updateCheckLogic';

/**
 * GitHub Releases を使った更新チェック（通知型）。コード署名なしでも安全に使えるよう、
 * 自動インストールはせず新バージョンの存在を知らせてリリースページへ誘導する
 * （実際のダウンロード・入れ替えは selfUpdate.ts）。
 *
 * 【なぜ Atom フィードを先に見るか】
 * GitHub の API（releases/latest）には 1 時間 60 回（未認証）の上限があり、
 * これは端末ごとではなく IP アドレスごとに数えられる。会社のように多数の PC が
 * 同じ出口 IP を共有する環境では、他の通信で先に使い切られていて常に 403 になる
 * ——「会社では一度も更新できない」という報告の原因はこれだった
 * （Pane の docs/調査記録/修正-会社で更新できなかった原因.md と同じ現象）。
 * Atom フィード（releases.atom）はこの上限とは別枠なので、まずここで
 * 「新しい版があるか」だけを確認し、新しい版があるときだけ API を呼んで詳細
 * （ダウンロード URL・SHA256）を取りに行く。呼ぶ頻度が下がるぶん上限に当たりにくい。
 *
 * API が上限や障害で失敗しても、Atom で「新しい版がある」ことまでは分かっている場合、
 * ダウンロード URL は規則から組み立てて更新を続行する（SHA256 の照合は省く）。
 */

const OWNER = 'Yu5rin';
const REPO = 'CallStack';
const ATOM_URL = buildAtomUrl(OWNER, REPO);
const LATEST_API = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
export const RELEASES_PAGE = buildLatestReleasePageUrl(OWNER, REPO);

/** Atom 個別のタイムアウト（数KBの軽い応答なので短くてよい）。 */
const ATOM_TIMEOUT_MS = 8_000;
/** API 個別のタイムアウト。 */
const API_TIMEOUT_MS = 15_000;
/** 確認全体のタイムアウト（Atom + API の2回ぶんを合わせてここで打ち切る）。 */
const TOTAL_CHECK_TIMEOUT_MS = 20_000;

export interface UpdateCheckResult {
  ok: boolean;
  current: string;
  latest?: string;
  hasUpdate?: boolean;
  url?: string;
  error?: string;
  /** Windows 用 zip アセットの直リンク（自己更新に使う。見つからない場合は undefined） */
  assetUrl?: string;
  /** アセットの SHA256（GitHub が算出した digest。'sha256:'は取り除いた16進文字列）。空文字なら照合を省く */
  assetSha256?: string;
  /** GitHub API の問い合わせ回数の上限（403/429）に達していたため、詳細情報を取れなかった */
  rateLimited?: boolean;
  /** API から取れず、SHA256 なしでダウンロード URL だけを組み立てて返した */
  sha256Missing?: boolean;
}

/** Atom フィードの ETag・最新タグ・最終確認時刻を保存するファイル。
 *  Settings（userData/settings.json）には入れない。renderer が Settings 全体を
 *  そのまま送り返す作りのため、そちらに混ぜると上書きで消えてしまう。 */
function getStatePath(): string {
  return path.join(app.getPath('userData'), 'update-state.json');
}

interface UpdateState {
  etag?: string;
  latestTag?: string;
  lastCheckAt?: string;
}

async function readState(): Promise<UpdateState> {
  try {
    const raw = await fs.readFile(getStatePath(), 'utf-8');
    return JSON.parse(raw) as UpdateState;
  } catch {
    return {};
  }
}

async function writeState(patch: Partial<UpdateState>): Promise<void> {
  try {
    const current = await readState();
    const next = { ...current, ...patch };
    await fs.writeFile(getStatePath(), JSON.stringify(next), 'utf-8');
  } catch (err) {
    // 保存できなくても、次回は毎回フルで受け取るだけで実害はない。
    logInfo('update', `状態の保存に失敗: ${(err as Error).message}`);
  }
}

/** 最終確認時刻（ISO文字列）。常駐中の再チェック判定（index.ts）に使う。 */
export async function getLastCheckAt(): Promise<string | null> {
  const state = await readState();
  return state.lastCheckAt ?? null;
}

interface NetResponse { statusCode: number; headers: Record<string, string | string[]>; body: string }

function requestText(url: string, headers: Record<string, string>, timeoutMs: number): Promise<NetResponse> {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, method: 'GET', redirect: 'follow' });
    for (const [k, v] of Object.entries(headers)) req.setHeader(k, v);
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      req.abort();
      finish(() => reject(new Error('timeout')));
    }, timeoutMs);
    req.on('response', (res) => {
      let body = '';
      res.on('data', (c: Buffer) => { body += c.toString(); });
      res.on('end', () => finish(() => resolve({ statusCode: res.statusCode, headers: res.headers as Record<string, string | string[]>, body })));
      res.on('aborted', () => finish(() => reject(new Error('aborted'))));
      res.on('error', (err: Error) => finish(() => reject(err)));
    });
    req.on('error', (err) => finish(() => reject(err)));
    req.end();
  });
}

function headerValue(headers: Record<string, string | string[]>, name: string): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Atom フィードから、いちばん新しいリリースのタグ名を読み取る。読めなければ null を返し、
 * 呼び出し元は API への問い合わせへ進む（こちらが使えなくても確認そのものはできたほうがよい）。
 *
 * 前回と同じ内容なら本文を受け取らずに済ませる（If-None-Match → 304）。数KBとはいえ
 * 毎回受け取る必要はなく、配布元にも自分の回線にも余計な負荷をかけない。
 */
async function tryReadLatestTagFromAtom(currentVersion: string): Promise<string | null> {
  const state = await readState();
  const headers: Record<string, string> = { Accept: 'application/atom+xml', 'User-Agent': `CallStack-Updater/${currentVersion}` };
  if (state.etag && state.latestTag) headers['If-None-Match'] = state.etag;

  try {
    logInfo('update', `問い合わせ先(Atom): ${ATOM_URL}`);
    const res = await requestText(ATOM_URL, headers, ATOM_TIMEOUT_MS);
    if (res.statusCode === 304 && state.latestTag) {
      logInfo('update', `Atomフィードは前回から変わっていない(304)。前回のタグを使う(${state.latestTag})`);
      return state.latestTag;
    }
    if (res.statusCode !== 200) {
      logInfo('update', `Atomフィードの取得に失敗(status=${res.statusCode})。APIへ問い合わせる`);
      return null;
    }
    const tag = extractLatestTagFromAtom(res.body);
    const etag = headerValue(res.headers, 'etag');
    if (etag && tag) await writeState({ etag, latestTag: tag });
    return tag;
  } catch (err) {
    logInfo('update', `Atomフィードを読めなかった(${(err as Error).message})。APIへ問い合わせる`);
    return null;
  }
}

interface GhReleaseAsset { name: string; browser_download_url: string; digest?: string | null }
interface GhRelease { tag_name?: string; html_url?: string; assets?: GhReleaseAsset[] }

function findZipAsset(release: GhRelease): { url?: string; sha256?: string } {
  const asset = (release.assets ?? []).find((a) => /-win-x64\.zip$/i.test(a.name));
  if (!asset) return {};
  const digestMatch = asset.digest?.match(/^sha256:([0-9a-f]{64})$/i);
  return { url: asset.browser_download_url, sha256: digestMatch ? digestMatch[1].toLowerCase() : undefined };
}

function errorResult(current: string, message: string): UpdateCheckResult {
  return { ok: false, current, error: message };
}

/**
 * 「新しい版があることは Atom で分かったが、API から詳細（ダウンロード URL・SHA256）を
 * 取れなかった」ときの結果。ダウンロード URL は規則から組み立てて続行する
 * （updateCheckLogic.buildDownloadUrl 参照）。引き換えに SHA256 は分からないため、
 * 検証を省く旨をログに残す（selfUpdate.ts の VerifyHash 相当が空チェックで警告する）。
 */
function newerButNoDetails(current: string, tag: string, rateLimited: boolean): UpdateCheckResult {
  const assetUrl = buildDownloadUrl(OWNER, REPO, tag);
  logInfo('update', `URL組み立て: 詳細を取れなかったためダウンロードURLを組み立てて続行する(SHA256の照合は省く): ${assetUrl}`);
  return {
    ok: true,
    current,
    latest: tag.replace(/^v/i, ''),
    hasUpdate: true,
    url: buildReleasePageUrl(OWNER, REPO, tag),
    assetUrl,
    assetSha256: '',
    rateLimited,
    sha256Missing: true,
  };
}

/** 配布元へ問い合わせて、新しい版があるかを調べる。通信に失敗しても例外は投げない。 */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const current = app.getVersion();
  await writeState({ lastCheckAt: new Date().toISOString() });

  const totalDeadline = Date.now() + TOTAL_CHECK_TIMEOUT_MS;
  const remaining = (): number => Math.max(1000, totalDeadline - Date.now());

  let knownNewerTag: string | null = null;

  try {
    const tagFromAtom = await withTimeout(tryReadLatestTagFromAtom(current), remaining());
    if (tagFromAtom) {
      const latest = parseVersion(tagFromAtom);
      const cur = parseVersion(current);
      if (latest === null || cur === null) {
        logInfo('update', `配布元のバージョン表記を読み取れなかった: "${tagFromAtom}"`);
        return errorResult(current, '配布元のバージョン表記を読み取れませんでした。');
      }
      if (!isNewer(latest, cur)) {
        logInfo('update', `最新版だった(現在=${current}, 配布元=${tagFromAtom}, 問い合わせ先=Atom)`);
        return {
          ok: true, current, latest: tagFromAtom.replace(/^v/i, ''), hasUpdate: false,
          url: buildReleasePageUrl(OWNER, REPO, tagFromAtom),
        };
      }
      logInfo('update', `新しい版がある(現在=${current}, 配布元=${tagFromAtom}, 問い合わせ先=Atom)。詳細をAPIへ問い合わせる`);
      knownNewerTag = tagFromAtom;
    }

    logInfo('update', `問い合わせ先(API): ${LATEST_API}`);
    const res = await withTimeout(
      requestText(LATEST_API, { Accept: 'application/vnd.github+json', 'User-Agent': `CallStack-Updater/${current}` }, Math.min(API_TIMEOUT_MS, remaining())),
      remaining(),
    );

    if (res.statusCode === 403 || res.statusCode === 429) {
      logInfo('update', `API上限: 問い合わせ回数の上限に達していた(${res.statusCode})`);
      if (knownNewerTag) return newerButNoDetails(current, knownNewerTag, true);
      return errorResult(current,
        '配布元への問い合わせが回数の上限に達していました。この上限は同じネットワークを使う人たちで共有されるため、' +
        '自分が何度も確認していなくても起こります。しばらく時間をおくか、リリースページから直接ご確認ください。');
    }
    if (res.statusCode !== 200) {
      logInfo('update', `APIの問い合わせに失敗(status=${res.statusCode})`);
      if (knownNewerTag) return newerButNoDetails(current, knownNewerTag, false);
      return errorResult(current, describeNetError(new Error(`HTTP ${res.statusCode}`), res.statusCode));
    }

    const json = JSON.parse(res.body) as GhRelease;
    const tag = json.tag_name ?? '';
    const latest = parseVersion(tag);
    const cur = parseVersion(current);
    if (latest === null || cur === null) {
      logInfo('update', `配布元のバージョン表記を読み取れなかった: "${tag}"`);
      return errorResult(current, '配布元のバージョン表記を読み取れませんでした。');
    }

    if (!isNewer(latest, cur)) {
      logInfo('update', `最新版だった(現在=${current}, 配布元=${tag})`);
      return { ok: true, current, latest: tag.replace(/^v/i, ''), hasUpdate: false, url: json.html_url ?? RELEASES_PAGE };
    }

    const { url: assetUrl, sha256 } = findZipAsset(json);
    logInfo('update', `新しい版がある(現在=${current}, 配布元=${tag}, SHA256=${sha256 ? 'あり' : '(提供なし)'})`);
    return {
      ok: true, current, latest: tag.replace(/^v/i, ''), hasUpdate: true,
      url: json.html_url ?? RELEASES_PAGE,
      assetUrl, assetSha256: sha256 ?? '', sha256Missing: !sha256,
    };
  } catch (err) {
    const message = (err as Error).message;
    if (message === 'timeout') {
      logInfo('update', '時間内に応答がなかった');
      if (knownNewerTag) return newerButNoDetails(current, knownNewerTag, false);
      return errorResult(current, '配布元から時間内に応答がありませんでした。ネットワークの状態を確認してください。');
    }
    logInfo('update', `更新の確認に失敗: ${message}`);
    if (knownNewerTag) return newerButNoDetails(current, knownNewerTag, false);
    return errorResult(current, describeNetError(err));
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

/** 起動時の静かな更新確認。新版があるときだけ結果を返す。 */
export async function checkOnStartup(): Promise<UpdateCheckResult | null> {
  const r = await checkForUpdate();
  logInfo('update', r.ok
    ? `check: current=${r.current} latest=${r.latest} hasUpdate=${r.hasUpdate}`
    : `check failed: ${r.error}`);
  if (r.ok && r.hasUpdate) return r;
  return null;
}
