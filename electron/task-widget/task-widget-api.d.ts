import { TaskWidgetContentData } from '../shared-with-frontend/task-widget.model';

interface TaskWidgetAPI {
  undoPlan: (
    plan: import('../shared-with-frontend/task-planning').TaskPlan,
  ) => Promise<boolean>;
  applyPlan: (
    plan: import('../shared-with-frontend/task-planning').TaskPlan,
  ) => Promise<boolean>;
  suggest: (
    text: string,
    daily: boolean,
  ) => Promise<import('../shared-with-frontend/task-planning').PlanningReply>;
  act: (id: string | null, action: string, value?: string) => void;
  openCodexThread: (id: string) => void;
  toggleProgress: (id: string) => void;
  writeTask: (
    id: string | null,
    title: string,
    context?: { projectId?: string; today?: boolean },
  ) => void;
  completeTask: (id: string) => void;
  showMainWindow: () => void;
  onUpdateContent: (callback: (data: TaskWidgetContentData) => void) => () => void;
  onUpdateOpacity: (callback: (opacity: number) => void) => () => void;
}

declare global {
  interface Window {
    taskWidgetAPI: TaskWidgetAPI;
  }
}

export {};
