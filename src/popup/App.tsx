import { useRef, useState } from 'react';
import { ACTIVE_TASK_STATUSES } from '@/core/models/download-task';
import { Header } from './components/Header';
import { SupportBar } from './components/SupportBar';
import { TabBar, type TabId } from './components/TabBar';
import { playGrab } from './grab';
import { useBackgroundStatus } from './hooks/useBackgroundStatus';
import { useTasks } from './hooks/useTasks';
import { useTheme } from './hooks/useTheme';
import { AboutPage } from './pages/AboutPage';
import { CompletedPage } from './pages/CompletedPage';
import { DetectedPage } from './pages/DetectedPage';
import { QueuePage } from './pages/QueuePage';
import { SettingsPage } from './pages/SettingsPage';

export function App() {
  const [tab, setTab] = useState<TabId>('detected');
  /** About takes the tab bar's place; Back returns to the tab the user was on. */
  const [about, setAbout] = useState(false);
  const status = useBackgroundStatus();
  const tasks = useTasks();
  const { theme, setTheme } = useTheme();
  const activeTasks = tasks?.filter((task) => ACTIVE_TASK_STATUSES.includes(task.status)).length ?? 0;
  // Hiệu ứng gắp: từ ô poster lên móng trong header, rồi xuống số đếm của tab Queue.
  // Số đếm Queue được giữ nguyên từ lúc bấm Download tới khi ô bay vào tab Queue, rồi mới nhảy lên.
  const [held, setHeld] = useState<number | null>(null);
  const claw = useRef<SVGSVGElement>(null);
  const tabs = useRef<HTMLDivElement>(null);

  return (
    <div className="flex h-full flex-col">
      <Header status={status} clawRef={claw} theme={theme} onThemeChange={setTheme} />
      {about ? (
        <AboutPage
          onBack={() => {
            setAbout(false);
            // Back to the tabs: the keyboard continues from the tab that was open.
            requestAnimationFrame(() => {
              tabs.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
            });
          }}
        />
      ) : (
        <>
          <TabBar ref={tabs} active={tab} onChange={setTab} counts={{ queue: held ?? activeTasks }} />
          <main className="min-h-0 flex-1 overflow-y-auto">
            {tab === 'detected' && (
              <DetectedPage
                onShowQueue={() => {
                  setTab('queue');
                }}
                onQueueing={() => {
                  setHeld((previous) => previous ?? activeTasks);
                }}
                onQueueAborted={() => {
                  setHeld(null);
                }}
                onQueued={(tiles) => {
                  playGrab(tiles, { claw: claw.current, tabs: tabs.current }, () => {
                    setHeld(null);
                  });
                }}
              />
            )}
            {tab === 'queue' && <QueuePage tasks={tasks} />}
            {tab === 'completed' && <CompletedPage tasks={tasks} />}
            {tab === 'settings' && <SettingsPage />}
          </main>
          <SupportBar
            onOpenAbout={() => {
              setAbout(true);
            }}
          />
        </>
      )}
    </div>
  );
}
