import { DateService } from '../../core/date/date.service';
import { MatDialog } from '@angular/material/dialog';
import { TaskSharedActions } from '../../root-store/meta/task-shared.actions';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { Store } from '@ngrx/store';
import { TranslateService } from '@ngx-translate/core';
import { Observable, of } from 'rxjs';
import { TaskWidgetWorkflowService } from './task-widget-workflow.service';
import { TaskService } from './task.service';
import { ProjectService } from '../project/project.service';
import { TagService } from '../tag/tag.service';
import { DEFAULT_TASK } from './task.model';

describe('TaskWidgetWorkflowService', () => {
  let service: TaskWidgetWorkflowService;
  let tasks: {
    getByIdOnce$: jasmine.Spy;
    allTasks$: Observable<unknown>;
    updateTags: jasmine.Spy;
    add: jasmine.Spy;
    getByIdWithSubTaskData$: jasmine.Spy;
    update: jasmine.Spy;
  };
  let projects: {
    getByIdOnce$: jasmine.Spy;
    update: jasmine.Spy;
    list$: Observable<unknown>;
  };
  const task = {
    ...DEFAULT_TASK,
    id: 'a',
    projectId: 'work',
    tagIds: ['EM_IMPORTANT', 'MATTO_REVIEW'],
  };
  beforeEach(() => {
    tasks = {
      getByIdOnce$: jasmine.createSpy().and.returnValue(of(task)),
      allTasks$: of([
        task,
        { ...task, id: 'b' },
        { ...task, id: 'other', projectId: 'other' },
      ]),
      updateTags: jasmine.createSpy(),
      add: jasmine.createSpy().and.returnValue('new'),
      update: jasmine.createSpy(),
      getByIdWithSubTaskData$: jasmine.createSpy().and.returnValue(of(task)),
    };
    projects = {
      list$: of([{ id: 'work' }, { id: 'INBOX_PROJECT' }]),
      getByIdOnce$: jasmine
        .createSpy()
        .and.returnValue(of({ id: 'work', taskIds: ['a', 'hidden', 'b'] })),
      update: jasmine.createSpy(),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: DateService, useValue: { todayStr: () => '2026-09-14' } },
        { provide: TaskService, useValue: tasks },
        { provide: ProjectService, useValue: projects },
        {
          provide: TagService,
          useValue: { tags: () => [], addTag: jasmine.createSpy() },
        },
        {
          provide: Store,
          useValue: { select: () => of(['a']), dispatch: jasmine.createSpy() },
        },
        {
          provide: Router,
          useValue: { navigate: jasmine.createSpy().and.resolveTo(true) },
        },
        { provide: MatDialog, useValue: { open: jasmine.createSpy() } },
        { provide: TranslateService, useValue: { instant: (key: string) => key } },
      ],
    });
    service = TestBed.inject(TaskWidgetWorkflowService);
  });
  it('applies an accepted capture to native planning fields without short syntax', async () => {
    await service.act(
      null,
      'apply-plan',
      JSON.stringify({
        title: 'Review @tomorrow',
        date: '2026-09-15',
        durationMinutes: 30,
        reason: 'User accepted',
      }),
    );
    expect(tasks.add).toHaveBeenCalledWith(
      'Review @tomorrow',
      true,
      jasmine.objectContaining({
        projectId: 'INBOX_PROJECT',
        dueDay: '2026-09-15',
        tagIds: [],
      }),
      false,
      true,
    );
  });
  it('rejects stale suggestions for a task now scheduled elsewhere', async () => {
    tasks.getByIdWithSubTaskData$.and.returnValue(of({ ...task, dueDay: '2026-09-16' }));
    await service.act(
      null,
      'apply-plan',
      JSON.stringify({
        taskId: 'a',
        title: 'Review',
        date: '2026-09-15',
        durationMinutes: 30,
        reason: 'User accepted',
      }),
    );
    expect(tasks.update).not.toHaveBeenCalled();
    expect(tasks.add).not.toHaveBeenCalled();
  });
  it('undo restores an unchanged existing task estimate and unschedules it', async () => {
    const plan = JSON.stringify({
      taskId: 'a',
      title: 'Review',
      date: '2026-09-15',
      durationMinutes: 30,
      reason: 'Accepted',
    });
    const after = { ...task, dueDay: '2026-09-15', timeEstimate: 1800000 };
    tasks.getByIdOnce$.and.returnValues(of(task), of(after), of(after));
    await service.act(null, 'apply-plan', plan);
    tasks.update.calls.reset();
    await service.act(null, 'undo-plan', plan);
    expect(tasks.update).toHaveBeenCalledWith('a', { timeEstimate: task.timeEstimate });
    expect(TestBed.inject(Store).dispatch).toHaveBeenCalledWith(
      TaskSharedActions.unscheduleTask({ id: 'a' }),
    );
  });
  it('undo refuses to overwrite subsequent task edits', async () => {
    const plan = JSON.stringify({
      taskId: 'a',
      title: 'Review',
      date: '2026-09-15',
      durationMinutes: 30,
      reason: 'Accepted',
    });
    const after = { ...task, dueDay: '2026-09-15', timeEstimate: 1800000 };
    tasks.getByIdOnce$.and.returnValues(
      of(task),
      of(after),
      of({ ...after, title: 'Edited' }),
    );
    await service.act(null, 'apply-plan', plan);
    tasks.update.calls.reset();
    await service.act(null, 'undo-plan', plan);
    expect(tasks.update).not.toHaveBeenCalled();
  });
  it('opens only supported planning destinations without altering tasks', async () => {
    const router = TestBed.inject(Router);
    await service.act(null, 'navigate', 'today');
    expect(router.navigate).toHaveBeenCalledWith(['tag', 'TODAY', 'tasks']);
    await service.act(null, 'navigate', 'INBOX_PROJECT');
    expect(router.navigate).toHaveBeenCalledWith(['project', 'INBOX_PROJECT', 'tasks']);
    await service.act(null, 'navigate', 'work');
    expect(router.navigate).toHaveBeenCalledWith(['project', 'work', 'tasks']);
    await service.act(null, 'navigate', 'planner');
    expect(router.navigate).toHaveBeenCalledWith(['planner']);
    await service.act(null, 'navigate', 'schedule');
    expect(router.navigate).toHaveBeenCalledWith(['schedule']);
    await service.act(null, 'navigate', 'https://example.com');
    expect(router.navigate).toHaveBeenCalledTimes(5);
    expect(tasks.updateTags).not.toHaveBeenCalled();
  });
  it('changes status exclusively while preserving quadrant membership', async () => {
    await service.act('a', 'status', 'progress');
    expect(tasks.updateTags).toHaveBeenCalledWith(task, [
      'EM_IMPORTANT',
      'KANBAN_IN_PROGRESS',
    ]);
  });
  it('toggles urgency without changing review status', async () => {
    await service.act('a', 'urgent');
    expect(tasks.updateTags).toHaveBeenCalledWith(task, [
      'EM_IMPORTANT',
      'MATTO_REVIEW',
      'EM_URGENT',
    ]);
  });
  it('reorders native project tasks without moving hidden items', async () => {
    await service.act('a', 'reorder', JSON.stringify({ ids: ['b', 'a'], scope: 'work' }));
    expect(projects.update).toHaveBeenCalledWith('work', {
      taskIds: ['b', 'hidden', 'a'],
    });
  });
  it('rejects duplicate IDs and mixed project reorders', async () => {
    await service.act('a', 'reorder', JSON.stringify({ ids: ['a', 'a'], scope: 'all' }));
    await service.act(
      'a',
      'reorder',
      JSON.stringify({ ids: ['other', 'a'], scope: 'all' }),
    );
    expect(projects.update).not.toHaveBeenCalled();
  });
  it('removes today scheduling through the native unschedule action', async () => {
    await service.act('a', 'today');
    expect(TestBed.inject(Store).dispatch).toHaveBeenCalledWith(
      TaskSharedActions.unscheduleTask({ id: 'a' }),
    );
  });
});
