import { validatePlans } from '../shared-with-frontend/task-planning';
import { suggestPlans } from './ai-planner';
import { isCodexThreadLink } from '../shared-with-frontend/codex-thread-link';
import {
  app,
  BrowserWindow,
  BrowserWindowConstructorOptions,
  ipcMain,
  screen,
  shell,
} from 'electron';
import { join } from 'path';
import { assertSecureWebPreferences } from '../web-preferences-guard';
import { TaskCopy } from '../../src/app/features/tasks/task.model';
import { TaskWidgetConfig } from '../../src/app/features/config/global-config.model';
import { info } from 'electron-log/main';
import { IPC } from '../shared-with-frontend/ipc-events.const';
import { loadSimpleStoreAll, saveSimpleStore } from '../simple-store';
import { IS_MAC } from '../common.const';

import { TaskWidgetListData } from '../shared-with-frontend/task-widget.model';

let listData: TaskWidgetListData | undefined;
let displayMode: 'timer' | 'today' | 'all' = 'timer';

let taskWidgetWin: BrowserWindow | null = null;
let isTaskWidgetEnabled = false;
let isAlwaysShow = false;
// Set when the user explicitly reveals the widget via the global shortcut
// (`globalToggleTaskWidget`) while the main window is visible. Like
// `isAlwaysShow`, it suppresses the automatic "hide the widget when the main
// window is shown/focused" behavior — but only until the user hides the widget
// again (toggles off) or opens the app from the widget. This gives the shortcut
// a sticky "user-forced visible" effect instead of being immediately undone by
// the next focus event.
let isUserForcedVisible = false;
let currentTask: TaskCopy | null = null;
let isPomodoroEnabled = false;
let currentPomodoroSessionTime = 0;
let isFocusModeEnabled = false;
let currentFocusSessionTime = 0;
let initTimeoutId: NodeJS.Timeout | null = null;
let currentOpacity = 95;
let listenersRegistered = false;
let taskWidgetCreationPromise: Promise<void> | null = null;
let taskWidgetCreationGeneration = 0;
let pendingShowAfterCreate = false;
let pendingShowAfterCreateInactive = false;

const TASK_WIDGET_BOUNDS_KEY = 'taskWidgetBounds';
const getBoundsKey = (): string =>
  displayMode === 'timer' ? TASK_WIDGET_BOUNDS_KEY : 'taskListWidgetBounds';
const LEGACY_BOUNDS_KEY = 'overlayBounds';
let boundsDebounceTimer: NodeJS.Timeout | null = null;

type ShowTaskWidgetOptions = Readonly<{
  inactive?: boolean;
}>;

export const updateTaskWidgetEnabled = (isEnabled: boolean): void => {
  isTaskWidgetEnabled = isEnabled;

  if (!isEnabled) {
    destroyTaskWidget();
    return;
  }

  if (!taskWidgetWin && !taskWidgetCreationPromise) {
    initListeners();
    createTaskWidgetWindow().then(() => {
      // Window creation is async; re-apply the cached opacity here because
      // updateTaskWidgetOpacity() is a no-op while taskWidgetWin is still null,
      // and on macOS BrowserWindow.setOpacity() defaults to 1 (no CSS fallback).
      if (taskWidgetWin && !taskWidgetWin.isDestroyed()) {
        updateTaskWidgetOpacity(currentOpacity);
      }
      // Request current task state after window is ready
      const mainWindow = BrowserWindow.getAllWindows().find(
        (win) => win !== taskWidgetWin,
      );
      if (mainWindow) {
        mainWindow.webContents.send(IPC.REQUEST_CURRENT_TASK_FOR_TASK_WIDGET);
      }
    });
  }
};

const clearPendingTaskWidgetCreation = (): void => {
  taskWidgetCreationGeneration += 1;
  taskWidgetCreationPromise = null;
  pendingShowAfterCreate = false;
  pendingShowAfterCreateInactive = false;
};

