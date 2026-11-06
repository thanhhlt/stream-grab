import type { Tone } from '../format';

const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  progress: 'bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300',
  success: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  warning: 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  danger: 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300',
};

export function Badge({ tone, children }: { tone: Tone; children: string }) {
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ${TONE_CLASSES[tone]}`}>
      {children}
    </span>
  );
}
