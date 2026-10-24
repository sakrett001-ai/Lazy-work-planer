import { pendingAssistantJobs } from './prototype.ts';

/** One application-owned pump. SQLite claims arbitrate across other processes.
 * Only explicitly requested, never-started jobs are eligible for execution.
 * stop() prevents new starts; in-flight calls retain the runner's 8-minute bound.
 */
export function createConsultationWorker({ runConsultation, intervalMs = 1000 }: {
  runConsultation: (jobId: string) => Promise<void>; intervalMs?: number;
}) {
  let stopped = false, active: Promise<void> | undefined;
  function wake(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (active) return active;
    active = (async () => {
      const ids = pendingAssistantJobs();
      await Promise.all(ids.map(async id => { if (!stopped) await runConsultation(id); }));
    })().finally(() => { active = undefined; });
    return active;
  }
  const timer = setInterval(() => { void wake().catch(() => console.error('Очередь консультаций временно недоступна.')); }, intervalMs);
  timer.unref();
  return { wake, stop() { stopped = true; clearInterval(timer); } };
}
