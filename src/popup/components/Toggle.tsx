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
      // Rãnh tắt dùng `faint` (≥ 3.8:1 với nền) để công tắc vẫn nhìn thấy được; bật là cam.
      className={`relative inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-120 ease-out ${
        checked ? 'bg-primary' : 'bg-faint'
      }`}
    >
      <span
        aria-hidden
        className={`inline-block size-[18px] rounded-full bg-bg transition-transform duration-200 ease-out ${
          checked ? 'translate-x-[19px]' : 'translate-x-[3px]'
        }`}
      />
    </button>
  );
}
