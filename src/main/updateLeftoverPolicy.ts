/**
 * 更新の入れ替え（selfUpdate.ts）でインストール先フォルダを退避した `.old` フォルダを、
 * 次回起動時に消してよいかどうかの判定。
 *
 * Pane（C#版・/home/user/yu5rin/pane の UpdateLeftoverPolicy.cs）の設計を移植している。
 *
 * 【なぜ必要か】
 * 入れ替え（PowerShell スクリプト）は、旧インストール先を `.old` へリネームしてから
 * 新しいフォルダをその名前へ移す。途中で電源断・強制終了が起きると、`.old` だけが
 * 残ったまま入れ替えが完了しない状態になりうる。従来の CallStack（cleanupOldInstallDir）は
 * `.old` が在ればそれだけを見て無条件に削除していたが、これだと入れ替えが完了しないまま
 * 終わった直後の初回起動で「復旧の唯一の材料（.old）」まで消えてしまう。
 *
 * 完了マーカー（callstack-update.ok）は、PowerShell スクリプトが新しいフォルダへの
 * 入れ替えを最後までやり遂げたときだけ、新しいインストール先に書く。次回起動時に
 * このマーカーが無ければ「入れ替えが途中で終わった」とみなし、`.old` は消さずに残す
 * （消してしまうと直す手立てが無くなるため、消さないことが安全側）。
 *
 * ただし、マーカーの仕組みが無かった旧版（〜2.7.x。PowerShell スクリプトを自分で書き出すが
 * マーカーは書かない）から更新した環境には「.old はあるがマーカーは無い」組み合わせが
 * 最初から存在する。これを一律に KeepBackups（＝途中で終わった）と扱うと、実際には
 * 何事もなく入れ替えできているのに、起動のたびに `.old` が残り続けてしまう。
 * そこで、マーカーが無くても次の2つが揃えば「完了していた」とみなして削除する
 * （DeleteStaleBackups）。
 *   ・.old が置かれてから StaleBackupAge 以上経っている（入れ替えは数十秒で終わる）
 *   ・いま動いている exe が、その .old より後に置かれている（＝入れ替え後に新しい exe が
 *     実際に配置され、それが起動できている）
 * 片方だけでは足りない（前者だけでは、入れ替えに失敗したまま放置した環境の復旧材料を消す）。
 *
 * 通信・ファイル・時刻に一切触れない判定だけをここへ切り出し、node:test で固定する。
 */

/** 入れ替えが最後まで完了したことを示す目印ファイルの名前（新しいインストール先の直下）。 */
export const COMPLETION_MARKER_FILE_NAME = 'callstack-update.ok';

/** 完了マーカーが無くても「実際には入れ替えは終わっていた」と判断してよい経過時間。 */
export const STALE_BACKUP_AGE_MS = 24 * 60 * 60 * 1000;

export type LeftoverAction =
  /** .old が無い（通常の起動、または既に片付いている）。何もしない。 */
  | 'None'
  /** 前回の更新は完了している。.old・完了マーカーを削除してよい。 */
  | 'DeleteBackups'
  /** 前回の更新は完了しないまま終わった形跡がある。.old は消さずに残す。 */
  | 'KeepBackups'
  /** 完了マーカーは無いが、入れ替えは実際には終わっていたと判断できる古い残骸。削除してよい。 */
  | 'DeleteStaleBackups';

export interface LeftoverDecisionInput {
  /** .old フォルダが存在するか。 */
  oldInstallDirExists: boolean;
  /** 完了マーカー（COMPLETION_MARKER_FILE_NAME）が存在するか。 */
  markerExists: boolean;
  /** .old が置かれてからの経過時間（ミリ秒）。読めなければ null。 */
  backupAgeMs: number | null;
  /** いま動いている exe が .old より後に置かれているか。 */
  currentExeIsNewerThanBackup: boolean;
}

/** .old フォルダ・完了マーカーの有無から、とるべき行動を決める。 */
export function decide(input: LeftoverDecisionInput): LeftoverAction {
  const { oldInstallDirExists, markerExists, backupAgeMs, currentExeIsNewerThanBackup } = input;

  if (!oldInstallDirExists) {
    return 'None';
  }

  if (markerExists) return 'DeleteBackups';

  if (backupAgeMs !== null && backupAgeMs >= STALE_BACKUP_AGE_MS && currentExeIsNewerThanBackup) {
    return 'DeleteStaleBackups';
  }

  return 'KeepBackups';
}