export const destroyTaskWidget = (): void => {
  // Clear any pending timeouts
  if (initTimeoutId) {
    clearTimeout(initTimeoutId);
    initTimeoutId = null;
  }

  // Clear bounds debounce timer
  if (boundsDebounceTimer) {
    clearTimeout(boundsDebounceTimer);
    boundsDebounceTimer = null;
  }

  // Disable task widget to prevent close event prevention
  isTaskWidgetEnabled = false;
  isUserForcedVisible = false;
  clearPendingTaskWidgetCreation();

  // Remove IPC listeners
  ipcMain.removeAllListeners('task-widget-show-main-window');
  ipcMain.removeAllListeners('task-widget-complete');
  ipcMain.removeAllListeners('task-widget-open-codex');
  ipcMain.removeAllListeners('task-widget-progress');
  listenersRegistered = false;

  if (taskWidgetWin && !taskWidgetWin.isDestroyed()) {
    try {
      // Remove ALL event listeners
      taskWidgetWin.removeAllListeners();

      // Remove webContents listeners
      if (taskWidgetWin.webContents && !taskWidgetWin.webContents.isDestroyed()) {
        taskWidgetWin.webContents.removeAllListeners();
      }

      // Hide first to prevent visual issues
      taskWidgetWin.hide();

      // Set closable to ensure we can close it
      taskWidgetWin.setClosable(true);

      // Force destroy the window
      taskWidgetWin.destroy();
    } catch (e) {
      // Window might already be destroyed
      console.error('Error destroying task widget window:', e);
    }

    taskWidgetWin = null;
  }
};

const createTaskWidgetWindow = (): Promise<void> => {
  if (taskWidgetWin) {
    return Promise.resolve();
  }

  if (taskWidgetCreationPromise) {
    return taskWidgetCreationPromise;
  }

  const creationGeneration = taskWidgetCreationGeneration;
  const nextCreationPromise = createTaskWidgetWindowForGeneration(
    creationGeneration,
  ).finally(() => {
    if (taskWidgetCreationPromise === nextCreationPromise) {
      taskWidgetCreationPromise = null;
    }
  });

  taskWidgetCreationPromise = nextCreationPromise;
  return nextCreationPromise;
};

