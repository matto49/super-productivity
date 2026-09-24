import { contextBridge, ipcRenderer } from 'electron';

import { TaskWidgetContentData } from '../shared-with-frontend/task-widget.model';

contextBridge.exposeInMainWorld('taskWidgetAPI', {
  undoPlan: (plan: unknown) => ipcRenderer.invoke('task-widget-undo-plan', plan),
  applyPlan: (plan: unknown) => ipcRenderer.invoke('task-widget-apply-plan', plan),
  suggest: (text: string, daily: boolean) =>
    ipcRenderer.invoke('task-widget-suggest', { text, daily }),
  act: (id: string | null, action: string, value?: string) =>
    ipcRenderer.send('task-widget-action', { id, action, value }),
  openCodexThread: (id: string) => ipcRenderer.send('task-widget-open-codex', id),
  toggleProgress: (id: string) => ipcRenderer.send('task-widget-progress', id),
  writeTask: (
    id: string | null,
    title: string,
    context?: { projectId?: string; today?: boolean },
  ) => ipcRenderer.send('task-widget-write', { id, title, context }),
  completeTask: (id: string) => ipcRenderer.send('task-widget-complete', id),
  showMainWindow: () => {
    ipcRenderer.send('task-widget-show-main-window');
  },
  onUpdateContent: (callback: (data: TaskWidgetContentData) => void) => {
    const listener = (
      event: Electron.IpcRendererEvent,
      data: TaskWidgetContentData,
    ): void => callback(data);
    ipcRenderer.on('update-content', listener);

    // Return cleanup function
    return () => {
      ipcRenderer.removeListener('update-content', listener);
    };
  },
  onUpdateOpacity: (callback: (opacity: number) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, opacity: number): void =>
      callback(opacity);
    ipcRenderer.on('update-opacity', listener);

    return () => {
      ipcRenderer.removeListener('update-opacity', listener);
    };
  },
});
