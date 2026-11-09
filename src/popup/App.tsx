import { useRef, useState } from 'react';
import { ACTIVE_TASK_STATUSES } from '@/core/models/download-task';
import { Header } from './components/Header';
import { TabBar, type TabId } from './components/TabBar';
import { playGrab } from './grab';
import { useBackgroundStatus } from './hooks/useBackgroundStatus';
import { useTasks } from './hooks/useTasks';
import { CompletedPage } from './pages/CompletedPage';
import { DetectedPage } from './pages/DetectedPage';
import { QueuePage } from './pages/QueuePage';
import { SettingsPage } from './pages/SettingsPage';

export function App() {
  const [tab, setTab] = useState<TabId>('detected');
  const status = useBackgroundStatus();
  const tasks = useTasks();
  const activeTasks = tasks?.filter((task) => ACTIVE_TASK_STATUSES.includes(task.status)).length ?? 0;
  // Hiệu ứng gắp: từ ô poster lên móng trong header, rồi xuống số đếm của tab Queue.
  const claw = useRef<SVGSVGElement>(null);
  const tabs = useRef<HTMLDivElement>(null);

  return (
    <div className="flex h-full flex-col">
      <Header status={status} clawRef={claw} />
      <TabBar ref={tabs} active={tab} onChange={setTab} counts={{ queue: activeTasks }} />
      <main className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'detected' && (
          <DetectedPage
            onShowQueue={() => {
              setTab('queue');
            }}
            onQueued={(tiles) => {
              playGrab(tiles, { claw: claw.current, tabs: tabs.current });
            }}
          />
        )}
        {tab === 'queue' && <QueuePage tasks={tasks} />}
        {tab === 'completed' && <CompletedPage tasks={tasks} />}
        {tab === 'settings' && <SettingsPage />}
      </main>
    </div>
  );
}
