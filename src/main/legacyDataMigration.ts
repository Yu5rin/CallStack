/**
 * 旧製品名（TelTimeStack）時代のデータフォルダから、今のデータフォルダ（CallStack）へ
 * 利用者のデータを引き継ぐかどうかの判断ロジック。
 *
 * なぜ必要か:
 *   Electron の userData は「%APPDATA%\<アプリ名>」になる。v1.3.0 で製品名を
 *   TelTimeStack → CallStack に変えた（package.json の name / build.productName と
 *   app.setName をまとめて変更）ため、保存先が %APPDATA%\TelTimeStack から
 *   %APPDATA%\CallStack に変わった。ところが引き継ぎ処理が無かったので、
 *   v1.2 以前から使っていた人は、更新後に通話記録・設定・録音・モデルが
 *   すべて消えたように見えていた（旧フォルダに残ったまま読まれない）。
 *
 *   しかも store.init() は data.json が無いと既定値で新しく書き出すため、
 *   v1.3.0 以降を一度でも起動した人の新しい側には「記録0件の data.json」が
 *   既にある。これを「データあり」とみなすと引き継ぎが永久に行われないので、
 *   記録0件の場合だけは「まだ使われていない」と判断する（消さずに退避する）。
 *
 * この関数群は外の世界（ファイル・Electron）に触れない。フォルダの中身は
 * 呼び出し側が調べて渡し、ここでは「何をどこから移すか」だけを決める。
 * 実際の移動は legacyDataMigrationRunner.ts が行う。
 */

/**
 * 旧フォルダ名の候補（上から順に探す）。Windows ではフォルダ名の大文字小文字を
 * 区別しないのでどちらも同じ場所を指すが、区別するファイルシステム
 * （開発時の Linux 等）のため package.json の旧 name も並べておく。
 */
export const LEGACY_APP_DIR_NAMES = ['TelTimeStack', 'teltimestack'] as const;

/** 本体データ（通話記録・設定） */
export const DATA_FILE = 'data.json';

/**
 * 記録そのもの。新しい側が「記録0件」のときは旧フォルダの方を正とし、
 * 新しい側の同名項目は退避してから旧フォルダの方を移す。
 * （録音の参照は data.json の中にあるので、data.json と組で動かす必要がある）
 */
export const RECORD_ENTRIES = ['recordings', 'backups'] as const;

/**
 * ダウンロードし直せる部品。新しい側に中身があればそちらを残す
 * （新しい側で改めてダウンロードした whisper.cpp 等を壊さない。
 *   whisper の実行ファイルと DLL は同じ版で揃っている必要があるので、
 *   フォルダ同士を混ぜ合わせることもしない）。
 */
export const ASSET_ENTRIES = ['models', 'whisper', 'whisper-gpu', 'vosk', 'vosk-models'] as const;

/**
 * 引き継ぐ対象（アプリ自身が userData に作るもの）の移す順番。
 * Chromium が作る内部フォルダ（Local Storage・Cache 等）は、動いている Chromium と
 * 取り合いになる恐れがあるため対象にしない（失うのは再生速度などの表示設定だけ）。
 * logs も対象にしない: 引き継ぎ処理自身がログを書くと新しい側に logs が作られ、
 * そこへの rename が失敗して data.json まで進めなくなるため（調査用なので旧フォルダに残せば足りる）。
 * data.json は必ず最後に移す: 途中で失敗しても新しい側に data.json が無い状態が残り、
 * 次回起動時に残りを引き継ぎ直せる（先に data.json を移すと、以後は「既にデータがある」
 * と判断されて録音やモデルが旧フォルダに取り残される）。
 */
export const MIGRATION_ORDER = [...ASSET_ENTRIES, ...RECORD_ENTRIES, DATA_FILE] as const;

/**
 * フォルダ直下の1項目の状態。
 * emptyDir は「ファイルを1つも含まない（空のサブフォルダだけの）フォルダ」。
 * ensureAppDirs() が作る recordings\.tmp のような入れ物だけのフォルダをこう扱う。
 */
export type EntryKind = 'file' | 'dir' | 'emptyDir';

/** フォルダ直下の「名前 → 状態」。存在しない項目は含めない */
export type EntryMap = ReadonlyMap<string, EntryKind>;

export interface LegacyDirSnapshot {
  dir: string;
  entries: EntryMap;
}

