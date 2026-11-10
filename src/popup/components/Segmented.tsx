interface SegmentedProps<T extends string> {
  /** id of the group; SettingRow's label and description point at it with aria-labelledby/-describedby. */
  id: string;
  /** Radio name, shared by the options so arrow keys move between them. */
  name: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  labelledBy: string;
  describedBy?: string;
  /** Width of the track (e.g. `w-48`: three equal pills that fit "System" in semibold). */
  className?: string;
}

/**
 * A few mutually exclusive choices side by side (Claw): native radios, so Tab enters the group at
 * the checked option and the arrow keys change it. Each option is a pill on a `surface` track,
 * the checked one filled with `bg` and outlined in `line`; the focus ring is drawn on the pill
 * because the radio itself is visually hidden.
 */
export function Segmented<T extends string>({
  id,
  name,
  value,
  options,
  onChange,
  labelledBy,
  describedBy,
  className = '',
}: SegmentedProps<T>) {
  return (
    <div
      id={id}
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className={`inline-flex h-[30px] shrink-0 rounded-full bg-surface p-[3px] ${className}`}
    >
      {options.map((option) => (
        // relative: the hidden radio (sr-only = absolute) must sit inside its pill. Without it, its containing
        // block is outside the scrolling <main>, so it stays where the pill was before scrolling, and the focus a
        // click gives it scrolls the whole popup to reach it (the header and tabs disappear).
        <label key={option.value} className="relative flex min-w-0 flex-1 cursor-pointer">
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => {
              onChange(option.value);
            }}
            className="peer sr-only"
          />
          <span className="flex w-full items-center justify-center rounded-full px-1.5 text-control text-muted transition-colors duration-120 ease-out peer-checked:bg-bg peer-checked:font-semibold peer-checked:text-ink peer-checked:ring-1 peer-checked:ring-line peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary-text hover:text-ink">
            {option.label}
          </span>
        </label>
      ))}
    </div>
  );
}
