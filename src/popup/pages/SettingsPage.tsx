import { useState, type CSSProperties } from 'react';
import { MAX_FOLDER_LENGTH, parseDownloadFolder } from '@/core/download/file-name';
import { ACTIVE_TASKS, SEGMENT_CONCURRENCY } from '@/shared/constants';
import {
  OUTPUT_FORMATS,
  RESOLUTION_PREFERENCES,
  THEMES,
  type OutputFormat,
  type ResolutionPreference,
  type Theme,
} from '@/shared/settings/settings';
import { isOneOf } from '@/shared/utils/guards';
import { BUTTON } from '../components/buttons';
import { Segmented } from '../components/Segmented';
import { Select } from '../components/Select';
import { SettingRow } from '../components/SettingRow';
import { Toggle } from '../components/Toggle';
import { useSettings } from '../hooks/useSettings';

const RESOLUTION_LABELS: Record<ResolutionPreference, string> = {
  highest: 'Highest available',
  '2160': '2160p (4K)',
  '1440': '1440p',
  '1080': '1080p',
  '720': '720p',
  '480': '480p',
  '360': '360p',
  lowest: 'Lowest available',
};

const FORMAT_LABELS: Record<OutputFormat, string> = {
  auto: 'Auto',
  mp4: 'MP4',
  mkv: 'MKV',
};

const THEME_LABELS: Record<Theme, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

const THEME_OPTIONS = THEMES.map((value) => ({ value, label: THEME_LABELS[value] }));

/** Thanh trượt vẽ như thanh tiến độ (`.range` trong styles.css): phần đã chọn tới giá trị hiện tại. */
const rangeClass = 'range w-full';

function rangeFill(value: number, { min, max }: { min: number; max: number }): CSSProperties {
  return { '--fill': `${((value - min) / (max - min)) * 100}%` } as CSSProperties;
}

/** Ô nhập 10 px bo góc trên nền `surface`; sai thì viền `danger` (kèm lý do bằng chữ ngay dưới). */
const inputClass =
  'h-[30px] w-full rounded-field bg-surface px-2.5 text-ink placeholder:text-muted aria-invalid:ring-2 aria-invalid:ring-danger';

/**
 * The Downloads subfolder: saved on Enter or when the field loses focus, in
 * the form Chrome accepts (shown back in the field); a path outside
 * Downloads stays in the field with the reason, unsaved.
 */
function DownloadFolderInput({ value, onSave }: { value: string; onSave: (folder: string) => void }) {
  /** What the user is typing; null shows the saved value (also after Reset to defaults). */
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const parsed = parseDownloadFolder(draft);
    if (!parsed.ok) {
      setProblem(parsed.reason);
      return;
    }
    setProblem(null);
    setDraft(null);
    if (parsed.folder !== value) onSave(parsed.folder);
  };
  const shown = draft ?? value;
  return (
    <div className="flex flex-col gap-1">
      <input
        id="download-folder"
        type="text"
        value={shown}
        placeholder="Empty: the download folder itself"
        maxLength={MAX_FOLDER_LENGTH * 2}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={problem !== null}
        aria-describedby={problem !== null ? 'download-folder-desc download-folder-error' : 'download-folder-desc'}
        onChange={(event) => {
          setDraft(event.currentTarget.value);
          setProblem(null);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
          if (event.key === 'Escape' && draft !== null) {
            event.preventDefault();
            setDraft(null);
            setProblem(null);
          }
        }}
        className={inputClass}
      />
      {problem !== null ? (
        <p id="download-folder-error" role="alert" className="text-meta text-danger">
          {problem}
        </p>
      ) : (
        <p className="truncate text-tech text-muted" title={`Downloads/${value}`}>
          Saving to: Downloads{value === '' ? '' : `/${value}`}
        </p>
      )}
    </div>
  );
}

