import { ProjectService } from '../../project/project.service';
import { TaskWidgetWorkflowService } from '../task-widget-workflow.service';
import { IMPORTANT_TAG, URGENT_TAG } from '../../tag/tag.const';
import { REVIEW_TAG_ID } from '../task-activity';
import { DateService } from '../../../core/date/date.service';
import { INBOX_PROJECT } from '../../project/project.const';
import {
  getCodexThreadLink,
  getCodexAssociation,
} from '../../../../../electron/shared-with-frontend/codex-thread-link';
import { inject, Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { createEffect, ofType } from '@ngrx/effects';
import { setCurrentTask, unsetCurrentTask } from './task.actions';
import { combineLatest } from 'rxjs';
import { TranslateService } from '@ngx-translate/core';
import { T } from '../../../t.const';
import { selectAllTasks } from './task.selectors';
import { select, Store } from '@ngrx/store';
import {
  filter,
  map,
  distinctUntilChanged,
  startWith,
  take,
  tap,
  throttleTime,
  withLatestFrom,
} from 'rxjs/operators';
import { selectCurrentTask, selectTaskEntities } from './task.selectors';
import { selectTodayTaskIds } from '../../work-context/store/work-context.selectors';
import { GlobalConfigService } from '../../config/global-config.service';
import { selectIsOverlayShown } from '../../focus-mode/store/focus-mode.selectors';
import { TimeTrackingActions } from '../../time-tracking/store/time-tracking.actions';
import { FocusModeService } from '../../focus-mode/focus-mode.service';
import {
  cancelFocusSession,
  completeFocusSession,
  hideFocusOverlay,
  pauseFocusSession,
  showFocusOverlay,
  startFocusSession,
  tick,
  unPauseFocusSession,
} from '../../focus-mode/store/focus-mode.actions';
import { IPC } from '../../../../../electron/shared-with-frontend/ipc-events.const';
import { TaskService } from '../task.service';
import { TaskSharedActions } from '../../../root-store/meta/task-shared.actions';
import { IN_PROGRESS_TAG_ID, sumTaskActivity } from '../task-activity';
import { TaskWidgetListItem } from '../../../../../electron/shared-with-frontend/task-widget.model';
import { LOCAL_ACTIONS } from '../../../util/local-actions.token';

// TODO send message to electron when current task changes here

@Injectable()
export class TaskElectronEffects {
  private _dateService = inject(DateService);
  private _projects = inject(ProjectService);
  private _router = inject(Router);
  private _workflow = inject(TaskWidgetWorkflowService);
  private _translate = inject(TranslateService);
  private _actions$ = inject(LOCAL_ACTIONS);
  private _store$ = inject<Store<any>>(Store);
  private _configService = inject(GlobalConfigService);
  private _focusModeService = inject(FocusModeService);
  private _taskService = inject(TaskService);

  // -----------------------------------------------------------------------------------
  // NOTE: IS_ELECTRON checks not necessary, since we check before importing this module
  // -----------------------------------------------------------------------------------

  constructor() {
    window.ea.on(IPC.TASK_WIDGET_ACTION, (payload) => {
      if (!payload || typeof payload !== 'object') return;
      const { id, action, value } = payload as {
        id: string | null;
        action: string;
        value?: string;
      };
      void this._workflow.act(id, action, value).catch(() => {
        // Keep the application authoritative when a task disappears during an action.
      });
    });

    /**
     * SYNC-SAFE: This IPC listener is safe during sync/hydration because:
     * - Read-only operation - only reads current state and sends to Electron
     * - No store mutations or action dispatches
     * - Responds to explicit IPC request, not store-change driven
     * - take(1) ensures single response per request
     */
    window.ea.on(IPC.REQUEST_CURRENT_TASK_FOR_TASK_WIDGET, () => {
      this._store$
        .pipe(
          select(selectCurrentTask),
          withLatestFrom(
            this._store$.pipe(select(selectIsOverlayShown)),
            this._focusModeService.currentSessionTime$,
          ),
          // Only take the first value and complete
          take(1),
        )
        .subscribe(([current, isFocusModeEnabled, currentFocusSessionTime]) => {
          window.ea.updateCurrentTask(
            current,
            false, // isPomodoroEnabled - legacy, always false
            0, // currentPomodoroSessionTime - legacy, always 0
            isFocusModeEnabled,
            currentFocusSessionTime,
            this._focusModeService.mode(),
          );
        });
    });

    window.ea.on(IPC.TASK_WIDGET_WRITE, (payload) => {
      if (!payload || typeof payload !== 'object') return;
      const { id, title, today, projectId } = payload as {
        id?: unknown;
        title?: unknown;
        today?: unknown;
        projectId?: unknown;
      };
      if (typeof title !== 'string' || !title.trim() || title.length > 1000) return;
      if (id === null) {
        this._taskService.add(
          title.trim(),
          today !== true,
          {
            projectId:
              typeof projectId === 'string' &&
              this._projects.list().some((p) => p.id === projectId)
                ? projectId
                : this._projects.list().find((p) => p.title === '工作')?.id ||
                  INBOX_PROJECT.id,
            tagIds: [],
            dueDay: today === true ? this._dateService.todayStr() : undefined,
          },
          false,
          true,
        );
      } else if (typeof id === 'string') {
        this._store$
          .select(selectTaskEntities)
          .pipe(take(1))
          .subscribe((entities) => {
            if (entities[id] && !entities[id].isDone)
              this._taskService.update(id, { title: title.trim() });
          });
      }
    });

    window.ea.on(IPC.TASK_WIDGET_COMPLETE, (id) => {
      if (typeof id !== 'string') return;
      this._store$
        .select(selectTaskEntities)
        .pipe(take(1))
        .subscribe((entities) => {
          if (entities[id] && !entities[id].isDone) this._taskService.setDone(id);
        });
    });

    window.ea.on(IPC.TASK_WIDGET_PROGRESS, (id) => {
      if (typeof id !== 'string') return;
      this._store$
        .select(selectTaskEntities)
        .pipe(take(1))
        .subscribe((entities) => {
          const task = entities[id];
          if (!task || task.isDone || task.parentId) return;
          void this._workflow.act(
            id,
            'status',
            task.tagIds.includes(IN_PROGRESS_TAG_ID) ? 'pending' : 'progress',
          );
        });
    });

    window.ea.onSwitchTask((taskId) => {
      this._taskService.setCurrentId(taskId);
    });
  }

  // Read-only projection: remote changes refresh the widget without dispatching writes.
  syncTaskWidgetList$ = createEffect(
    () =>
      combineLatest([
        this._store$.select(selectAllTasks),
        this._store$.select(selectTodayTaskIds),
        this._projects.list$,
        this._router.events.pipe(
          map(() => this._router.url),
          startWith(this._router.url),
          distinctUntilChanged(),
        ),
        this._translate.onLangChange.pipe(startWith(null)),
      ]).pipe(
        map(([tasks, todayIds, projects, route]) => {
          const segments = route.split('?')[0].split('/').filter(Boolean);
          const activeView =
            segments[0] === 'tag' && segments[1] === 'TODAY'
              ? 'today'
              : segments[0] === 'project' &&
                  projects.some((project) => project.id === segments[1])
                ? segments[1]
                : undefined;
          const openTasks = tasks.filter((task) => !task.isDone);
          const item = (task: (typeof tasks)[number]): TaskWidgetListItem => {
            let activity = { humanMs: 0, aiMs: 0 };
            try {
              activity = sumTaskActivity(task.notes);
            } catch {
              /* Malformed notes never prevent displaying a task. */
            }
            const association = getCodexAssociation(task.notes);
            const translate = (key: string): string =>
              this._translate.instant(`GCF.TASK_WIDGET.${key}`);
            const stale =
              association && Date.now() - Date.parse(association.checkedAt) > 15 * 60000;
            const status = association
              ? stale
                ? 'STALE'
                : association.status.toUpperCase()
              : getCodexThreadLink(task.notes)
                ? 'UNVERIFIED'
                : 'UNLINKED';
            return {
              associationLabel: translate(`ASSOCIATION_${status}`),
              associationDetail: association
                ? `${translate('COLLECTION_SINCE')}: ${new Date(association.since).toLocaleString()} · ${translate('COLLECTION_CHECKED')}: ${new Date(association.checkedAt).toLocaleString()} · ${association.threadCount} ${translate('ASSOCIATED_THREADS')} · ${translate(association.humanStatus === 'collected' ? 'HUMAN_COLLECTED' : 'HUMAN_PRESERVED')}`
                : translate('ASSOCIATION_UNVERIFIED'),
              humanCoverageIncomplete:
                !association || association.humanStatus !== 'collected' || !!stale,
              aiCoverageIncomplete:
                !association || association.status !== 'collected' || !!stale,
              dueDay: task.dueDay || undefined,
              dueWithTime: task.dueWithTime || undefined,
              estimateMs: task.timeEstimate,
              scheduleLabel: task.dueWithTime
                ? new Date(task.dueWithTime).toLocaleString()
                : task.dueDay || '',
              id: task.id,
              title: task.title,
              codexThreadUrl: getCodexThreadLink(task.notes),
              inProgress: task.tagIds.includes(IN_PROGRESS_TAG_ID),
              humanMs: activity.humanMs,
              aiMs: activity.aiMs,
              trackedMs: task.timeSpent,
              review: task.tagIds.includes(REVIEW_TAG_ID),
              today: todayIds.includes(task.id),
              todayRank: todayIds.indexOf(task.id),
              important: task.tagIds.includes(IMPORTANT_TAG.id),
              urgent: task.tagIds.includes(URGENT_TAG.id),
              projectId: task.projectId,
              projectTitle: projects.find((p) => p.id === task.projectId)?.title,
            };
          };
          const entities = new Map(openTasks.map((task) => [task.id, task]));
          return {
            activeView,
            projects: projects
              .filter((p) => !p.isHiddenFromMenu)
              .map(({ id, title }) => ({ id, title })),
            today: todayIds.flatMap((id) => {
              const task = entities.get(id);
              return task ? [item(task)] : [];
            }),
            all: projects.flatMap((project) =>
              [...project.taskIds, ...project.backlogTaskIds].flatMap((id) => {
                const task = entities.get(id);
                return task && !task.parentId ? [item(task)] : [];
              }),
            ),
            labels: {
              aiReady: this._translate.instant('GCF.TASK_WIDGET.AI_READY'),
              aiAdopt: this._translate.instant('GCF.TASK_WIDGET.AI_ADOPT'),
              aiUndo: this._translate.instant('GCF.TASK_WIDGET.AI_UNDO'),
              aiUndone: this._translate.instant('GCF.TASK_WIDGET.AI_UNDONE'),
              aiChanged: this._translate.instant('GCF.TASK_WIDGET.AI_CHANGED'),
              aiAdopted: this._translate.instant('GCF.TASK_WIDGET.AI_ADOPTED'),
              aiCapture: this._translate.instant('GCF.TASK_WIDGET.AI_CAPTURE'),
              aiToday: this._translate.instant('GCF.TASK_WIDGET.AI_TODAY'),
              aiThinking: this._translate.instant('GCF.TASK_WIDGET.AI_THINKING'),
              aiAccept: this._translate.instant('GCF.TASK_WIDGET.AI_ACCEPT'),
              aiSaveOnly: this._translate.instant('GCF.TASK_WIDGET.AI_SAVE_ONLY'),
              aiError: this._translate.instant('GCF.TASK_WIDGET.AI_ERROR'),
              aiBudget: this._translate.instant('GCF.TASK_WIDGET.AI_BUDGET'),
              aiMinutes: this._translate.instant('GCF.TASK_WIDGET.AI_MINUTES'),
              aiEmpty: this._translate.instant('GCF.TASK_WIDGET.AI_EMPTY'),
              aiSuggestion: this._translate.instant('GCF.TASK_WIDGET.AI_SUGGESTION'),
              inbox: this._translate.instant('GCF.TASK_WIDGET.INBOX'),
              planner: this._translate.instant('GCF.TASK_WIDGET.PLANNER'),
              schedule: this._translate.instant('GCF.TASK_WIDGET.SCHEDULE'),
              planTask: this._translate.instant('GCF.TASK_WIDGET.PLAN_TASK'),
              addToday: this._translate.instant('GCF.TASK_WIDGET.ADD_TODAY'),
              removeToday: this._translate.instant('GCF.TASK_WIDGET.REMOVE_TODAY'),
              review: this._translate.instant(T.GCF.TASK_WIDGET.REVIEW),
              focus: this._translate.instant(T.GCF.TASK_WIDGET.FOCUS),
              important: this._translate.instant(T.GCF.TASK_WIDGET.IMPORTANT),
              urgent: this._translate.instant(T.GCF.TASK_WIDGET.URGENT),
              project: this._translate.instant(T.GCF.TASK_WIDGET.PROJECT),
              detail: this._translate.instant(T.GCF.TASK_WIDGET.DETAIL),
              add: this._translate.instant(T.GCF.TASK_WIDGET.ADD_TASK),
              edit: this._translate.instant(T.GCF.TASK_WIDGET.EDIT_TITLE),
              openCodex: this._translate.instant(T.GCF.TASK_WIDGET.OPEN_CODEX),
              progress: this._translate.instant(T.GCF.TASK_WIDGET.IN_PROGRESS),
              pending: this._translate.instant(T.GCF.TASK_WIDGET.PENDING),
              human: this._translate.instant(T.GCF.TASK_WIDGET.HUMAN_TIME),
              ai: this._translate.instant(T.GCF.TASK_WIDGET.AI_TIME),
              tracked: this._translate.instant(T.GCF.TASK_WIDGET.TRACKED_TIME),
              today: this._translate.instant(T.GCF.TASK_WIDGET.MODE_TODAY),
              all: this._translate.instant(T.GCF.TASK_WIDGET.MODE_ALL),
              view: this._translate.instant(T.GCF.TASK_WIDGET.DISPLAY_MODE),
              empty: this._translate.instant(T.GCF.TASK_WIDGET.EMPTY_LIST),
              complete: this._translate.instant(T.GCF.TASK_WIDGET.COMPLETE_TASK),
              open: this._translate.instant(T.GCF.TASK_WIDGET.OPEN_APP),
            },
          };
        }),
        distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b)),
        tap((data) => window.ea.updateTaskWidgetList(data)),
      ),
    { dispatch: false },
  );

  syncTodayTasksToElectron$ = createEffect(
    () =>
      this._store$.pipe(
        select(selectTodayTaskIds),
        withLatestFrom(this._store$.pipe(select(selectTaskEntities))),
        tap(([todayTaskIds, taskEntities]) => {
          const tasks = todayTaskIds
            .map((id) => taskEntities[id])
            .filter((t) => !!t && !t.isDone)
            .map((t) => ({
              id: t!.id,
              title: t!.title,
              timeEstimate: t!.timeEstimate,
              timeSpent: t!.timeSpent,
            }));
          window.ea.updateTodayTasks(tasks);
        }),
      ),
    { dispatch: false },
  );

  taskChangeElectron$ = createEffect(
    () =>
      this._actions$.pipe(
        ofType(
          setCurrentTask,
          unsetCurrentTask,
          TimeTrackingActions.addTimeSpent,
          showFocusOverlay,
          hideFocusOverlay,
          startFocusSession,
          cancelFocusSession,
          pauseFocusSession,
          unPauseFocusSession,
          completeFocusSession,
          // Keep tray time in sync during focus-mode breaks and focus sessions
          // without an active task (addTimeSpent is gated on currentTask.id).
          tick,
        ),
        // addTimeSpent and tick both fire every 1s during an active-task focus
        // session (same shared globalInterval source), so collapse them into a
        // single IPC/sec. Leading+trailing preserves immediate feedback for the
        // non-tick actions (setCurrentTask, startFocusSession, ...).
        throttleTime(500, undefined, { leading: true, trailing: true }),
        withLatestFrom(
          this._store$.pipe(select(selectCurrentTask)),
          this._store$.pipe(select(selectIsOverlayShown)),
          this._focusModeService.currentSessionTime$.pipe(startWith(0)),
        ),
        tap(([action, current, isFocusModeEnabled, currentFocusSessionTime]) => {
          window.ea.updateCurrentTask(
            current,
            false, // isPomodoroEnabled - legacy, always false
            0, // currentPomodoroSessionTime - legacy, always 0
            isFocusModeEnabled,
            currentFocusSessionTime,
            this._focusModeService.mode(),
          );
        }),
      ),
    { dispatch: false },
  );

  setTaskBarNoProgress$ = createEffect(
    () =>
      this._actions$.pipe(
        ofType(setCurrentTask),
        tap(({ id }) => {
          if (!id) {
            window.ea.setProgressBar({
              progress: -1,
              progressBarMode: 'none',
            });
          }
        }),
      ),
    { dispatch: false },
  );

  clearTaskBarOnTaskDone$ = createEffect(
    () =>
      this._actions$.pipe(
        ofType(TaskSharedActions.updateTask),
        tap(({ task }) => {
          if (task.changes.isDone) {
            window.ea.setProgressBar({
              progress: -1,
              progressBarMode: 'none',
            });
          }
        }),
      ),
    { dispatch: false },
  );

  setTaskBarProgress$ = createEffect(
    () =>
      this._actions$.pipe(
        ofType(TimeTrackingActions.addTimeSpent),
        // The OS taskbar progress bar moves imperceptibly per second; throttling
        // collapses 1 IPC/sec into ~1 IPC/3s. Leading+trailing keeps the first
        // tick after start instant and the final value at the end of a window.
        throttleTime(3000, undefined, { leading: true, trailing: true }),
        withLatestFrom(this._store$.select(selectIsOverlayShown)),
        // Don't show progress bar when focus session is running
        filter(([a, isFocusSessionRunning]) => !isFocusSessionRunning),
        tap(([{ task }]) => {
          const progress = task.timeSpent / task.timeEstimate;
          window.ea.setProgressBar({
            progress,
            progressBarMode: 'normal',
          });
        }),
      ),
    { dispatch: false },
  );
}