const createTaskWidgetWindowForGeneration = async (
  creationGeneration: number,
): Promise<void> => {
  if (taskWidgetWin) {
    return;
  }

  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth } = primaryDisplay.workAreaSize;
  const isList = displayMode !== 'timer';
  const defaultBounds = {
    width: isList ? 360 : 300,
    height: isList ? 360 : 80,
    x: screenWidth - 380,
    y: 20,
  };

  // Restore persisted bounds or use defaults
  let bounds = defaultBounds;
  try {
    const store = await loadSimpleStoreAll();
    // Try new key first, fall back to legacy key for migration
    const saved = (store[getBoundsKey()] ||
      (displayMode === 'timer' ? store[LEGACY_BOUNDS_KEY] : undefined)) as
      | { width: number; height: number; x: number; y: number }
      | undefined;
    if (
      saved &&
      typeof saved.width === 'number' &&
      saved.width > 0 &&
      typeof saved.height === 'number' &&
      saved.height > 0 &&
      typeof saved.x === 'number' &&
      typeof saved.y === 'number'
    ) {
      // Validate saved bounds are visible on any connected display
      const matchingDisplay = screen.getDisplayMatching({
        x: saved.x,
        y: saved.y,
        width: saved.width,
        height: saved.height,
      });
      const isOnScreen =
        matchingDisplay &&
        saved.x + saved.width > matchingDisplay.bounds.x &&
        saved.x < matchingDisplay.bounds.x + matchingDisplay.bounds.width &&
        saved.y >= matchingDisplay.bounds.y &&
        saved.y < matchingDisplay.bounds.y + matchingDisplay.bounds.height;
      bounds = isOnScreen ? saved : defaultBounds;
    }
  } catch (_e) {
    // Use defaults (file may not exist on first run)
  }

  if (
    taskWidgetWin ||
    !isTaskWidgetEnabled ||
    creationGeneration !== taskWidgetCreationGeneration
  ) {
    return;
  }

  const webPreferences: BrowserWindowConstructorOptions['webPreferences'] = {
    preload: join(__dirname, 'task-widget-preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    disableDialogs: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    backgroundThrottling: false, // Prevent throttling when hidden
  };
  // Keep the widget renderer's IPC boundary as tight as the main window's.
  assertSecureWebPreferences(webPreferences, 'task-widget');

  // On macOS, transparent + frameless windows do not support native window
  // dragging or edge resizing (see Electron's BrowserWindow docs: "Transparent
  // windows are not resizable. Setting `resizable` to `true` may make a
  // transparent window stop working on some platforms."). Use a solid window
  // instead and rely on BrowserWindow.setOpacity() for the user-set opacity so
  // the OS keeps native drag/resize behavior intact.
  taskWidgetWin = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    title: 'Super Productivity Task Widget',
    frame: false,
    transparent: !IS_MAC,
    backgroundColor: IS_MAC ? (isList ? '#ffffff' : '#00000000') : undefined,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    minWidth: isList ? 260 : 60,
    minHeight: isList ? 140 : 24,
    maxWidth: 700,
    maxHeight: isList ? 900 : 120,
    minimizable: false,
    maximizable: false,
    closable: true, // Ensure window is closable
    hasShadow: IS_MAC && !isList, // Keep the list edge free of the native dark outline.
    autoHideMenuBar: true,
    roundedCorners: IS_MAC, // Mac: rely on OS-native rounded corners
    webPreferences,
  });

  taskWidgetWin.loadFile(join(__dirname, 'task-widget.html'));

  // Re-apply opacity once the page loads. On Windows/Linux opacity is a CSS variable driven
  // by IPC; sends before did-finish-load are dropped. Uses 'on' (not 'once') so a DevTools
  // reload also restores the correct opacity. macOS re-calls setOpacity() idempotently.
  taskWidgetWin.webContents.on('did-finish-load', () => {
    updateTaskWidgetContent();
    updateTaskWidgetOpacity(currentOpacity);
  });

  // Set visible on all workspaces immediately after creation
  taskWidgetWin.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });

  taskWidgetWin.on('closed', () => {
    taskWidgetWin = null;
    // Tie "user-forced visible" to the window's lifetime: once the window is
    // gone the sticky flag has no widget to keep visible, so don't let it
    // linger into a future re-create.
    isUserForcedVisible = false;
  });

  taskWidgetWin.on('ready-to-show', () => {
    if (!taskWidgetWin || taskWidgetWin.isDestroyed()) return;
    // Ensure window stays on all workspaces
    taskWidgetWin.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });

    // Request current task state from main window
    const mainWindow = BrowserWindow.getAllWindows().find((win) => win !== taskWidgetWin);
    if (mainWindow) {
      mainWindow.webContents.send(IPC.REQUEST_CURRENT_TASK_FOR_TASK_WIDGET);
    }
    // Don't show task widget here - it should only show when main window is minimized
  });

  const persistBoundsDebounced = (): void => {
    if (boundsDebounceTimer) clearTimeout(boundsDebounceTimer);
    boundsDebounceTimer = setTimeout(() => {
      if (taskWidgetWin && !taskWidgetWin.isDestroyed()) {
        saveSimpleStore(getBoundsKey(), taskWidgetWin.getBounds());
      }
    }, 300);
  };

  taskWidgetWin.on('resize', persistBoundsDebounced);
  taskWidgetWin.on('move', persistBoundsDebounced);

  // Prevent context menu on right-click to avoid crashes
  taskWidgetWin.webContents.on('context-menu', (e) => {
    e.preventDefault();
  });

  // Prevent any window system menu
  taskWidgetWin.on('system-context-menu', (e) => {
    e.preventDefault();
  });

  // Don't make window click-through initially to allow dragging
  // The renderer process will handle mouse events dynamically

  // Update initial state
  updateTaskWidgetContent();

  // macOS: setOpacity() works immediately. Windows/Linux: IPC send is dropped before the
  // page loads; the did-finish-load handler above re-delivers it reliably.
  updateTaskWidgetOpacity(currentOpacity);

  if (pendingShowAfterCreate) {
    const showInactive = pendingShowAfterCreateInactive;
    pendingShowAfterCreate = false;
    pendingShowAfterCreateInactive = false;
    showTaskWidgetWindow({ inactive: showInactive });
  }
};

