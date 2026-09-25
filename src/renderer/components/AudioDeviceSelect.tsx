import { useEffect, useState } from 'react';
import { toUserMessage } from '../utils/errorMessage';

interface Props {
  value: string | null;
  onChange: (deviceId: string | null) => void;
}

export function AudioDeviceSelect({ value, onChange }: Props) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [needPermission, setNeedPermission] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enumerate = async () => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      const inputs = list.filter((d) => d.kind === 'audioinput');
      setDevices(inputs);
      setNeedPermission(inputs.some((d) => !d.label));
    } catch (err) {
      setError(toUserMessage(err));
    }
  };

  useEffect(() => {
    enumerate();
    const onChangeDev = () => enumerate();
    navigator.mediaDevices.addEventListener?.('devicechange', onChangeDev);
    return () => navigator.mediaDevices.removeEventListener?.('devicechange', onChangeDev);
  }, []);

  const requestPermission = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      await enumerate();
    } catch (err) {
      setError(toUserMessage(err));
    }
  };

  return (
    <div className="space-y-1">
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
      >
        <option value="">既定のマイク</option>
        {devices.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || `(無名デバイス) ${d.deviceId.slice(0, 6)}`}
          </option>
        ))}
      </select>
      {needPermission && (
        <button
          onClick={requestPermission}
          className="text-xs text-brand-700 underline hover:text-brand-800 dark:text-brand-300 dark:hover:text-brand-200"
        >
          マイクのアクセスを許可してデバイス名を表示
        </button>
      )}
      {error && <div className="text-xs text-red-600 dark:text-red-400">{error}</div>}
    </div>
  );
}
