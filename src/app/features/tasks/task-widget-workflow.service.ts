import { validatePlans } from '../../../../electron/shared-with-frontend/task-planning';
import { PlannerActions } from '../planner/store/planner.actions';
import { TaskReminderOptionId, Task } from './task.model';
import { DateService } from '../../core/date/date.service';
import { MatDialog } from '@angular/material/dialog';
import { DialogScheduleTaskComponent } from '../planner/dialog-schedule-task/dialog-schedule-task.component';
import { TaskSharedActions } from '../../root-store/meta/task-shared.actions';
import { inject, Injectable } from '@angular/core';
import { Store } from '@ngrx/store';
import { firstValueFrom } from 'rxjs';
import { Router } from '@angular/router';
import { TaskService } from './task.service';
import { ProjectService } from '../project/project.service';
import { TagService } from '../tag/tag.service';
import { IN_PROGRESS_TAG, IMPORTANT_TAG, URGENT_TAG } from '../tag/tag.const';
import { BoardsActions } from '../boards/store/boards.actions';
import { selectAllBoards } from '../boards/store/boards.selectors';
import { selectTodayTaskIds } from '../work-context/store/work-context.selectors';
import { REVIEW_TAG_ID, WAITING_TAG_ID } from './task-activity';
import { T } from '../../t.const';
import { TranslateService } from '@ngx-translate/core';

@Injectable({ providedIn: 'root' })
export class TaskWidgetWorkflowService {
  private _planUndo = new Map<string, { id: string; before?: Task; after: string }>();
  private _tasks = inject(TaskService);
  private _date = inject(DateService);
  private _dialog = inject(MatDialog);
  private _projects = inject(ProjectService);
  private _tags = inject(TagService);
  private _store = inject(Store);
  private _router = inject(Router);
  private _translate = inject(TranslateService);