const showTaskWidgetWindow = (options: ShowTaskWidgetOptions = {}): void => {
  if (!taskWidgetWin || taskWidgetWin.isDestroyed()) {
    return;
  }

  if (options.inactive) {
    taskWidgetWin.showInactive();
  } else {
    taskWidgetWin.show();
  }
};

export const showTaskWidget = (options: ShowTaskWidgetOptions = {}): void => {
  if (!isTaskWidgetEnabled) {
    return;
  }

  // Recreate task widget if it was accidentally closed
  if (!taskWidgetWin) {
    info('Task widget window was destroyed, recreating');
    pendingShowAfterCreate = true;
    pendingShowAfterCreateInactive = pendingShowAfterCreateInactive || !!options.inactive;
    createTaskWidgetWindow();
    return;
  }

  if (taskWidgetWin.isDestroyed()) {
    return;
  }

  // Only show if not already visible
  if (!taskWidgetWin.isVisible()) {
    info('Showing task widget');
    showTaskWidgetWindow(options);
  } else {
    info('Task widget already visible');
  }
};

export const hideTaskWidget = (): void => {
  if (!taskWidgetWin || !isTaskWidgetEnabled) {
    info(
      'Task widget hide skipped: window=' +
        !!taskWidgetWin +
        ', enabled=' +
        isTaskWidgetEnabled,
    );
    return;
  }

  // Only hide if currently visible
  if (taskWidgetWin.isVisible()) {
    info('Hiding task widget');
    taskWidgetWin.hide();
  } else {
    info('Task widget already hidden');
  }
};

/**
 * Toggles the task widget's visibility. Intended for the global shortcut
 * (`globalToggleTaskWidget`): it only acts when the task widget feature is
 * enabled in settings and never changes that persisted enabled/disabled
 * preference — it just shows or hides the existing widget.
 */
export const toggleTaskWidgetVisibility = (): void => {
  if (!isTaskWidgetEnabled) {
    return;
  }

  if (taskWidgetWin && !taskWidgetWin.isDestroyed() && taskWidgetWin.isVisible()) {
    isUserForcedVisible = false;
    hideTaskWidget();
    return;
  }

  isUserForcedVisible = true;
  showTaskWidget({ inactive: true });
};

