import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import type {
  CallRecord, Settings, CsvExportOptions, AppEvent, CsvImportResult, WhisperModel, HudSize,
} from '../shared/types';

const api = {
  calls: {
    list: (): Promise<CallRecord[]> => ipcRenderer.invoke('calls:list'),
    get: (id: string): Promise<CallRecord | null> => ipcRenderer.invoke('calls:get', id),
    getActive: (): Promise<CallRecord | null> => ipcRenderer.invoke('calls:getActive'),
    startNow: (): Promise<CallRecord | null> => ipcRenderer.invoke('calls:startNow'),
    endNow: (): Promise<CallRecord | null> => ipcRenderer.invoke('calls:endNow'),
    toggleHold: (): Promise<void> => ipcRenderer.invoke('calls:toggleHold'),
    update: (id: string, patch: Partial<CallRecord>): Promise<CallRecord | null> =>
      ipcRenderer.invoke('calls:update', id, patch),
    create: (partial: Partial<CallRecord>): Promise<CallRecord> =>
      ipcRenderer.invoke('calls:create', partial),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke('calls:delete', id),
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
    finalize: (callId: string): Promise<CallRecord | null> =>
      ipcRenderer.invoke('recording:finalize', callId),
    abort: (callId: string): Promise<boolean> => ipcRenderer.invoke('recording:abort', callId),
  },
  transcription: {
    start: (callId: string): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke('transcription:start', callId),
    checkSetup: (): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke('transcription:check-setup'),
    downloadModel: (model: WhisperModel): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('transcription:download-model', model),
    modelStatus: (model: WhisperModel): Promise<{ downloaded: boolean; path: string }> =>
      ipcRenderer.invoke('transcription:model-status', model),
  },
  retention: {
    runNow: (): Promise<number> => ipcRenderer.invoke('retention:run-now'),
  },
  backup: {
    create: (): Promise<string> => ipcRenderer.invoke('backup:create'),
    restore: (): Promise<
      { canceled: true } | { canceled: false; calls: number; backupPath: string }
    > => ipcRenderer.invoke('backup:restore'),
    restoreJson: (json: unknown): Promise<{ calls: number; backupPath: string }> =>
      ipcRenderer.invoke('backup:restore-json', json),
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