  async act(id: string | null, action: string, value?: string): Promise<void> {
    if (action === 'undo-plan' && id === null && value) {
      const receipt = this._planUndo.get(value);
      if (!receipt) return;
      const current = await firstValueFrom(this._tasks.getByIdOnce$(receipt.id));
      if (!current || JSON.stringify(current) !== receipt.after) return;
      if (receipt.before) {
        this._store.dispatch(TaskSharedActions.unscheduleTask({ id: current.id }));
        this._tasks.update(current.id, { timeEstimate: receipt.before.timeEstimate });
      } else
        this._tasks.remove(
          await firstValueFrom(this._tasks.getByIdWithSubTaskData$(current.id)),
        );
      this._planUndo.delete(value);
      return;
    }
    if (action === 'apply-plan' && id === null && value) {
      const tasks = await firstValueFrom(this._tasks.allTasks$);
      const projects = await firstValueFrom(this._projects.list$);
      const [plan] = validatePlans(
        [JSON.parse(value)],
        tasks.filter((t) => !t.isDone && !t.parentId).map((t) => t.id),
        projects.map((p) => p.id),
      );
      const due = plan.time
        ? new Date(`${plan.date}T${plan.time}:00`).getTime()
        : undefined;
      if (plan.date && plan.date < this._date.todayStr()) return;
      if (
        due &&
        (due < Date.now() ||
          tasks.some(
            (t) =>
              !t.isDone &&
              t.id !== plan.taskId &&
              t.dueWithTime &&
              due < t.dueWithTime + (t.timeEstimate || 3600000) &&
              due >= t.dueWithTime,
          ))
      )
        return;
      let appliedId = plan.taskId;
      const before = appliedId
        ? await firstValueFrom(this._tasks.getByIdOnce$(appliedId))
        : undefined;
      if (!plan.taskId) {
        appliedId = this._tasks.add(
          plan.title,
          true,
          {
            projectId: plan.projectId || 'INBOX_PROJECT',
            tagIds: [],
            ...(due ? { dueWithTime: due } : plan.date ? { dueDay: plan.date } : {}),
          },
          false,
          true,
        );
      } else {
        const task = await firstValueFrom(
          this._tasks.getByIdWithSubTaskData$(plan.taskId),
        );
        if (task.isDone || task.dueDay || task.dueWithTime) return;
        if (due) this._tasks.scheduleTask(task, due, TaskReminderOptionId.DoNotRemind);
        else if (plan.date)
          this._store.dispatch(PlannerActions.planTaskForDay({ task, day: plan.date }));
      }
      if (appliedId) {
        const after = await firstValueFrom(this._tasks.getByIdOnce$(appliedId));
        this._planUndo.set(value, {
          id: appliedId,
          before,
          after: JSON.stringify(after),
        });
      }
      return;
    }
    if (action === 'setup' && id === null) {
      await this._setup();
      return;
    }
    if (action === 'navigate' && id === null) {
      const routes: Record<string, string[]> = {
        today: ['tag', 'TODAY', 'tasks'],
        INBOX_PROJECT: ['project', 'INBOX_PROJECT', 'tasks'],
        planner: ['planner'],
        schedule: ['schedule'],
      };
      if (value && routes[value]) await this._router.navigate(routes[value]);
      return;
    }
    if (!id) return;
    if (action === 'reorder' && value) {
      const request: unknown = JSON.parse(value);
      if (!request || typeof request !== 'object') return;
      const { ids, scope } = request as { ids?: unknown; scope?: unknown };
      if (
        !Array.isArray(ids) ||
        !ids.every((i) => typeof i === 'string') ||
        ids.length > 500 ||
        new Set(ids).size !== ids.length ||
        !ids.includes(id)
      )
        return;
      const tasks = await firstValueFrom(this._tasks.allTasks$);
      const selected = ids.map((i) => tasks.find((t) => t.id === i));
      if (selected.some((t) => !t || t.isDone || t.parentId)) return;
      const merge = (original: string[]): string[] => {
        const queue = ids.filter((i) => original.includes(i));
        return original.map((i) => (ids.includes(i) ? queue.shift()! : i));
      };
      if (scope === 'today') {
        const today = await firstValueFrom(this._store.select(selectTodayTaskIds));
        if (ids.some((i) => !today.includes(i))) return;
        this._tags.updateTag('TODAY', { taskIds: merge(today) });
      } else {
        const projectId = selected[0]?.projectId;
        if (!projectId || selected.some((t) => t?.projectId !== projectId)) return;
        const project = await firstValueFrom(this._projects.getByIdOnce$(projectId));
        if (project)
          this._projects.update(projectId, { taskIds: merge(project.taskIds) });
      }
      return;
    }
    const task = await firstValueFrom(this._tasks.getByIdOnce$(id));
    if (!task || task.isDone) return;
    if (action === 'plan') {
      this._dialog.open(DialogScheduleTaskComponent, {
        autoFocus: false,
        data: { task: await firstValueFrom(this._tasks.getByIdWithSubTaskData$(id)) },
      });
      return;
    }
    if (action === 'open') {
      await this._router.navigate(['project', task.projectId, 'tasks']);
      this._tasks.setSelectedId(id);
      return;
    }
    if (action === 'project') {
      if (task.parentId || !value) return;
      const projects = await firstValueFrom(this._projects.list$);
      if (!projects.some((p) => p.id === value)) return;
      this._tasks.moveToProject(
        await firstValueFrom(this._tasks.getByIdWithSubTaskData$(id)),
        value,
      );
      return;
    }
    if (action === 'today') {
      const today = await firstValueFrom(this._store.select(selectTodayTaskIds));
      if (today.includes(id))
        this._store.dispatch(TaskSharedActions.unscheduleTask({ id }));
      else this._tasks.scheduleForTodayById(id);
      return;
    }
    let ids = [...task.tagIds];
    if (action === 'status') {
      if (!['pending', 'progress', 'review'].includes(value || '')) return;
      ids = ids.filter(
        (tag) => ![IN_PROGRESS_TAG.id, REVIEW_TAG_ID, 'SP_IN_PROGRESS'].includes(tag),
      );
      if (value === 'progress') ids.push(IN_PROGRESS_TAG.id);
      if (value === 'review') ids.push(REVIEW_TAG_ID);
    } else if (action === 'important' || action === 'urgent') {
      const tag = action === 'important' ? IMPORTANT_TAG.id : URGENT_TAG.id;
      ids = ids.includes(tag) ? ids.filter((i) => i !== tag) : [...ids, tag];
    } else return;
    this._ensureTags();
    this._tasks.updateTags(task, ids);
  }