const initListeners = (): void => {
  if (listenersRegistered) {
    return;
  }
  listenersRegistered = true;

  ipcMain.removeHandler('task-widget-apply-plan');
  const submissions = new Map<string, Promise<boolean>>();
  const undoReceipts = new Map<
    string,
    {
      id: string;
      before?: import('../shared-with-frontend/task-widget.model').TaskWidgetListItem;
    }
  >();
  ipcMain.removeHandler('task-widget-undo-plan');
  ipcMain.handle('task-widget-undo-plan', async (event, raw: unknown) => {
    if (
      !taskWidgetWin ||
      event.sender !== taskWidgetWin.webContents ||
      event.senderFrame !== taskWidgetWin.webContents.mainFrame ||
      !listData
    )
      return false;
    let signature: string;
    try {
      signature = JSON.stringify(
        validatePlans(
          [raw],
          listData.all.map((t) => t.id),
          (listData.projects || []).map((p) => p.id),
        )[0],
      );
    } catch {
      return false;
    }
    const receipt = undoReceipts.get(signature);
    if (!receipt) return false;
    BrowserWindow.getAllWindows()
      .find((w) => w !== taskWidgetWin)
      ?.webContents.send(IPC.TASK_WIDGET_ACTION, {
        id: null,
        action: 'undo-plan',
        value: signature,
      });
    for (let attempt = 0; attempt < 80; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const current = listData?.all.find((t) => t.id === receipt.id);
      if (
        receipt.before
          ? current &&
            !current.dueDay &&
            !current.dueWithTime &&
            current.estimateMs === receipt.before.estimateMs
          : !current
      ) {
        undoReceipts.delete(signature);
        submissions.delete(signature);
        return true;
      }
    }
    return false;
  });
  ipcMain.handle('task-widget-apply-plan', async (event, raw: unknown) => {
    if (
      !taskWidgetWin ||
      event.sender !== taskWidgetWin.webContents ||
      event.senderFrame !== taskWidgetWin.webContents.mainFrame ||
      !listData
    )
      return false;
    try {
      const [plan] = validatePlans(
        [raw],
        listData.all.map((t) => t.id),
        (listData.projects || []).map((p) => p.id),
      );
      const signature = JSON.stringify(plan);
      if (submissions.has(signature)) return submissions.get(signature);
      const before = listData.all.find((t) => t.id === plan.taskId);
      const ids = new Set(listData.all.map((t) => t.id));
      const result = (async (): Promise<boolean> => {
        BrowserWindow.getAllWindows()
          .find((w) => w !== taskWidgetWin)
          ?.webContents.send(IPC.TASK_WIDGET_ACTION, {
            id: null,
            action: 'apply-plan',
            value: signature,
          });
        for (let attempt = 0; attempt < 80; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          const saved = listData?.all.find(
            (t) =>
              (plan.taskId
                ? t.id === plan.taskId
                : !ids.has(t.id) && t.title === plan.title) &&
              (plan.time
                ? t.dueWithTime === new Date(`${plan.date}T${plan.time}:00`).getTime()
                : plan.date
                  ? t.dueDay === plan.date
                  : true),
          );
          if (saved) {
            undoReceipts.set(signature, { id: saved.id, before });
            return true;
          }
        }
        return false;
      })();
      submissions.set(signature, result);
      return result;
    } catch {
      return false;
    }
  });

  ipcMain.removeHandler('task-widget-suggest');
  let planningBusy = false;
  ipcMain.handle('task-widget-suggest', async (event, request: unknown) => {
    if (
      !taskWidgetWin ||
      event.sender !== taskWidgetWin.webContents ||
      event.senderFrame !== taskWidgetWin.webContents.mainFrame ||
      !listData ||
      planningBusy ||
      !request ||
      typeof request !== 'object'
    )
      return { plans: [], error: 'unavailable' };
    const { text, daily } = request as Record<string, unknown>;
    if (typeof text !== 'string' || text.length > 1000 || typeof daily !== 'boolean')
      return { plans: [], error: 'unavailable' };
    planningBusy = true;
    try {
      return await suggestPlans(app.getPath('userData'), text, daily, listData);
    } finally {
      planningBusy = false;
    }
  });

  ipcMain.on('task-widget-action', (event, payload: unknown) => {
    if (
      !taskWidgetWin ||
      event.sender !== taskWidgetWin.webContents ||
      event.senderFrame !== taskWidgetWin.webContents.mainFrame ||
      displayMode === 'timer' ||
      !payload ||
      typeof payload !== 'object'
    )
      return;
    const { id, action, value } = payload as {
      id?: unknown;
      action?: unknown;
      value?: unknown;
    };
    if (
      typeof action !== 'string' ||
      ![
        'setup',
        'navigate',
        'plan',
        'open',
        'status',
        'important',
        'urgent',
        'project',
        'today',
        'reorder',
      ].includes(action) ||
      (value !== undefined && (typeof value !== 'string' || value.length > 10000))
    )
      return;
    if (
      !(
        (action === 'setup' ||
          (action === 'navigate' &&
            (['today', 'planner', 'schedule'].includes(String(value)) ||
              listData?.projects?.some((project) => project.id === value)))) &&
        id === null
      ) &&
      (typeof id !== 'string' || !listData?.all.some((t) => t.id === id))
    )
      return;
    const main = BrowserWindow.getAllWindows().find((w) => w !== taskWidgetWin);
    main?.webContents.send(IPC.TASK_WIDGET_ACTION, { id, action, value });
    if (['open', 'navigate', 'plan'].includes(action)) {
      main?.restore();
      main?.show();
      main?.focus();
    }
  });

  ipcMain.on('task-widget-write', (event, payload: unknown) => {
    if (
      !taskWidgetWin ||
      event.sender !== taskWidgetWin.webContents ||
      event.senderFrame !== taskWidgetWin.webContents.mainFrame ||
      displayMode === 'timer' ||
      !payload ||
      typeof payload !== 'object'
    )
      return;
    const { id, title, context } = payload as {
      id?: unknown;
      title?: unknown;
      context?: { projectId?: unknown; today?: unknown };
    };
    if (context !== undefined && (!context || typeof context !== 'object')) return;
    const projectId = context?.projectId;
    if (
      projectId !== undefined &&
      (typeof projectId !== 'string' ||
        !listData?.projects?.some((p) => p.id === projectId))
    )
      return;
    if (typeof title !== 'string' || !title.trim() || title.length > 1000) return;
    if (
      id !== null &&
      (typeof id !== 'string' || !listData?.all.some((task) => task.id === id))
    )
      return;
    BrowserWindow.getAllWindows()
      .find((win) => win !== taskWidgetWin)
      ?.webContents.send(IPC.TASK_WIDGET_WRITE, {
        id,
        title: title.trim(),
        today: context?.today === true,
        ...(typeof projectId === 'string' ? { projectId } : {}),
      });
  });

  ipcMain.on('task-widget-complete', (event, id: unknown) => {
    if (
      !taskWidgetWin ||
      event.sender !== taskWidgetWin.webContents ||
      event.senderFrame !== taskWidgetWin.webContents.mainFrame ||
      typeof id !== 'string' ||
      displayMode === 'timer'
    )
      return;
    if (!listData?.all.some((task) => task.id === id)) return;
    const mainWindow = BrowserWindow.getAllWindows().find((win) => win !== taskWidgetWin);
    mainWindow?.webContents.send(IPC.TASK_WIDGET_COMPLETE, id);
  });

  ipcMain.on('task-widget-progress', (event, id: unknown) => {
    if (
      !taskWidgetWin ||
      event.sender !== taskWidgetWin.webContents ||
      event.senderFrame !== taskWidgetWin.webContents.mainFrame ||
      typeof id !== 'string' ||
      displayMode === 'timer' ||
      !listData?.all.some((task) => task.id === id)
    )
      return;
    BrowserWindow.getAllWindows()
      .find((win) => win !== taskWidgetWin)
      ?.webContents.send(IPC.TASK_WIDGET_PROGRESS, id);
  });

  ipcMain.on('task-widget-open-codex', (event, id: unknown) => {
    if (
      !taskWidgetWin ||
      event.sender !== taskWidgetWin.webContents ||
      event.senderFrame !== taskWidgetWin.webContents.mainFrame ||
      typeof id !== 'string' ||
      displayMode === 'timer'
    )
      return;
    const url = listData?.all.find((task) => task.id === id)?.codexThreadUrl;
    if (isCodexThreadLink(url)) {
      void shell.openExternal(url).catch(() => info('Could not open Codex thread link'));
    }
  });

  // Listen for show main window request
  ipcMain.on('task-widget-show-main-window', () => {
    const mainWindow = BrowserWindow.getAllWindows().find((win) => win !== taskWidgetWin);
    if (mainWindow) {
      // Mirror showOrFocus() logic: restore() before show() to handle the case where
      // the window is minimized+hidden (e.g. minimize-to-tray on Linux where
      // event.preventDefault() on 'minimize' has no effect).
      mainWindow.restore();
      mainWindow.show();
      // Opening the app from the widget is an explicit "I'm going to the app"
      // gesture, so clear any sticky user-forced visibility and let the widget
      // follow the normal companion behavior again.
      isUserForcedVisible = false;
      if (!isAlwaysShow) {
        hideTaskWidget();
      }
      setTimeout(() => {
        if (!mainWindow.isDestroyed()) {
          mainWindow.focus();
          if (!mainWindow.webContents.isDestroyed()) {
            mainWindow.webContents.focus();
          }
        }
      }, 60);
    }
  });
};

