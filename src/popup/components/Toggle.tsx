interface ToggleProps {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  labelledBy: string;
  describedBy?: string;
}

export function Toggle({ id, checked, onChange, labelledBy, describedBy }: ToggleProps) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onClick={() => {
        onChange(!checked);
      }}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 ${
        checked ? 'bg-indigo-600 dark:bg-indigo-500' : 'bg-slate-300 dark:bg-slate-700'
      }`}
    >
      <span
        aria-hidden
        className={`inline-block size-4 rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-[18px]' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}
