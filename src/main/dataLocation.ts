import path from 'node:path';
import type * as NodeFs from 'node:fs';

/**
 * データフォルダ（Electron の userData / sessionData）をどこに置くかの判断ロジック。
 *
 * 【なぜ必要か】
 * PC を買い替えるとき、設定・記録・録音を %APPDATA%\callstack から探して移すのは手間が
 * かかる。そこで ZIP 配布（インストール不要）の版では、exe のすぐ隣の `data` フォルダに
 * すべてを置く。アプリのフォルダごとコピーすれば、そのまま引っ越せる。
 *
 * 【使い分け】
 *   portable … 製品版（packaged）の Windows。<exe のあるフォルダ>\data
 *   fallback … portable にしたいが exe の隣に書き込めない（Program Files 等）。
 *              従来どおり %APPDATA%\callstack を使い、理由を記録して設定画面へ知らせる
 *   default  … 開発時（npm run dev）・Windows 以外。従来どおり（何も変えない）
 *   applier  … 更新の適用モード。ステージング側の exe が動くので、exe の隣に data を
 *              作ってはいけない（そのまま入れ替え後のフォルダに紛れ込む）。一時フォルダを使う
 *
 * このファイルは electron に依存しない（node:test で検証する）。実際の setPath と
 * 書き込み確認の呼び出しは dataLocationRunner.ts が行う。
 */

/** exe の隣に作るデータフォルダ名。更新の入れ替え（updateApplier.ts）はこの名前を絶対に動かさない */
export const PORTABLE_DATA_DIR_NAME = 'data';

export type DataLocationMode = 'portable' | 'fallback' | 'default' | 'applier';

/** レンダラへ知らせる、現在のデータフォルダの状態 */
export interface DataLocationInfo {
  mode: DataLocationMode;
  /** 実際に使うデータフォルダ（userData） */
  dir: string;
  /** 従来の既定の場所（%APPDATA%\callstack）。移行元の判断に使う */
  defaultDir: string;
  /** portable にしなかった（またはできなかった）理由。portable のときは null */
  reason: string | null;
}

export interface DataLocationInput {
  isPackaged: boolean;
  platform: string;
  /** process.execPath */
  execPath: string;
  /** 更新の適用モード（--callstack-apply-update）で起動されたか */
  applyMode: boolean;
  /** Electron の既定の userData（setPath する前の値） */
  defaultDir: string;
  /** os.tmpdir() */
  tmpDir: string;
  pid: number;
  /**
   * 単一 exe のポータブル版（electron-builder portable）が設定する PORTABLE_EXECUTABLE_DIR。
   * この版は exe が一時フォルダに展開されて動くため、execPath ではなく元の exe の置き場所を使う
   */
  portableExecutableDir?: string | null;
  /** exe の隣にインストーラ版のアンインストーラがある（＝インストール先に data を置くと更新・削除で消える） */
  installedByInstaller?: boolean;
}

export type DataLocationPlan =
  | { kind: 'portable'; dir: string }
  | { kind: 'applier'; dir: string }
  | { kind: 'default'; reason: string };

function pathApi(platform: string): typeof path.posix {
  return platform === 'win32' ? path.win32 : path;
}

/** 書き込み確認の前に、どこに置く予定かを決める */
export function planDataLocation(input: DataLocationInput): DataLocationPlan {
  const p = pathApi(input.platform);
  if (input.applyMode) {
    return { kind: 'applier', dir: p.join(input.tmpDir, `callstack-applier-${input.pid}`) };
  }
  if (!input.isPackaged) return { kind: 'default', reason: '開発モードのため従来の保存先を使います' };
  if (input.platform !== 'win32') return { kind: 'default', reason: 'Windows 以外のため従来の保存先を使います' };
  if (input.installedByInstaller) {
    return { kind: 'default', reason: 'インストーラ版のため従来の保存先を使います' };
  }
  const baseDir = input.portableExecutableDir ? input.portableExecutableDir : p.dirname(input.execPath);
  return { kind: 'portable', dir: p.join(baseDir, PORTABLE_DATA_DIR_NAME) };
}

export interface ProbeResult {
  ok: boolean;
  error?: string;
}

/** 書き込み確認の結果を加えて、最終的な保存先を決める */
export function resolveDataLocation(
  plan: DataLocationPlan,
  defaultDir: string,
  probe: ProbeResult | null,
): DataLocationInfo {
  if (plan.kind === 'default') {
    return { mode: 'default', dir: defaultDir, defaultDir, reason: plan.reason };
  }
  if (plan.kind === 'applier') {
    return { mode: 'applier', dir: plan.dir, defaultDir, reason: '更新の適用モードのため一時フォルダを使います' };
  }
  if (probe && probe.ok) {
    return { mode: 'portable', dir: plan.dir, defaultDir, reason: null };
  }
  return {
    mode: 'fallback',
    dir: defaultDir,
    defaultDir,
    reason: `${plan.dir} に書き込めないため従来の保存先を使います${probe?.error ? `（${probe.error}）` : ''}`,
  };
}

/** 書き込み確認に使うファイル操作（本番は node:fs。テストでは差し替える） */
export type ProbeFs = Pick<typeof NodeFs, 'mkdirSync' | 'writeFileSync' | 'unlinkSync'>;

/**
 * フォルダを作り（無ければ）、確認用ファイルを書いて消す。
 * 作れる・書ける・消せるの3つが通れば書き込める場所とみなす。
 */
export function probeWritableDir(dir: string, fs: ProbeFs, pid = 0): ProbeResult {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return { ok: true };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return { ok: false, error: e.code ? `${e.code}: ${e.message}` : e.message };
  }
}
