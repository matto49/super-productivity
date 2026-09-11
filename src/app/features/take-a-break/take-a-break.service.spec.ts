import { TestBed } from '@angular/core/testing';
import { BehaviorSubject, of, Subject } from 'rxjs';
import { TakeABreakService } from './take-a-break.service';
import { TaskService } from '../tasks/task.service';
import { GlobalTrackingIntervalService } from '../../core/global-tracking-interval/global-tracking-interval.service';
import { GlobalConfigService } from '../config/global-config.service';
import { NotifyService } from '../../core/notify/notify.service';
import { BannerService } from '../../core/banner/banner.service';
import { UiHelperService } from '../ui-helper/ui-helper.service';
import { SnackService } from '../../core/snack/snack.service';
import { BannerId } from '../../core/banner/banner.model';
import { Tick } from '../../core/global-tracking-interval/tick.model';
import { T } from '../../t.const';

describe('TakeABreakService', () => {
  let service: TakeABreakService;
  let taskService: jasmine.SpyObj<TaskService>;
  let snackService: jasmine.SpyObj<SnackService>;
  let bannerService: jasmine.SpyObj<BannerService>;
  let tick$: Subject<Tick>;
  let currentTaskId$: BehaviorSubject<string | null>;

  const configure = (isTakeABreakEnabled = true): void => {
    tick$ = new Subject<Tick>();
    taskService = jasmine.createSpyObj<TaskService>('TaskService', [
      'pauseCurrent',
      'currentTaskId',
    ]);
    // `currentTaskId$` is read as a property during construction. It must be a
    // live subject, not `of(null)`: `of` completes, which makes it impossible to
    // exercise the untracked-stretch reset re-arming after a task is tracked.
    currentTaskId$ = new BehaviorSubject<string | null>(null);
    (taskService as unknown as { currentTaskId$: unknown }).currentTaskId$ =
      currentTaskId$;
    taskService.currentTaskId.and.returnValue(null);

    snackService = jasmine.createSpyObj<SnackService>('SnackService', ['open']);
    bannerService = jasmine.createSpyObj<BannerService>('BannerService', [
      'open',
      'dismiss',
    ]);

    TestBed.configureTestingModule({
      providers: [
        TakeABreakService,
        { provide: TaskService, useValue: taskService },
        { provide: SnackService, useValue: snackService },
        { provide: BannerService, useValue: bannerService },
        { provide: GlobalTrackingIntervalService, useValue: { tick$: tick$ } },
        {
          provide: GlobalConfigService,
          useValue: {
            cfg$: of({
              takeABreak: { isTakeABreakEnabled },
              // idle tracking on is the shipped default, and it used to be the
              // configuration in which the automatic break-timer reset was dead
              idle: { isEnableIdleTimeTracking: true },
            }),
            takeABreak$: of({ isTakeABreakEnabled }),
            idle$: of({ isEnableIdleTimeTracking: true }),
            sound$: of({ breakReminderSound: null, volume: 0 }),
          },
        },
        { provide: NotifyService, useValue: { notifyDesktop: () => undefined } },
        {
          provide: UiHelperService,
          useValue: { focusAppAfterNotification: () => undefined },
        },
      ],
    });

    service = TestBed.inject(TakeABreakService);
  };

  beforeEach(() => configure());

  describe('reminder teardown', () => {
    it('tears down only once while nothing is being tracked', () => {
      const emitted: number[] = [];
      const sub = service.timeWorkingWithoutABreak$.subscribe((v) => emitted.push(v));

      // past BREAK_TRIGGER_DURATION, then many further ticks
      for (let i = 0; i < 15; i++) {
        tick$.next({ duration: 60000, date: '2026-07-28', timestamp: 0 });
      }

      expect(emitted[emitted.length - 1]).toBe(0);
      expect(bannerService.dismiss).toHaveBeenCalledTimes(1);
      sub.unsubscribe();
    });

    // The edge trigger must re-arm, or the automatic reset degrades to
    // once-per-session — the same silent-death shape as the #9305 bug itself.
    it('re-arms after a task is tracked and stopped again', () => {
      const sub = service.timeWorkingWithoutABreak$.subscribe();
      const untrackedStretch = (): void => {
        for (let i = 0; i < 15; i++) {
          tick$.next({ duration: 60000, date: '2026-07-28', timestamp: 0 });
        }
      };

      untrackedStretch();
      expect(bannerService.dismiss).toHaveBeenCalledTimes(1);

      currentTaskId$.next('task-1');
      currentTaskId$.next(null);
      untrackedStretch();

      expect(bannerService.dismiss).toHaveBeenCalledTimes(2);
      sub.unsubscribe();
    });

    // The teardown is deliberately NOT gated on isTakeABreakEnabled: gating it
    // means toggling the feature off mid-session strands _triggerLockScreenCounter$
    // and _triggerFullscreenBlocker$ at `true`, and because both are
    // distinctUntilChanged() the later next(true) is swallowed — so re-enabling
    // can never re-arm them. Dismissing a banner that cannot be open is a no-op.
    it('still tears the reminder down when the feature is disabled', () => {
      TestBed.resetTestingModule();
      configure(false);

      const sub = service.timeWorkingWithoutABreak$.subscribe();
      service.resetTimer();

      expect(bannerService.dismiss).toHaveBeenCalledWith(BannerId.TakeABreak);
      sub.unsubscribe();
    });
  });

  describe('counter arithmetic', () => {
    const trackTask = (): void => {
      taskService.currentTaskId.and.returnValue('task-1');
      currentTaskId$.next('task-1');
    };

    // Only _triggerReset$ may zero the counter. The seedless scan treats any
    // value <= 0 as a reset, and a 0 is a normal Android event: the focus-mode
    // effects pass `cap = Math.max(0, timer.duration - timer.elapsed)` to
    // triggerWakeUpTick, which is exactly 0 once a session reaches its duration.
    // Zeroing through the tick branch skips the teardown, so the banner would
    // keep claiming hours of work over a counter reading 0.
    it('ignores a zero-duration tick rather than zeroing the counter', () => {
      const twoHours = 2 * 60 * 60000;
      const oneMinute = 60000;
      trackTask();
      const emitted: number[] = [];
      const sub = service.timeWorkingWithoutABreak$.subscribe((v) => emitted.push(v));
      service.otherNoBreakTIme$.next(twoHours);

      tick$.next({ duration: 0, date: '2026-07-28', timestamp: 0 });

      expect(emitted[emitted.length - 1]).toBe(twoHours);
      expect(bannerService.dismiss).not.toHaveBeenCalled();

      // positive control: a real tick still accumulates, so the assertion above
      // is not passing merely because the tick branch is wired up wrong
      tick$.next({ duration: oneMinute, date: '2026-07-28', timestamp: 0 });
      expect(emitted[emitted.length - 1]).toBe(twoHours + oneMinute);
      sub.unsubscribe();
    });

    // consumeCurrentTick() is unclamped, so a backwards clock step goes negative
    it('ignores a negative tick rather than zeroing the counter', () => {
      trackTask();
      const emitted: number[] = [];
      const sub = service.timeWorkingWithoutABreak$.subscribe((v) => emitted.push(v));
      service.otherNoBreakTIme$.next(10000);

      tick$.next({ duration: -5000, date: '2026-07-28', timestamp: 0 });

      expect(emitted[emitted.length - 1]).toBe(10000);
      sub.unsubscribe();
    });

    it('zeroes the counter on resetTimer()', () => {
      const emitted: number[] = [];
      const sub = service.timeWorkingWithoutABreak$.subscribe((v) => emitted.push(v));
      service.otherNoBreakTIme$.next(10000);
      expect(emitted[emitted.length - 1]).toBe(10000);

      service.resetTimer();

      expect(emitted[emitted.length - 1]).toBe(0);
      sub.unsubscribe();
    });
  });

  describe('untracked stretches', () => {
    it('counts a long stretch without a tracked task as a break', () => {
      const emitted: number[] = [];
      const sub = service.timeWorkingWithoutABreak$.subscribe((v) => emitted.push(v));
      service.otherNoBreakTIme$.next(10000);
      expect(emitted[emitted.length - 1]).toBe(10000);

      // more than BREAK_TRIGGER_DURATION with no current task selected
      tick$.next({ duration: 11 * 60000, date: '2026-07-28', timestamp: 0 });

      expect(emitted[emitted.length - 1]).toBe(0);
      sub.unsubscribe();
    });

    // The other half of the same overlap, and the reason the reset is edge- and
    // not level-triggered: once it has fired, time added later in the SAME
    // untracked stretch survives. With a level trigger the next tick wiped it
    // again -- and every tick after.
    it('keeps time added after the untracked-stretch reset', () => {
      const emitted: number[] = [];
      const sub = service.timeWorkingWithoutABreak$.subscribe((v) => emitted.push(v));

      tick$.next({ duration: 11 * 60000, date: '2026-07-28', timestamp: 0 });
      expect(emitted[emitted.length - 1]).toBe(0);

      service.otherNoBreakTIme$.next(60000);
      expect(emitted[emitted.length - 1]).toBe(60000);

      // still untracked: a level trigger would re-zero this on the next tick
      tick$.next({ duration: 60000, date: '2026-07-28', timestamp: 0 });
      tick$.next({ duration: 60000, date: '2026-07-28', timestamp: 0 });

      expect(emitted[emitted.length - 1]).toBe(60000);
      sub.unsubscribe();
    });
  });

  describe('startBreak()', () => {
    it('pauses tracking', () => {
      service.startBreak();
      expect(taskService.pauseCurrent).toHaveBeenCalledTimes(1);
    });

    it('shows an encouraging snack so the click clearly does something', () => {
      service.startBreak();

      expect(snackService.open).toHaveBeenCalledTimes(1);
      expect(snackService.open).toHaveBeenCalledWith(
        jasmine.objectContaining({
          type: 'SUCCESS',
          msg: T.F.TIME_TRACKING.B.BREAK_SNACK,
        }),
      );
    });

    it('dismisses the reminder banner', () => {
      service.startBreak();
      expect(bannerService.dismiss).toHaveBeenCalledTimes(1);
      expect(bannerService.dismiss).toHaveBeenCalledWith(BannerId.TakeABreak);
    });
  });
});