export const updateTaskWidgetTask = (
  task: TaskCopy | null,
  pomodoroEnabled: boolean,
  pomodoroTime: number,
  focusModeEnabled: boolean,
  focusTime: number,
): void => {
  currentTask = task;
  isPomodoroEnabled = pomodoroEnabled;
  currentPomodoroSessionTime = pomodoroTime;
  isFocusModeEnabled = focusModeEnabled;
  currentFocusSessionTime = focusTime;

  updateTaskWidgetContent();
};

const updateTaskWidgetContent = (): void => {
  if (!taskWidgetWin || !isTaskWidgetEnabled) {
    return;
  }

  let title = '';
  let timeStr = '';
  let mode: 'pomodoro' | 'focus' | 'task' | 'idle' = 'idle';

  if (currentTask && currentTask.title) {
    title = currentTask.title;
    if (title.length > 40) {
      title = title.substring(0, 37) + '...';
    }

    if (isPomodoroEnabled) {
      mode = 'pomodoro';
      timeStr = formatTime(currentPomodoroSessionTime);
    } else if (isFocusModeEnabled) {
      mode = 'focus';
      timeStr = formatTime(currentFocusSessionTime);
    } else if (currentTask.timeEstimate) {
      mode = 'task';
      const remainingTime = Math.max(currentTask.timeEstimate - currentTask.timeSpent, 0);
      timeStr = formatTime(remainingTime);
    } else if (currentTask.timeSpent) {
      mode = 'task';
      timeStr = formatTime(currentTask.timeSpent);
    }
  }

  taskWidgetWin.webContents.send('update-content', {
    title,
    time: timeStr,
    mode,
    list:
      displayMode !== 'timer' && listData
        ? {
            tasks: listData.all,
            projectTasks: listData.projectTasks,
            labels: listData.labels,
            scope: displayMode,
            activeView: listData.activeView,
            projects: listData.projects,
          }
        : undefined,
  });
};

