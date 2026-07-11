import { contextBridge, ipcRenderer, webUtils, IpcRendererEvent } from 'electron';
import type {
  CallRecord, Settings, CsvExportOptions, AppEvent, CsvImportResult, WhisperModel, HudSize, RecordKind,
  AudioSourceLabel, RecordingSourceConfig,
} from '../shared/types';

type SaveAsResult =
  | { canceled: true }
  | { canceled: false; path: string }
  | { canceled: false; error: string };

export interface CaptureWindow {
  id: string;
  name: string;
  thumbnail: string | null;   // data URL
}

const api = {
  calls: {
    list: (): Promise<CallRecord[]> => ipcRenderer.invoke('calls:list'),
    get: (id: string): Promise<CallRecord | null> => ipcRenderer.invoke('calls:get', id),
    getActive: (): Promise<CallRecord | null> => ipcRenderer.invoke('calls:getActive'),
    startNow: (kind?: RecordKind, meta?: Partial<CallRecord>): Promise<CallRecord | null> =>
      ipcRenderer.invoke('calls:startNow', kind, meta),
    endNow: (): Promise<CallRecord | null> => ipcRenderer.invoke('calls:endNow'),
    toggleHold: (): Promise<void> => ipcRenderer.invoke('calls:toggleHold'),
    update: (id: string, patch: Partial<CallRecord>): Promise<CallRecord | null> =>
      ipcRenderer.invoke('calls:update', id, patch),
    create: (partial: Partial<CallRecord>): Promise<CallRecord> =>
      ipcRenderer.invoke('calls:create', partial),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke('calls:delete', id),
    restore: (id: string): Promise<CallRecord | null> => ipcRenderer.invoke('calls:restore', id),
    purge: (id: string): Promise<boolean> => ipcRenderer.invoke('calls:purge', id),
    purgeTrash: (): Promise<number> => ipcRenderer.invoke('calls:purge-trash'),
    addMarker: (callId?: string, label?: string): Promise<CallRecord | null> =>
      ipcRenderer.invoke('calls:add-marker', callId, label),
  },
  app: {
    info: (): Promise<{ version: string; logPath: string; dataDir: string }> =>
      ipcRenderer.invoke('app:info'),
    openPath: (target: 'logs' | 'data' | 'recordings'): Promise<boolean> =>
      ipcRenderer.invoke('app:open-path', target),
  },
  update: {
    check: (): Promise<{
      ok: boolean; current: string; latest?: string; hasUpdate?: boolean; url?: string; error?: string;
    }> => ipcRenderer.invoke('update:check'),
    openReleases: (url?: string): Promise<boolean> => ipcRenderer.invoke('update:open-releases', url),
  },
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
    update: (next: Settings): Promise<Settings> => ipcRenderer.invoke('settings:update', next),
  },
  csv: {
    export: (
      opts: CsvExportOptions,
    ): Promise<{ canceled: true } | { canceled: false; count: number; path: string }> =>
      ipcRenderer.invoke('csv:export', opts),
    import: (): Promise<
      { canceled: true } | { canceled: false; result: CsvImportResult; backupPath: string }
    > => ipcRenderer.invoke('csv:import'),
    importText: (
      text: string,
    ): Promise<{ canceled: false; result: CsvImportResult; backupPath: string }> =>
      ipcRenderer.invoke('csv:import-text', text),
  },
  report: {
    weekly: (): Promise<{ canceled: true } | { canceled: false; path: string }> =>
      ipcRenderer.invoke('report:weekly'),
  },
  hud: {
    end: (): Promise<CallRecord | null> => ipcRenderer.invoke('hud:end'),
    openMain: (): Promise<void> => ipcRenderer.invoke('hud:open-main'),
    openEdit: (callId?: string): Promise<void> => ipcRenderer.invoke('hud:open-edit', callId),
    savePosition: (pos: { x: number; y: number }): Promise<void> =>
      ipcRenderer.invoke('hud:save-position', pos),
    getPosition: (): Promise<{ x: number; y: number } | null> =>
      ipcRenderer.invoke('hud:get-position'),
    cycleSize: (): Promise<HudSize> => ipcRenderer.invoke('hud:cycle-size'),
    assignTag: (tag: string | null): Promise<CallRecord | null> =>
      ipcRenderer.invoke('hud:assign-tag', tag),
    setExtraHeight: (px: number): Promise<void> =>
      ipcRenderer.invoke('hud:set-extra-height', px),
  },
  recording: {
    appendChunk: (callId: string, buf: ArrayBuffer): Promise<boolean> =>
      ipcRenderer.invoke('recording:append-chunk', callId, buf),
    finalize: (callId: string, sourceLabel?: AudioSourceLabel): Promise<CallRecord | null> =>
      ipcRenderer.invoke('recording:finalize', callId, sourceLabel),
    abort: (callId: string): Promise<boolean> => ipcRenderer.invoke('recording:abort', callId),
    togglePause: (): Promise<boolean> => ipcRenderer.invoke('recording:toggle-pause'),
    reportState: (recording: boolean, paused: boolean): Promise<boolean> =>
      ipcRenderer.invoke('recording:report-state', recording, paused),
    getState: (): Promise<{ recording: boolean; paused: boolean }> =>
      ipcRenderer.invoke('recording:get-state'),
    reportError: (message: string): Promise<boolean> =>
      ipcRenderer.invoke('recording:report-error', message),
    reportLevel: (level: number): Promise<boolean> =>
      ipcRenderer.invoke('recording:report-level', level),
    setCaptureTarget: (target: { type: 'screen' } | { type: 'window'; sourceId: string }): Promise<boolean> =>
      ipcRenderer.invoke('recording:set-capture-target', target),
    setNextSource: (payload: {
      config: RecordingSourceConfig;
      windowId: string | null;
      micDeviceId: string | null;
    } | null): Promise<boolean> => ipcRenderer.invoke('recording:set-next-source', payload),
    getStartConfig: (kind: RecordKind): Promise<{
      enabled: boolean;
      config: RecordingSourceConfig;
      windowId: string | null;
      micDeviceId: string | null;
      soundFeedback: boolean;
    }> => ipcRenderer.invoke('recording:get-start-config', kind),
    saveAs: (callId: string): Promise<SaveAsResult> =>
      ipcRenderer.invoke('recording:save-as', callId),
  },
  whisper: {
    binaryStatus: (): Promise<{ installed: boolean }> => ipcRenderer.invoke('whisper:binary-status'),
    downloadBinary: (): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('whisper:download-binary'),
  },
  capture: {
    listWindows: (): Promise<CaptureWindow[]> => ipcRenderer.invoke('capture:list-windows'),
  },
  audio: {
    pick: (): Promise<
      { canceled: true } | { canceled: false; path: string; name: string; sizeBytes: number; mtime: string }
    > => ipcRenderer.invoke('audio:pick'),
    import: (opts: {
      filePath: string;
      kind: RecordKind;
      title?: string;
      contactName?: string;
      startTime?: string;
      autoTranscribe: boolean;
    }): Promise<{ ok: true; record: CallRecord } | { ok: false; error: string }> =>
      ipcRenderer.invoke('audio:import', opts),
  },
  transcript: {
    saveAs: (callId: string, withTimestamps: boolean): Promise<SaveAsResult> =>
      ipcRenderer.invoke('transcript:save-as', callId, withTimestamps),
  },
  minutes: {
    saveAs: (callId: string): Promise<SaveAsResult> =>
      ipcRenderer.invoke('minutes:save-as', callId),
  },
  transcription: {
    start: (callId: string): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke('transcription:start', callId),
    cancel: (callId: string): Promise<boolean> =>
      ipcRenderer.invoke('transcription:cancel', callId),
    checkSetup: (): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke('transcription:check-setup'),
    downloadModel: (model: WhisperModel): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('transcription:download-model', model),
    modelStatus: (model: WhisperModel): Promise<{ downloaded: boolean; path: string }> =>
      ipcRenderer.invoke('transcription:model-status', model),
    deleteModel: (model: WhisperModel): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('transcription:delete-model', model),
  },
  retention: {
    runNow: (): Promise<number> => ipcRenderer.invoke('retention:run-now'),
  },
  backup: {
    create: (): Promise<string> => ipcRenderer.invoke('backup:create'),
    chooseDir: (): Promise<{ canceled: true } | { canceled: false; dir: string }> =>
      ipcRenderer.invoke('backup:choose-dir'),
    restore: (): Promise<
      { canceled: true } | { canceled: false; calls: number; backupPath: string }
    > => ipcRenderer.invoke('backup:restore'),
    restoreJson: (json: unknown): Promise<{ calls: number; backupPath: string }> =>
      ipcRenderer.invoke('backup:restore-json', json),
  },
  util: {
    /** ドラッグ&ドロップされた File の絶対パスを取得（Electron 32+ で File.path が廃止されたため） */
    getFilePath: (file: File): string => webUtils.getPathForFile(file),
  },
  onEvent: (cb: (e: AppEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: AppEvent) => cb(payload);
    ipcRenderer.on('app-event', listener);
    return () => {
      ipcRenderer.off('app-event', listener);
    };
  },
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
