import type { ReactNode } from 'react';

interface SettingRowProps {
  /** id prefix; the label gets `${id}-label` and the description `${id}-desc`. */
  id: string;
  label: string;
  description: string;
  control: ReactNode;
  /** Renders the control below the text instead of beside it (sliders). */
  stacked?: boolean;
}

export function SettingRow({ id, label, description, control, stacked = false }: SettingRowProps) {
  return (
    <div className={stacked ? 'flex flex-col gap-2 py-3' : 'flex items-center gap-4 py-3'}>
      <div className="min-w-0 flex-1">
        <label id={`${id}-label`} htmlFor={id} className="block font-semibold text-ink">
          {label}
        </label>
        <p id={`${id}-desc`} className="mt-0.5 text-meta text-muted">
          {description}
        </p>
      </div>
      {control}
    </div>
  );
}
