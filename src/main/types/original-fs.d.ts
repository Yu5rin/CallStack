/**
 * electron が同梱する `original-fs`（asar 対応パッチが当たっていない、素の node:fs）の型。
 * node_modules に型定義が無いため、node:fs と同じ形として宣言する。
 */
declare module 'original-fs' {
  const fs: typeof import('node:fs');
  export = fs;
}
