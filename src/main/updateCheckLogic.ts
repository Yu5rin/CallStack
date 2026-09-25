/**
 * 更新の確認のうち、外の世界（通信・ファイル・ログ）に触れない部分だけを集めたもの。
 *
 * Pane（C#版・/home/user/yu5rin/pane の UpdateCheckLogic.cs）の設計を移植している。
 * 判断の中身をここへ寄せ、node:test で固定することで、
 *   ・タグの "v" を落とし忘れてバージョンを読み取れない
 *   ・文字列比較で "1.0.10" が "1.0.9" より古く見える
 * といった、利用者からは気づきにくいまま長く残る不具合を防ぐ。
 *
 * electron を import しない（純粋なロジックのみ）。updates.ts / selfUpdate.ts から使う。
 */

/** 比較できる形にしたバージョン。桁数が違っても同じものとして扱う（1.0.1 と 1.0.1.0 など）。 */
export type ParsedVersion = readonly [number, number, number, number];

/**
 * バージョン表記を比較できる形にする。読めなければ null。
 *
 * 吸収するもの:
 *   ・先頭の "v"（Git タグの慣例。"v1.0.4" → 1.0.4）
 *   ・"+<ハッシュ>" / "-beta" のような追記
 *   ・桁数の違い（1.0.1 と 1.0.1.0 を同じものとして扱う）
 */
export function parseVersion(text: string | null | undefined): ParsedVersion | null {
  if (!text || !text.trim()) return null;

  let core = stripVersionPrefix(text.trim());
  const plus = core.indexOf('+');
  if (plus >= 0) core = core.slice(0, plus);
  const hyphen = core.indexOf('-');
  if (hyphen >= 0) core = core.slice(0, hyphen);

  const m = core.match(/^(\d+)\.(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0), Number(m[4] ?? 0)];
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return parts as unknown as ParsedVersion;
}

/** タグ名の先頭の "v"/"V" を落とす（"v1.0.4" → "1.0.4"）。 */
export function stripVersionPrefix(tag: string): string {
  const t = tag.trim();
  return t.length > 1 && (t[0] === 'v' || t[0] === 'V') ? t.slice(1) : t;
}

/** a が b より新しいか。比較は必ずこの関数を通す（文字列比較は誤判定するため使わない）。 */
export function isNewer(a: ParsedVersion, b: ParsedVersion): boolean {
  for (let i = 0; i < 4; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/**
 * 配布元のタグと、いま動いている版を見比べて、更新があるかどうかを決める。
 * どちらかが読み取れない場合は null（＝判断できない）を返す。
 */
export function isNewerThanCurrent(latestTag: string | null | undefined, currentVersionText: string | null | undefined): boolean | null {
  const latest = parseVersion(latestTag);
  const current = parseVersion(currentVersionText);
  if (latest === null || current === null) return null;
  return isNewer(latest, current);
}

/**
 * releases/latest の API URL から、同じリポジトリの Atom フィードの URL を組み立てる。
 * 形が違って組み立てられない場合は null。
 *
 *   https://api.github.com/repos/{owner}/{repo}/releases/latest
 *     → https://github.com/{owner}/{repo}/releases.atom
 */
export function tryBuildAtomUrlFromApiUrl(apiUrl: string): string | null {
  try {
    const uri = new URL(apiUrl);
    if (uri.hostname.toLowerCase() !== 'api.github.com') return null;
    const parts = uri.pathname.replace(/^\/+|\/+$/g, '').split('/');
    // repos / {owner} / {repo} / releases / latest
    if (parts.length < 4 || parts[0].toLowerCase() !== 'repos') return null;
    if (!parts[1] || !parts[2]) return null;
    return buildAtomUrl(parts[1], parts[2]);
  } catch {
    return null;
  }
}

/** owner/repo から releases.atom の URL を組み立てる。 */
export function buildAtomUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}/releases.atom`;
}

/**
 * 配布物（Zip）のファイル名。リリースを作るワークフロー（.github/workflows/release.yml）が
 * この名前で作るので、タグさえ分かれば組み立てられる。タグ先頭の "v" は落とす
 * （リリースのバージョン表記は "v" 無しのため。CLAUDE.md 参照）。
 */
export function buildAssetFileName(tag: string): string {
  return `CallStack-${stripVersionPrefix(tag)}-win-x64.zip`;
}

/**
 * API を使わずに、配布物のダウンロード URL を組み立てる。
 *
 *   https://github.com/{owner}/{repo}/releases/download/{tag}/CallStack-{version}-win-x64.zip
 *
 * 【なぜ要るか】GitHub の API には 1 時間 60 回（未認証）の上限があり、これは端末ごとではなく
 * IP アドレスごとに数えられる。会社などの共有回線では他の通信で先に使い切られてしまう。
 * Atom フィードはその上限とは別枠なので、新しい版があることまでは常に分かる。
 * ダウンロード URL は規則的なので、API に頼らず組み立てられる（引き換えに SHA256 は
 * 分からず、照合を省いて続行する。selfUpdate.ts 参照）。
 */
export function buildDownloadUrl(owner: string, repo: string, tag: string): string {
  return `https://github.com/${owner}/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(buildAssetFileName(tag))}`;
}

