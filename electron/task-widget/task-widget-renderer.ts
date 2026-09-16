type TaskWidgetContentData =
  import('../shared-with-frontend/task-widget.model').TaskWidgetContentData;
type TaskWidgetListItem =
  import('../shared-with-frontend/task-widget.model').TaskWidgetListItem;

// Status groups take precedence over importance/urgency; ties keep native order.
const taskPriority = (task: TaskWidgetListItem): number =>
  (task.inProgress ? 4 : 0) +
  (task.review ? 2 : 0) +
  Number(!!(task.important || task.urgent));

// macOS provides the outer window clipping and shadow.
document.body.classList.toggle('native-rounded-window', /Mac/.test(navigator.platform));

// Get elements
const showMainBtn = document.getElementById('show-main') as HTMLButtonElement;
const container = document.getElementById('task-widget-container') as HTMLDivElement;
const taskTitle = document.getElementById('task-title') as HTMLDivElement;
const timeDisplay = document.getElementById('time-display') as HTMLDivElement;

// ── Right-click prevention ──
const blockRightClick = (e: MouseEvent): false | void => {
  if (e.type === 'contextmenu' || e.button === 2) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    return false;
  }
};
document.addEventListener('contextmenu', blockRightClick, true);
document.addEventListener('mousedown', blockRightClick, true);
document.addEventListener('mouseup', blockRightClick, true);

// ── Show main button ──
showMainBtn.addEventListener('click', () => {
  window.taskWidgetAPI.showMainWindow();
});

const listWidget = document.getElementById('task-list-widget') as HTMLElement;
const list = document.getElementById('task-list') as HTMLElement;
const listTitle = document.getElementById('list-title') as HTMLElement;
const listCount = document.getElementById('list-count') as HTMLElement;