export function SettingsPage() {
  const { settings, error, update, reset } = useSettings();

  if (!settings) {
    return <p className="p-4 text-muted">{error ?? 'Loading settings…'}</p>;
  }

  return (
    <div className="px-4 pb-4">
      {error && (
        <p role="alert" className="mt-3 rounded-field bg-danger-surface px-3 py-2 text-meta text-danger">
          {error}
        </p>
      )}

      <section className="divide-y divide-line">
        <SettingRow
          id="segment-concurrency"
          label={`Concurrent segment requests: ${settings.segmentConcurrency}`}
          description="Parallel requests per video. More is not always faster; some servers throttle or block aggressive clients."
          stacked
          control={
            <input
              id="segment-concurrency"
              type="range"
              min={SEGMENT_CONCURRENCY.min}
              max={SEGMENT_CONCURRENCY.max}
              step={1}
              value={settings.segmentConcurrency}
              style={rangeFill(settings.segmentConcurrency, SEGMENT_CONCURRENCY)}
              aria-describedby="segment-concurrency-desc"
              onChange={(event) => {
                update({ segmentConcurrency: event.currentTarget.valueAsNumber });
              }}
              className={rangeClass}
            />
          }
        />

        <SettingRow
          id="active-tasks"
          label={`Simultaneous downloads: ${settings.maxActiveTasks}`}
          description="Videos that download segments at the same time. Merging always runs one video at a time."
          stacked
          control={
            <input
              id="active-tasks"
              type="range"
              min={ACTIVE_TASKS.min}
              max={ACTIVE_TASKS.max}
              step={1}
              value={settings.maxActiveTasks}
              style={rangeFill(settings.maxActiveTasks, ACTIVE_TASKS)}
              aria-describedby="active-tasks-desc"
              onChange={(event) => {
                update({ maxActiveTasks: event.currentTarget.valueAsNumber });
              }}
              className={rangeClass}
            />
          }
        />

        <SettingRow
          id="preferred-resolution"
          label="Default resolution"
          description="Picked when a stream offers several qualities. Falls back to the nearest lower one."
          control={
            <Select
              id="preferred-resolution"
              value={settings.preferredResolution}
              aria-describedby="preferred-resolution-desc"
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (isOneOf(value, RESOLUTION_PREFERENCES)) update({ preferredResolution: value });
              }}
              className="w-44"
            >
              {RESOLUTION_PREFERENCES.map((option) => (
                <option key={option} value={option}>
                  {RESOLUTION_LABELS[option]}
                </option>
              ))}
            </Select>
          }
        />

        <SettingRow
          id="output-format"
          label="Output format"
          description="Streams are copied without re-encoding. Auto saves MP4, or MKV when the streams cannot be stored in MP4."
          control={
            <Select
              id="output-format"
              value={settings.outputFormat}
              aria-describedby="output-format-desc"
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (isOneOf(value, OUTPUT_FORMATS)) update({ outputFormat: value });
              }}
              className="w-44"
            >
              {OUTPUT_FORMATS.map((option) => (
                <option key={option} value={option}>
                  {FORMAT_LABELS[option]}
                </option>
              ))}
            </Select>
          }
        />

        <SettingRow
          id="download-folder"
          label="Save in a subfolder"
          description="A folder inside Chrome's download folder, such as StreamGrab or Videos/StreamGrab. Chrome creates it when it saves the first video there."
          stacked
          control={
            <DownloadFolderInput
              value={settings.downloadFolder}
              onSave={(folder) => {
                update({ downloadFolder: folder });
              }}
            />
          }
        />

        <SettingRow
          id="auto-detect"
          label="Detect videos automatically"
          description="Watch page network traffic for supported media streams."
          control={
            <Toggle
              id="auto-detect"
              checked={settings.autoDetect}
              labelledBy="auto-detect-label"
              describedBy="auto-detect-desc"
              onChange={(checked) => {
                update({ autoDetect: checked });
              }}
            />
          }
        />

        <SettingRow
          id="auto-remove"
          label="Remove finished tasks from the queue"
          description="Completed videos stay listed under Completed."
          control={
            <Toggle
              id="auto-remove"
              checked={settings.autoRemoveCompleted}
              labelledBy="auto-remove-label"
              describedBy="auto-remove-desc"
              onChange={(checked) => {
                update({ autoRemoveCompleted: checked });
              }}
            />
          }
        />

        <SettingRow
          id="theme"
          label="Theme"
          description="System follows Chrome's appearance setting."
          group
          control={
            <Segmented
              id="theme"
              name="theme"
              value={settings.theme}
              options={THEME_OPTIONS}
              labelledBy="theme-label"
              describedBy="theme-desc"
              onChange={(theme) => {
                update({ theme });
              }}
              className="w-48"
            />
          }
        />
      </section>

      <button type="button" onClick={reset} className={`${BUTTON.ghost} mt-1 -ml-2.5`}>
        Reset to defaults
      </button>
    </div>
  );
}