  private _ensureTags(): void {
    const tags = [
      IN_PROGRESS_TAG,
      IMPORTANT_TAG,
      URGENT_TAG,
      { id: REVIEW_TAG_ID, title: this._translate.instant(T.GCF.TASK_WIDGET.REVIEW) },
      { id: WAITING_TAG_ID, title: this._translate.instant(T.GCF.TASK_WIDGET.WAITING) },
    ];
    for (const tag of tags) {
      if (!this._tags.tags().some((t) => t.id === tag.id)) this._tags.addTag(tag);
    }
  }

  // Explicit migration invoked once by the user's authorized setup, never on hydration.
  private async _setup(): Promise<void> {
    this._ensureTags();
    const projects = await firstValueFrom(this._projects.list$);
    const work = projects.find((p) => p.id === 'A5YPBNVJ4CnFGTqln05L2');
    const waiting = projects.find((p) => p.id === 'iGsREIcpipZCE8iDnTsSj');
    if (!work) return;
    this._projects.update(work.id, { title: '工作' });
    const tasks = await firstValueFrom(this._tasks.allTasks$);
    for (const original of tasks) {
      const task = await firstValueFrom(this._tasks.getByIdOnce$(original.id));
      let ids = task.tagIds.map((id) =>
        id === 'SP_IN_PROGRESS' ? IN_PROGRESS_TAG.id : id,
      );
      if (!task.isDone && task.projectId === waiting?.id) ids.push(WAITING_TAG_ID);
      ids = [...new Set(ids)];
      if (ids.join() !== task.tagIds.join()) this._tasks.updateTags(task, ids);
      if (
        !task.isDone &&
        !task.parentId &&
        [waiting?.id, 'INBOX_PROJECT'].includes(task.projectId)
      ) {
        this._tasks.moveToProject(
          await firstValueFrom(this._tasks.getByIdWithSubTaskData$(task.id)),
          work.id,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    // Retain the old project and any historical tasks, but remove the confusing menu entry.
    if (waiting) this._projects.update(waiting.id, { isHiddenFromMenu: true });
    const current = await firstValueFrom(this._tasks.allTasks$);
    if (
      !current.some((t) => t.tagIds.includes('SP_IN_PROGRESS')) &&
      this._tags.tags().some((t) => t.id === 'SP_IN_PROGRESS')
    ) {
      this._tags.removeTag('SP_IN_PROGRESS');
    }
    const boards = await firstValueFrom(this._store.select(selectAllBoards));
    const board = boards.find((b) => b.id === 'KANBAN_DEFAULT');
    if (board) {
      const panels = board.panels
        .filter((p) => p.id !== 'MATTO_REVIEW_PANEL')
        .map((p) => {
          if (p.id === 'TODO' || p.id === 'IN_PROGRESS') {
            return {
              ...p,
              excludedTagIds: [...new Set([...p.excludedTagIds, REVIEW_TAG_ID])],
            };
          }
          return p;
        });
      const template = panels.find((p) => p.id === 'IN_PROGRESS');
      if (template) {
        panels.splice(
          Math.max(
            0,
            panels.findIndex((p) => p.id === 'DONE'),
          ),
          0,
          {
            ...template,
            id: 'MATTO_REVIEW_PANEL',
            title: this._translate.instant(T.GCF.TASK_WIDGET.REVIEW),
            includedTagIds: [REVIEW_TAG_ID],
            excludedTagIds: [IN_PROGRESS_TAG.id],
            taskIds: [],
          },
        );
        this._store.dispatch(
          BoardsActions.updateBoard({
            id: board.id,
            updates: { cols: 4, panels },
          }),
        );
      }
    }
    // Eisenhower board is intentionally untouched: importance and urgency stay independent.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
