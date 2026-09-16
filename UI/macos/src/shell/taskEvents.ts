import { t } from '../i18n';
import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { isOffline } from '../api';
import { useApp } from '../store';
import { useToast } from '../store/toast';

export function useScheduledTaskEvents(): void {
  useEffect(() => {
    if (isOffline) return;
    let active = true;
    const run = listen<{ name: string; status: string; message: string }>('scheduled-task-run', event => {
      if (!active) return;
      void useApp.getState().refresh('tasks');
      const { name, status, message } = event.payload;
      useToast.getState().push(status === 'failed' ? 'error' : 'success', `${name}: ${t(message)}`);
    });
    const error = listen<string>('scheduled-task-error', event => {
      if (active) useToast.getState().error(t(event.payload));
    });
    // Also reconcile after a hidden/minimized window misses an event.
    const timer = setInterval(() => { void useApp.getState().refresh('tasks'); }, 15_000);
    const subscriptions = [run, error];
    for (const pending of subscriptions) void pending.catch(cause => { if (active) useToast.getState().error(String(cause)); });
    return () => { active = false; clearInterval(timer); for (const pending of subscriptions) void pending.then(off => off()).catch(() => undefined); };
  }, []);
}
