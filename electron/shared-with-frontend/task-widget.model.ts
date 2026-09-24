export interface TaskWidgetListItem {
  id: string;
  title: string;
  parentId?: string;
  codexThreadUrl?: string;
  inProgress?: boolean;
  review?: boolean;
  today?: boolean;
  inTodayView?: boolean;
  todayRank?: number;
  important?: boolean;
  urgent?: boolean;
  projectId?: string;
  projectTitle?: string;
  dueDay?: string;
  dueWithTime?: number;
  estimateMs?: number;
  scheduleLabel?: string;
  humanMs?: number;
  aiMs?: number;
  trackedMs?: number;
  associationLabel?: string;
  associationDetail?: string;
  aiCoverageIncomplete?: boolean;
  humanCoverageIncomplete?: boolean;
}

export interface TaskWidgetListData {
  today: TaskWidgetListItem[];
  all: TaskWidgetListItem[];
  projectTasks?: Record<string, TaskWidgetListItem[]>;
  activeView?: string;
  projects?: { id: string; title: string }[];
  labels: {
    today: string;
    all: string;
    view?: string;
    empty: string;
    complete: string;
    open: string;
    add?: string;
    edit?: string;
    openCodex?: string;
    progress?: string;
    pending?: string;
    human?: string;
    ai?: string;
    tracked?: string;
    review?: string;
    focus?: string;
    important?: string;
    urgent?: string;
    project?: string;
    detail?: string;
    inbox?: string;
    planner?: string;
    schedule?: string;
    planTask?: string;
    addToday?: string;
    removeToday?: string;
    aiCapture?: string;
    aiToday?: string;
    aiThinking?: string;
    aiAccept?: string;
    aiSaveOnly?: string;
    aiError?: string;
    aiBudget?: string;
    aiMinutes?: string;
    aiReady?: string;
    aiAdopt?: string;
    aiUndo?: string;
    aiUndone?: string;
    aiChanged?: string;
    aiAdopted?: string;
    aiEmpty?: string;
    aiSuggestion?: string;
  };
}

export interface TaskWidgetContentData {
  title: string;
  time: string;
  mode: 'pomodoro' | 'focus' | 'task' | 'idle';
  list?: {
    tasks: TaskWidgetListItem[];
    projectTasks?: Record<string, TaskWidgetListItem[]>;
    labels: TaskWidgetListData['labels'];
    scope: 'today' | 'all';
    activeView?: string;
    projects?: { id: string; title: string }[];
  };
}