/** あるタグのリリースページの URL。 */
export function buildReleasePageUrl(owner: string, repo: string, tag: string): string {
  return `https://github.com/${owner}/${repo}/releases/tag/${encodeURIComponent(tag)}`;
}

/** 「いちばん新しいリリース」のページの URL。タグが分からないときの案内先に使う。 */
export function buildLatestReleasePageUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}/releases/latest`;
}

/**
 * Atom フィードの xml から、いちばん新しいリリースのタグ名を取り出す。読めなければ null。
 *
 * 並び順に頼らず、読み取れたタグのうちバージョンとして最大のものを選ぶ。フィードは
 * 普通は新しい順に並ぶが、それに依存すると、並びが変わったときに古い版を「最新」と
 * 判断してしまう。バージョンとして読めないタグ（下書き用の名前など）は無視する。
 *
 * XML パーサを使わず正規表現で読む（node:test 環境・メインプロセス双方で依存を増やさないため）。
 * <entry> ごとに最初の <link href="…/releases/tag/TAG"> を見る。壊れた xml でも例外は投げない。
 */
export function extractLatestTagFromAtom(xml: string): string | null {
  try {
    let bestTag: string | null = null;
    let bestVersion: ParsedVersion | null = null;

    const entryRe = /<entry\b[\s\S]*?<\/entry>/gi;
    const linkRe = /<link\b[^>]*\bhref\s*=\s*"([^"]*)"[^>]*\/?>/i;
    let entryMatch: RegExpExecArray | null;
    while ((entryMatch = entryRe.exec(xml)) !== null) {
      const entryXml = entryMatch[0];
      const linkMatch = linkRe.exec(entryXml);
      if (!linkMatch) continue;
      const href = decodeHtmlEntities(linkMatch[1]);
      if (!href) continue;

      const trimmed = href.replace(/\/+$/, '');
      const tagIdx = trimmed.lastIndexOf('/');
      if (tagIdx < 0) continue;
      let tag = trimmed.slice(tagIdx + 1);
      try { tag = decodeURIComponent(tag); } catch { /* そのまま使う */ }
      if (!tag) continue;

      const version = parseVersion(tag);
      if (version === null) continue;
      if (bestVersion !== null && !isNewer(version, bestVersion)) continue;

      bestVersion = version;
      bestTag = tag;
    }
    return bestTag;
  } catch {
    // 壊れた xml が返ってきても、呼び出し元は API で確認できる。ここでは黙って諦める。
    return null;
  }
}

function decodeHtmlEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

/** https のみ許可するホストのホワイトリスト。update:open-releases でも使う。 */
const ALLOWED_HOSTS = new Set(['github.com', 'api.github.com']);

/** 配布物のダウンロード URL は、この prefix から始まるものだけを許可する。 */
const ALLOWED_DOWNLOAD_PREFIX = 'https://github.com/Yu5rin/CallStack/releases/download/';

/**
 * 更新まわりで使う URL（問い合わせ・リリースページ・ダウンロード）として妥当か。
 * https のみ、ホストは github.com / api.github.com のみ。加えてダウンロード用途の URL は
 * 決まった prefix から始まることを要求する（応答が差し替えられていても平文や別ホストへ
 * 誘導されないようにする。Pane の VerifyHash 節のコメント・UpdateService.FindZipAsset 参照）。
 */
export function isAllowedUpdateUrl(url: string, opts: { requireDownloadPrefix?: boolean } = {}): boolean {
  let uri: URL;
  try {
    uri = new URL(url);
  } catch {
    return false;
  }
  if (uri.protocol !== 'https:') return false;
  if (!ALLOWED_HOSTS.has(uri.hostname.toLowerCase())) return false;
  if (opts.requireDownloadPrefix && !url.startsWith(ALLOWED_DOWNLOAD_PREFIX)) return false;
  return true;
}

export { ALLOWED_DOWNLOAD_PREFIX };
