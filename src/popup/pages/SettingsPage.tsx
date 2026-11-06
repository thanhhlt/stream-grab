import { ACTIVE_TASKS, SEGMENT_CONCURRENCY } from '@/shared/constants';
import {
  OUTPUT_FORMATS,
  RESOLUTION_PREFERENCES,
  type OutputFormat,
  type ResolutionPreference,
} from '@/shared/settings/settings';
import { isOneOf } from '@/shared/utils/guards';
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

const selectClass =
  'w-44 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-[13px] focus-visible:outline-2 focus-visible:outline-indigo-500 dark:border-slate-700 dark:bg-slate-900';

const rangeClass = 'w-full accent-indigo-600 dark:accent-indigo-400';

export function SettingsPage() {
  const { settings, error, update, reset } = useSettings();

  if (!settings) {
    return <p className="p-4 text-slate-500">{error ?? 'Loading settings…'}</p>;
  }

  return (
    <div className="px-4 pb-4">
      {error && (
        <p role="alert" className="mt-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      <section className="divide-y divide-slate-200 dark:divide-slate-800">
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
            <select
              id="preferred-resolution"
              value={settings.preferredResolution}
              aria-describedby="preferred-resolution-desc"
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (isOneOf(value, RESOLUTION_PREFERENCES)) update({ preferredResolution: value });
              }}
              className={selectClass}
            >
              {RESOLUTION_PREFERENCES.map((option) => (
                <option key={option} value={option}>
                  {RESOLUTION_LABELS[option]}
                </option>
              ))}
            </select>
          }
        />

        <SettingRow
          id="output-format"
          label="Output format"
          description="Streams are copied without re-encoding. Auto saves MP4, or MKV when the streams cannot be stored in MP4."
          control={
            <select
              id="output-format"
              value={settings.outputFormat}
              aria-describedby="output-format-desc"
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (isOneOf(value, OUTPUT_FORMATS)) update({ outputFormat: value });
              }}
              className={selectClass}
            >
              {OUTPUT_FORMATS.map((option) => (
                <option key={option} value={option}>
                  {FORMAT_LABELS[option]}
                </option>
              ))}
            </select>
          }
        />

        <SettingRow
          id="auto-detect"
          label="Detect videos automatically"
          description="Watch page network traffic for HLS and DASH manifests."
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
      </section>

      <button
        type="button"
        onClick={reset}
        className="mt-2 text-xs font-medium text-slate-500 underline-offset-2 hover:text-slate-800 hover:underline dark:text-slate-400 dark:hover:text-slate-200"
      >
        Reset to defaults
      </button>
    </div>
  );
}