const emptyList = document.getElementById('list-empty') as HTMLElement;
const listOpen = document.getElementById('list-open') as HTMLButtonElement;
listOpen.addEventListener('click', () => {
  if (view === 'today' || view === 'INBOX_PROJECT')
    window.taskWidgetAPI.act(null, 'navigate', view);
  else window.taskWidgetAPI.showMainWindow();
});
let lastList = '';
let currentContent: TaskWidgetContentData | undefined;
let view = localStorage.getItem('task-widget-view') || 'focus';
const viewSelect = document.createElement('nav');
viewSelect.id = 'list-view';
listTitle.replaceWith(viewSelect);
let editing = false;
let draggedId: string | undefined;
let draggedPriority = 0;
let draggedProject: string | undefined;
let suppressEditUntil = 0;
const clearDropTarget = (): void => {
  list.querySelectorAll('.drop-before, .drop-after').forEach((row) => {
    row.classList.remove('drop-before', 'drop-after');
  });
};
const finishDrag = (): void => {
  draggedId = undefined;
  clearDropTarget();
  suppressEditUntil = Date.now() + 200;
  if (pendingContent) {
    const next = pendingContent;
    pendingContent = undefined;
    lastList = '';
    renderContent(next);
  }
};
let pendingContent: TaskWidgetContentData | undefined;
const addButton = document.getElementById('list-add') as HTMLButtonElement;
const addForm = document.getElementById('list-add-form') as HTMLFormElement;
const addInput = document.getElementById('list-add-input') as HTMLInputElement;
addButton.addEventListener('click', () => {
  addForm.hidden = !addForm.hidden;
  if (!addForm.hidden) addInput.focus();
});
addInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    addForm.hidden = true;
    addInput.value = '';
    addButton.focus();
  }
});
const planningArea = document.createElement('section');
planningArea.className = 'ai-planning';
const planningToolbar = document.createElement('div');
planningToolbar.className = 'ai-toolbar';
const planDay = document.createElement('button');
planDay.type = 'button';
planningToolbar.append(planDay);
const suggestions = document.createElement('div');
suggestions.className = 'ai-suggestions';
suggestions.setAttribute('aria-live', 'polite');
planningArea.append(planningToolbar, suggestions);
addForm.after(planningArea);
let aiBusy = false;
const syncPlanningVisibility = (): void => {
  const preview = suggestions.querySelector('.ai-proposal') !== null || aiBusy;
  emptyList.hidden = preview || !!list.children.length;
  listCount.hidden = preview;
  list.classList.toggle('planning-preview-active', preview);
};
const requestPlan = async (daily: boolean): Promise<void> => {
  if (aiBusy || !currentContent?.list) return;
  const labels = currentContent.list.labels;
  const input = addInput.value.trim();
  if (!daily && !input) return;
  aiBusy = true;
  planDay.disabled = true;
  addInput.disabled = true;
  suggestions.textContent = labels.aiThinking || '';
  syncPlanningVisibility();
  let reply: import('../shared-with-frontend/task-planning').PlanningReply;
  try {
    reply = await window.taskWidgetAPI.suggest(input, daily);
  } catch {
    reply = { plans: [], error: 'unavailable' };
  }
  aiBusy = false;
  planDay.disabled = false;
  addInput.disabled = false;
  if (reply.explicit && reply.plans.length === 1) {
    const saved = await window.taskWidgetAPI.applyPlan(reply.plans[0]);
    if (saved) {
      if (addInput.value.trim() === input) addInput.value = '';
      suggestions.replaceChildren();
      return;
    }
    reply = { plans: [], error: 'unavailable' };
  }
  suggestions.replaceChildren();
  const heading = document.createElement('p');
  heading.textContent = reply.error
    ? labels.aiError || ''
    : reply.plans.length
      ? labels.aiSuggestion || ''
      : labels.aiEmpty || '';
  heading.className = 'ai-plan-intro';
  if (reply.plans.length)
    heading.textContent = `${labels.aiReady || ''} · ${reply.plans.length}`;
  suggestions.append(heading);
  const pending: { button: HTMLButtonElement; apply: () => Promise<void> }[] = [];
  const applied: import('../shared-with-frontend/task-planning').TaskPlan[] = [];
  const acceptAll = document.createElement('button');
  acceptAll.className = 'ai-adopt';
  acceptAll.textContent = labels.aiAdopt || '';
  const undo = document.createElement('button');
  undo.textContent = labels.aiUndo || '';
  undo.hidden = true;
  undo.addEventListener('click', async () => {
    undo.disabled = true;
    let ok = true;
    for (const plan of [...applied].reverse())
      if (!(await window.taskWidgetAPI.undoPlan(plan))) ok = false;
    heading.textContent = ok ? labels.aiUndone || '' : labels.aiChanged || '';
    undo.hidden = true;
  });
  for (const plan of reply.plans) {
    const proposal = document.createElement('div');
    proposal.className = 'ai-proposal';
    const title = document.createElement('strong');
    title.textContent = plan.title;
    const reason = document.createElement('small');
    reason.textContent = plan.reason;
    const fields = document.createElement('div');
    fields.className = 'ai-plan-fields';
    const adjustment = document.createElement('details');
    const adjustmentLabel = document.createElement('summary');
    adjustmentLabel.textContent = labels.detail || '';
    adjustment.append(adjustmentLabel, fields, reason);
    const estimate = document.createElement('small');
    estimate.textContent = plan.time || plan.date || '';
    estimate.title = plan.reason;
    const date = document.createElement('input');
    date.type = 'date';
    date.value = plan.date || '';
    date.setAttribute('aria-label', labels.planTask || '');
    const time = document.createElement('input');
    time.type = 'time';
    time.value = plan.time || '';
    time.setAttribute('aria-label', labels.schedule || '');
    const accept = document.createElement('button');
    accept.textContent = labels.aiAccept || '';
    const apply = async (): Promise<void> => {
      if (!date.reportValidity() || !time.reportValidity() || (time.value && !date.value))
        return;
      accept.disabled = true;
      const edited = {
        ...plan,
        date: date.value || undefined,
        time: time.value || undefined,
      };
      const result = await window.taskWidgetAPI.applyPlan(edited);
      if (!result) {
        reason.textContent = labels.aiError || '';
        accept.disabled = false;
        return;
      }
      applied.push(edited);
      proposal.remove();
      undo.hidden = false;
      if (daily) {
        view = 'today';
        localStorage.setItem('task-widget-view', view);
        lastList = '';
        if (currentContent) renderContent(currentContent);
      }
      if (!daily && addInput.value.trim() === input) addInput.value = '';
      if (!suggestions.querySelector('.ai-proposal')) {
        heading.textContent = labels.aiAdopted || '';
        acceptAll.hidden = true;
      }
      syncPlanningVisibility();
    };
    pending.push({ button: accept, apply });
    accept.addEventListener('click', () => void apply());
    accept.className = 'ai-single-accept';
    fields.append(date, time);
    proposal.append(title, estimate, adjustment, accept);
    suggestions.append(proposal);
  }
  acceptAll.addEventListener('click', async () => {
    acceptAll.disabled = true;
    for (const item of pending)
      if (item.button.isConnected && !item.button.disabled) await item.apply();
    acceptAll.disabled = false;
    syncPlanningVisibility();
  });
  if (reply.plans.length) suggestions.append(acceptAll, undo);
  syncPlanningVisibility();
  if (!daily) {
    const save = document.createElement('button');
    save.textContent = labels.aiSaveOnly || '';
    save.addEventListener('click', () => {
      window.taskWidgetAPI.writeTask(null, input, { projectId: 'INBOX_PROJECT' });
      if (addInput.value.trim() === input) addInput.value = '';
      suggestions.replaceChildren();
    });
    suggestions.append(save);
  }
};
planDay.addEventListener('click', () => void requestPlan(true));
addForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void requestPlan(false);
});