/**
 * 新しい側の data.json の中身の状態。
 *   'none'      … data.json が無い
 *   'no-calls'  … 読めて、記録が0件（既定値のまま書き出されただけ）
 *   'has-calls' … 記録が1件以上ある
 *   'unreadable'… 読めない・壊れている（中身が分からないので「データあり」扱い）
 */
export type CurrentDataState = 'none' | 'no-calls' | 'has-calls' | 'unreadable';

export type MigrationPlan =
  | { action: 'none'; reason: 'current-has-data' | 'no-legacy-data' }
  | {
      action: 'migrate';
      from: string;
      /**
       * 新しい側にあり、移す前に別名へ退避する項目（消さない）。
       * 記録0件の data.json と、それと組になる recordings / backups。
       */
      setAside: string[];
      /** 新しい側に空フォルダとして既にあり、移す前に消してよい項目 */
      replaceEmptyDirs: string[];
      /** 旧フォルダから移す項目名（この順に移す。data.json は最後） */
      moves: string[];
    };

/**
 * 旧フォルダの候補を返す。今のデータフォルダ自身と同じ場所は除く
 * （大文字小文字だけの違いは、区別しないファイルシステムでは同じ場所なので除く）。
 */
export function legacyDirCandidates(
  appDataDir: string,
  currentUserDataDir: string,
  join: (...parts: string[]) => string,
  caseInsensitive: boolean,
): string[] {
  const norm = (p: string) => (caseInsensitive ? p.toLowerCase() : p);
  const current = norm(currentUserDataDir);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of LEGACY_APP_DIR_NAMES) {
    const dir = join(appDataDir, name);
    const key = norm(dir);
    if (key === current || seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
  }
  return out;
}

/** data.json の中身から、記録があるかどうかを判定する（壊れていれば unreadable） */
export function classifyCurrentData(raw: string | null): CurrentDataState {
  if (raw === null) return 'none';
  try {
    const parsed = JSON.parse(raw) as { calls?: unknown };
    if (!parsed || typeof parsed !== 'object') return 'unreadable';
    if (!Array.isArray(parsed.calls)) return 'unreadable';
    return parsed.calls.length === 0 ? 'no-calls' : 'has-calls';
  } catch {
    return 'unreadable';
  }
}

/** 中身のある項目か（ファイル、または中にファイルがあるフォルダ） */
function hasContent(kind: EntryKind | undefined): boolean {
  return kind === 'file' || kind === 'dir';
}

/**
 * 引き継ぎの計画を立てる。安全側に倒す方針:
 *   - 新しい側に記録が1件でもある（または data.json が読めない）なら、何もしない
 *     （上書き・混ぜ合わせをしない。旧フォルダもそのまま残る）
 *   - 旧フォルダは data.json があるものだけを引き継ぎ元とみなす
 *   - 何も消さない。新しい側の既存項目は、退避（別名に変更）するか、そのまま残す
 */
export function planLegacyDataMigration(input: {
  currentData: CurrentDataState;
  current: EntryMap;
  legacy: LegacyDirSnapshot[];
}): MigrationPlan {
  if (input.currentData === 'has-calls' || input.currentData === 'unreadable') {
    return { action: 'none', reason: 'current-has-data' };
  }
  const source = input.legacy.find((l) => l.entries.get(DATA_FILE) === 'file');
  if (!source) return { action: 'none', reason: 'no-legacy-data' };

  const recordEntries: readonly string[] = [...RECORD_ENTRIES, DATA_FILE];
  const setAside: string[] = [];
  const replaceEmptyDirs: string[] = [];
  const moves: string[] = [];
  for (const name of MIGRATION_ORDER) {
    if (!hasContent(source.entries.get(name))) continue;
    const existing = input.current.get(name);
    if (hasContent(existing)) {
      // 記録側は旧フォルダを正とする（新しい側は記録0件なので退避で足りる）。
      // 部品側は新しい側を残す。
      if (!recordEntries.includes(name)) continue;
      setAside.push(name);
    } else if (existing === 'emptyDir') {
      replaceEmptyDirs.push(name);
    }
    moves.push(name);
  }
  return { action: 'migrate', from: source.dir, setAside, replaceEmptyDirs, moves };
}

/** 退避先の名前（例: data.json → data.json.before-migration-20260925-120000） */
export function setAsideName(name: string, stamp: string): string {
  return `${name}.before-migration-${stamp}`;
}