export const updateTaskWidgetAlwaysShow = (alwaysShow: boolean): void => {
  isAlwaysShow = alwaysShow;
};

export const getIsTaskWidgetAlwaysShow = (): boolean => isAlwaysShow;

export const getIsTaskWidgetUserForcedVisible = (): boolean => isUserForcedVisible;

export const updateTaskWidgetOpacity = (opacity: number): void => {
  currentOpacity = opacity;
  if (!taskWidgetWin || taskWidgetWin.isDestroyed()) {
    return;
  }
  const clamped = Math.max(0.1, Math.min(1, opacity / 100));
  if (IS_MAC) {
    // On Mac the window is solid (transparent: false), so opacity is applied
    // at the window level rather than via CSS background alpha.
    taskWidgetWin.setOpacity(clamped);
  } else {
    taskWidgetWin.webContents.send('update-opacity', clamped);
  }
};

// Apply the per-instance task widget settings sent by the renderer.
const applyTaskWidgetSettings = (cfg: TaskWidgetConfig | undefined): void => {
  const isEnabled = !!cfg?.isEnabled;
  const nextMode =
    cfg?.displayMode === 'today' || cfg?.displayMode === 'all'
      ? cfg.displayMode
      : 'timer';
  if (nextMode !== displayMode) {
    destroyTaskWidget();
    displayMode = nextMode;
  }
  updateTaskWidgetEnabled(isEnabled);
  if (isEnabled) {
    updateTaskWidgetOpacity(cfg?.opacity ?? 95);
    updateTaskWidgetAlwaysShow(!!cfg?.isAlwaysShow);
    if (cfg?.isAlwaysShow) showTaskWidget({ inactive: true });
  } else {
    updateTaskWidgetAlwaysShow(false);
  }
};

let taskWidgetSettingsListenerRegistered = false;
export const initTaskWidgetSettingsListener = (): void => {
  if (taskWidgetSettingsListenerRegistered) return;
  taskWidgetSettingsListenerRegistered = true;
  ipcMain.on(IPC.UPDATE_TASK_WIDGET_LIST, (event, data: TaskWidgetListData) => {
    // Only the main app can publish the list, never the widget or child frames.
    const mainWindow = BrowserWindow.getAllWindows().find((win) => win !== taskWidgetWin);
    if (
      !mainWindow ||
      event.sender !== mainWindow.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame
    )
      return;
    listData = data;
    updateTaskWidgetContent();
  });
  ipcMain.on(IPC.UPDATE_TASK_WIDGET_SETTINGS, (_ev, cfg: TaskWidgetConfig) => {
    applyTaskWidgetSettings(cfg);
  });
};

const formatTime = (timeMs: number): string => {
  const totalSeconds = Math.floor(timeMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds
      .toString()
      .padStart(2, '0')}`;
  }
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
};
