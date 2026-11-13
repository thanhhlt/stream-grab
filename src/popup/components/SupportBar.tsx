import { PROJECT_LINKS } from '@/shared/constants';
import { BUTTON } from './buttons';
import { Icon } from './Icon';

/**
 * The quiet line under every tab: the Ko-fi link and the way into About. It never moves, counts
 * or asks twice (docs/ROADMAP.md "Funding": donations stay voluntary).
 */
export function SupportBar({ onOpenAbout }: { onOpenAbout: () => void }) {
  return (
    <footer className="flex h-9 shrink-0 items-center gap-2 border-t border-line pr-1.5 pl-4">
      <Icon name="heart" className="size-4 text-primary-strong" />
      <p className="min-w-0 flex-1 truncate text-meta text-muted">
        StreamGrab is free.{' '}
        <a
          href={PROJECT_LINKS.donate}
          target="_blank"
          rel="noreferrer"
          className="rounded-sm font-semibold text-primary-text underline-offset-2 hover:underline"
        >
          Support on Ko-fi
        </a>
      </p>
      <button type="button" onClick={onOpenAbout} className={BUTTON.ghost}>
        About
      </button>
    </footer>
  );
}