// ── Content updates ──
const renderContent = (data: TaskWidgetContentData): void => {
  currentContent = data;
  if (editing || draggedId) {
    pendingContent = data;
    return;
  }
  listWidget.hidden = !data.list;
  container.hidden = !!data.list;
  if (data.list) {
    const snapshot = JSON.stringify(data.list);
    if (snapshot === lastList) return;
    lastList = snapshot;
    const { labels, scope } = data.list;
    const choices = [
      ['today', labels.today],
      ['all', labels.all],
    ];
    if (!choices.some(([id]) => id === view)) view = 'all';
    viewSelect.replaceChildren(
      ...choices.map(([id, title]) => {
        const button = document.createElement('button');
        button.textContent = title;
        button.type = 'button';
        button.setAttribute('aria-pressed', String(view === id));
        button.addEventListener('click', () => {
          view = id;
          localStorage.setItem('task-widget-view', view);
          lastList = '';
          if (currentContent) renderContent(currentContent);
        });
        return button;
      }),
    );
    const tasks = data.list.tasks.filter(
      (t) =>
        view === 'all' ||
        (view === 'focus'
          ? t.inProgress || t.review
          : view === 'today'
            ? t.today
            : t.projectId === view),
    );

    addButton.title = labels.add || '';
    addButton.setAttribute('aria-label', labels.add || '');
    addInput.placeholder = labels.aiCapture || '';
    planDay.textContent = labels.aiToday || '';
    addInput.setAttribute('aria-label', labels.add || '');
    addForm.querySelector('button')?.setAttribute('aria-label', labels.add || '');
    listTitle.textContent = labels[scope];
    listCount.textContent = String(tasks.length);
    listOpen.title = labels.open;
    listOpen.setAttribute('aria-label', labels.open);
    emptyList.textContent = labels.empty;
    syncPlanningVisibility();
    emptyList.hidden = tasks.length > 0;
    const focusedId = (document.activeElement as HTMLElement | null)?.dataset.taskId;
    const wasStatusFocused =
      document.activeElement?.classList.contains('workflow-status');

    const sortedTasks = [...tasks].sort(
      (a, b) =>
        taskPriority(b) - taskPriority(a) ||
        (view === 'today' ? (a.todayRank ?? 0) - (b.todayRank ?? 0) : 0),
    );
    list.replaceChildren(
      ...sortedTasks.map((task) => {
        const row = document.createElement('div');
        row.className = 'list-task';
        row.dataset.taskId = task.id;
        row.draggable = true;
        row.addEventListener('dragstart', (event) => {
          if (editing || (event.target as HTMLElement).closest('input, button, select')) {
            event.preventDefault();
            return;
          }
          draggedId = task.id;
          draggedPriority = taskPriority(task);
          draggedProject = task.projectId;
          if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', task.id);
          }
        });
        row.addEventListener('dragover', (event) => {
          clearDropTarget();
          if (
            !draggedId ||
            draggedId === task.id ||
            draggedPriority !== taskPriority(task) ||
            (view !== 'today' && draggedProject !== task.projectId)
          )
            return;
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
          const bounds = row.getBoundingClientRect();
          const midpoint = bounds.top + (bounds.height >> 1);
          row.classList.add(event.clientY < midpoint ? 'drop-before' : 'drop-after');
        });
        row.addEventListener('drop', (event) => {
          if (
            !draggedId ||
            draggedId === task.id ||
            draggedPriority !== taskPriority(task) ||
            (view !== 'today' && draggedProject !== task.projectId)
          )
            return;
          event.preventDefault();
          const ids = sortedTasks.map((item) => item.id).filter((id) => id !== draggedId);
          const bounds = row.getBoundingClientRect();
          const midpoint = bounds.top + (bounds.height >> 1);
          const after = event.clientY >= midpoint;
          ids.splice(ids.indexOf(task.id) + Number(after), 0, draggedId);
          window.taskWidgetAPI.act(
            draggedId,
            'reorder',
            JSON.stringify({
              ids:
                view === 'today'
                  ? ids
                  : ids.filter(
                      (id) =>
                        tasks.find((t) => t.id === id)?.projectId === task.projectId,
                    ),
              scope: view,
            }),
          );
          pendingContent = pendingContent || data;
          finishDrag();
        });
        row.addEventListener('dragend', finishDrag);
        row.setAttribute('role', 'listitem');
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.dataset.taskId = task.id;
        check.setAttribute('aria-label', `${labels.complete}: ${task.title}`);
        check.addEventListener('change', () => {
          check.disabled = true;
          window.taskWidgetAPI.completeTask(task.id);
          // The app remains authoritative; restore the control if the app is busy.
          setTimeout(() => {
            check.disabled = false;
            check.checked = false;
          }, 3000);
        });
        const text = document.createElement('span');
        text.textContent = task.title;
        text.title = `${task.title} — ${labels.edit || ''}`;
        text.tabIndex = 0;
        text.setAttribute('role', 'button');
        text.setAttribute('aria-label', `${labels.edit || ''}: ${task.title}`);
        const startEdit = (): void => {
          if (editing || draggedId || Date.now() < suppressEditUntil) return;
          editing = true;
          const input = document.createElement('input');
          input.className = 'task-title-editor';
          input.value = task.title;
          input.maxLength = 1000;
          input.setAttribute('aria-label', labels.edit || '');
          let finished = false;
          const finish = (save: boolean): void => {
            if (finished) return;
            finished = true;
            const title = input.value.trim();
            editing = false;
            input.replaceWith(text);
            if (save && title && title !== task.title) {
              text.textContent = title;
              window.taskWidgetAPI.writeTask(task.id, title);
            }
            if (pendingContent) {
              const next = pendingContent;
              pendingContent = undefined;
              lastList = '';
              renderContent(next);
            }
          };
          input.addEventListener('keydown', (event) => {
            if (event.isComposing) return;
            if (event.key === 'Enter') {
              event.preventDefault();
              finish(true);
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              finish(false);
            }
          });
          input.addEventListener('blur', () => finish(true));
          text.replaceWith(input);
          input.focus();
          input.select();
        };
        text.addEventListener('click', startEdit);
        text.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            startEdit();
          }
        });
        const body = document.createElement('div');
        body.className = 'list-task-body';
        const progress = document.createElement('button');
        progress.type = 'button';
        progress.className = 'workflow-status';
        progress.dataset.taskId = task.id;
        progress.setAttribute('aria-label', labels.progress || '');
        progress.setAttribute('aria-pressed', String(!!task.inProgress));
        const currentStatus = task.inProgress ? labels.progress : labels.pending;
        const nextStatus = task.inProgress ? labels.pending : labels.progress;
        progress.title = `${currentStatus || ''} → ${nextStatus || ''}`;
        progress.addEventListener('click', () =>
          window.taskWidgetAPI.act(
            task.id,
            'status',
            task.inProgress ? 'pending' : 'progress',
          ),
        );
        const metrics = document.createElement('small');
        const minutes = (ms: number): string => `${Math.floor(ms / 60000)}m`;
        const measures: string[] = [];
        if (task.aiMs || !task.aiCoverageIncomplete) {
          measures.push(`${labels.ai || 'AI'} ${minutes(task.aiMs || 0)}`);
        }
        if (task.humanMs || !task.humanCoverageIncomplete) {
          measures.push(`${labels.human || ''} ${minutes(task.humanMs || 0)}`);
        }
        metrics.textContent = measures.join(' · ');
        metrics.hidden = !measures.length;
        const association = document.createElement('small');
        association.textContent = task.associationLabel || '';
        association.title = task.associationDetail || '';
        association.hidden = !task.associationLabel;

        body.append(text, progress);
        const schedule = document.createElement('small');
        schedule.textContent =
          task.scheduleLabel ||
          (task.today ? labels.today || '' : task.projectTitle || '');
        body.append(schedule);
        const controls = document.createElement('div');
        controls.className = 'workflow-controls';
        const project = document.createElement('select');
        project.setAttribute('aria-label', labels.project || '');
        for (const p of data.list?.projects || []) {
          const option = document.createElement('option');
          option.value = p.id;
          option.textContent = p.title;
          project.append(option);
        }
        project.value = task.projectId || '';
        project.addEventListener('change', () =>
          window.taskWidgetAPI.act(task.id, 'project', project.value),
        );
        controls.append(project);
        for (const [action, title, active] of [
          ['important', labels.important, task.important],
          ['urgent', labels.urgent, task.urgent],
          ['today', task.today ? labels.removeToday : labels.addToday, task.today],
        ] as const) {
          const button = document.createElement('button');
          button.textContent = title || '';
          button.setAttribute('aria-pressed', String(!!active));
          button.addEventListener('click', () =>
            window.taskWidgetAPI.act(task.id, action),
          );
          controls.append(button);
        }
        const plan = document.createElement('button');
        plan.textContent = labels.planTask || '';
        plan.addEventListener('click', () => window.taskWidgetAPI.act(task.id, 'plan'));
        controls.append(plan);
        const detail = document.createElement('button');
        detail.textContent = '↗';
        detail.title = labels.detail || '';
        detail.setAttribute('aria-label', labels.detail || '');
        detail.addEventListener('click', () => window.taskWidgetAPI.act(task.id, 'open'));
        controls.append(detail);
        const more = document.createElement('details');
        more.className = 'task-adjustments';
        const summary = document.createElement('summary');
        summary.textContent = labels.detail || '';
        more.append(summary, controls, metrics, association);
        body.append(more);
        if (task.codexThreadUrl) {
          const jump = document.createElement('button');
          jump.type = 'button';
          jump.textContent = '↗';
          jump.title = labels.openCodex || 'Codex';
          jump.setAttribute('aria-label', `${jump.title}: ${task.title}`);
          jump.addEventListener('click', () =>
            window.taskWidgetAPI.openCodexThread(task.id),
          );
          body.insertBefore(jump, schedule);
        }
        row.append(check, body);
        return row;
      }),
    );
    if (focusedId) {
      Array.from(
        list.querySelectorAll<HTMLElement>(
          wasStatusFocused ? '.workflow-status' : 'input',
        ),
      )
        .find((input) => input.dataset.taskId === focusedId)
        ?.focus();
    }
    syncPlanningVisibility();
    return;
  }
  lastList = '';
  container.classList.remove('mode-pomodoro', 'mode-focus', 'mode-task', 'mode-idle');
  if (data.mode) {
    container.classList.add(`mode-${data.mode}`);
  }
  taskTitle.textContent = data.title || 'No active task';
  timeDisplay.textContent = data.time || '--:--';
};
window.taskWidgetAPI.onUpdateContent(renderContent);

// ── Opacity updates ──
window.taskWidgetAPI.onUpdateOpacity((opacity) => {
  document.body.style.setProperty('--opacity', opacity.toString());
});

// ── Responsive class + scale updates ──
const REFERENCE_HEIGHT = 80;
const BP_FULL = 80;

const updateResponsiveState = (): void => {
  const w = document.documentElement.clientWidth;
  const h = document.documentElement.clientHeight;

  document.body.classList.remove('size-full', 'size-tiny');
  if (w >= BP_FULL) {
    document.body.classList.add('size-full');
  } else {
    document.body.classList.add('size-tiny');
  }

  const scale = Math.max(0.8, Math.min(2, h / REFERENCE_HEIGHT));
  document.body.style.setProperty('--scale', scale.toString());
};

const resizeObserver = new ResizeObserver(updateResponsiveState);
resizeObserver.observe(document.documentElement);
updateResponsiveState();
