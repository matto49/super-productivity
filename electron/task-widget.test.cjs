const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

require('ts-node/register/transpile-only');

const originalModuleLoad = Module._load;
const taskWidgetModulePath = path.resolve(__dirname, 'task-widget/task-widget.ts');

let createdWindows = [];
let openedUrls = [];
let ipcHandlers = new Map();
let loadSimpleStoreAllImpl;

const createDeferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
};

class FakeWebContents {
  constructor() {
    this.sent = [];
    this.mainFrame = {};
    this._handlers = new Map();
  }
  on(eventName, handler) {
    this._handlers.set(eventName, handler);
  }
  once(eventName, handler) {
    this._handlers.set(eventName, handler);
  }
  emitOnce(eventName) {
    const handler = this._handlers.get(eventName);
    if (handler) handler();
  }
  send(channel, payload) {
    this.sent.push({ channel, payload });
  }
  focus() {}
  isDestroyed() {
    return false;
  }
  removeAllListeners() {}
}

class FakeBrowserWindow {
  constructor(options = {}) {
    this.options = options;
    this._visible = false;
    this.showCount = 0;
    this.showInactiveCount = 0;
    this.hideCount = 0;
    this._handlers = new Map();
    this.webContents = new FakeWebContents();
    createdWindows.push(this);
  }

  static getAllWindows() {
    return createdWindows.slice();
  }

  loadFile() {}
  setVisibleOnAllWorkspaces(visible, options) {
    this.workspaceOptions = options;
  }
  setOpacity() {}
  setClosable() {}
  removeAllListeners() {}
  destroy() {}
  on(eventName, handler) {
    this._handlers.set(eventName, handler);
  }
  emit(eventName) {
    const handler = this._handlers.get(eventName);
    if (handler) handler();
  }
  getBounds() {
    return { width: 300, height: 80, x: 0, y: 0 };
  }
  isDestroyed() {
    return false;
  }
  isVisible() {
    return this._visible;
  }
  show() {
    this._visible = true;
    this.showCount += 1;
  }
  restore() {}
  focus() {}
  showInactive() {
    this._visible = true;
    this.showInactiveCount += 1;
  }
  hide() {
    this._visible = false;
    this.hideCount += 1;
  }
}

const installMocks = () => {
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        BrowserWindow: FakeBrowserWindow,
        shell: {
          openExternal: async (url) => {
            openedUrls.push(url);
          },
        },
        app: { getPath: () => '/tmp/sp-ai-test' },
        ipcMain: {
          handle: (name, cb) => ipcHandlers.set(name, cb),
          removeHandler: (name) => ipcHandlers.delete(name),
          on: (name, cb) => ipcHandlers.set(name, cb),
          removeAllListeners: (name) => ipcHandlers.delete(name),
        },
        screen: {
          getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }),
          getDisplayMatching: () => ({
            bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          }),
        },
      };
    }
    if (request === 'electron-log/main') {
      return { info: () => {} };
    }
    if (request.endsWith('simple-store')) {
      return {
        loadSimpleStoreAll: () => loadSimpleStoreAllImpl(),
        saveSimpleStore: () => {},
      };
    }
    if (request.endsWith('common.const')) {
      return { IS_MAC: false };
    }
    return originalModuleLoad.call(this, request, parent, isMain);
  };
};

const loadModule = () => {
  delete require.cache[taskWidgetModulePath];
  return require(taskWidgetModulePath);
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

test.beforeEach(() => {
  createdWindows = [];
  openedUrls = [];
  ipcHandlers = new Map();
  loadSimpleStoreAllImpl = async () => ({});
  installMocks();
});

test.afterEach(() => {
  Module._load = originalModuleLoad;
});

test('toggleTaskWidgetVisibility is a no-op while the task widget feature is disabled', () => {
  const mod = loadModule();
  mod.toggleTaskWidgetVisibility();
  assert.equal(createdWindows.length, 0, 'no window should be created when disabled');
});

test('toggleTaskWidgetVisibility shows the widget when it is enabled but hidden', async () => {
  const mod = loadModule();
  mod.updateTaskWidgetEnabled(true);
  await flush();

  assert.equal(createdWindows.length, 1, 'enabling should create the widget window');
  const win = createdWindows[0];
  assert.equal(win.isVisible(), false, 'widget starts hidden');

  mod.toggleTaskWidgetVisibility();
  assert.equal(win.isVisible(), true, 'toggle should show the hidden widget');
  assert.equal(win.showInactiveCount, 1);
});

test('toggleTaskWidgetVisibility hides the widget when it is enabled and visible', async () => {
  const mod = loadModule();
  mod.updateTaskWidgetEnabled(true);
  await flush();

  const win = createdWindows[0];
  mod.showTaskWidget();
  assert.equal(win.isVisible(), true, 'widget should be visible before toggling');

  mod.toggleTaskWidgetVisibility();
  assert.equal(win.isVisible(), false, 'toggle should hide the visible widget');
  assert.equal(win.hideCount, 1);
});

test('forcing the widget visible via the shortcut sets a sticky user-forced flag', async () => {
  const mod = loadModule();
  mod.updateTaskWidgetEnabled(true);
  await flush();

  assert.equal(mod.getIsTaskWidgetUserForcedVisible(), false, 'flag starts cleared');

  mod.toggleTaskWidgetVisibility();
  assert.equal(
    mod.getIsTaskWidgetUserForcedVisible(),
    true,
    'showing via the shortcut sets the sticky flag',
  );

  mod.toggleTaskWidgetVisibility();
  assert.equal(
    mod.getIsTaskWidgetUserForcedVisible(),
    false,
    'hiding via the shortcut clears the sticky flag',
  );
});

test('disabling the widget clears the sticky user-forced flag', async () => {
  const mod = loadModule();
  mod.updateTaskWidgetEnabled(true);
  await flush();

  mod.toggleTaskWidgetVisibility();
  assert.equal(mod.getIsTaskWidgetUserForcedVisible(), true);

  mod.updateTaskWidgetEnabled(false);
  assert.equal(
    mod.getIsTaskWidgetUserForcedVisible(),
    false,
    'disabling the feature resets the sticky flag',
  );
});

test('disabling clears the sticky flag even when the widget window is absent', () => {
  const mod = loadModule();

  // Enable but do not flush: createTaskWidgetWindow() is mid-flight, so
  // taskWidgetWin is still null (the "absent window" / async re-create gap).
  mod.updateTaskWidgetEnabled(true);

  // User hits the shortcut during that gap — the flag is set without a window.
  mod.toggleTaskWidgetVisibility();
  assert.equal(createdWindows.length, 0, 'no window exists yet');
  assert.equal(
    mod.getIsTaskWidgetUserForcedVisible(),
    true,
    'shortcut sets the sticky flag even without a window',
  );

  // Disabling now must clear the flag even though destroyTaskWidget() is
  // skipped (its guard requires an existing window), or it would leak into
  // the next enable.
  mod.updateTaskWidgetEnabled(false);
  assert.equal(
    mod.getIsTaskWidgetUserForcedVisible(),
    false,
    'disabling clears the flag regardless of whether the window exists',
  );
});

test('disabling while async creation is pending prevents the widget window from being created', async () => {
  const storeLoad = createDeferred();
  loadSimpleStoreAllImpl = () => storeLoad.promise;
  const mod = loadModule();

  mod.updateTaskWidgetEnabled(true);
  mod.updateTaskWidgetEnabled(false);

  storeLoad.resolve({});
  await flush();

  assert.equal(
    createdWindows.length,
    0,
    'disabling before persisted bounds load resolves should cancel window creation',
  );
});

test('shortcut reveal while async creation is pending shows the widget after creation completes', async () => {
  const storeLoad = createDeferred();
  loadSimpleStoreAllImpl = () => storeLoad.promise;
  const mod = loadModule();

  mod.updateTaskWidgetEnabled(true);
  mod.toggleTaskWidgetVisibility();

  storeLoad.resolve({});
  await flush();

  assert.equal(createdWindows.length, 1, 'only the initial in-flight creation is reused');
  assert.equal(
    createdWindows[0].isVisible(),
    true,
    'pending shortcut reveal should show the window once it exists',
  );
});

test('shortcut reveal uses showInactive so the current app keeps focus', async () => {
  const mod = loadModule();
  mod.updateTaskWidgetEnabled(true);
  await flush();

  const win = createdWindows[0];
  mod.toggleTaskWidgetVisibility();

  assert.equal(win.showInactiveCount, 1);
  assert.equal(win.showCount, 0);
  assert.equal(win.isVisible(), true, 'widget should still become visible');
});

test('the closed event clears the sticky flag so it does not outlive the window', async () => {
  const mod = loadModule();
  mod.updateTaskWidgetEnabled(true);
  await flush();

  const win = createdWindows[0];
  mod.toggleTaskWidgetVisibility();
  assert.equal(mod.getIsTaskWidgetUserForcedVisible(), true);

  win.emit('closed');
  assert.equal(
    mod.getIsTaskWidgetUserForcedVisible(),
    false,
    'closing the window clears the sticky flag',
  );
});

test('the opacity in effect at load time reaches the widget renderer once it finished loading', async () => {
  const mod = loadModule();

  mod.updateTaskWidgetEnabled(true);
  await flush();

  const { webContents } = createdWindows[0];

  // The user's saved opacity arrives while the widget page is still loading.
  // Sending it now is useless: the renderer only registers its `update-opacity`
  // listener when task-widget-renderer.js runs, and ipcRenderer does not replay.
  mod.updateTaskWidgetOpacity(5);
  webContents.sent.length = 0;

  webContents.emitOnce('did-finish-load');

  assert.deepEqual(
    webContents.sent.filter((m) => m.channel === 'update-opacity'),
    // 5 % is below the 10 % floor, so the renderer must get the clamped value.
    [{ channel: 'update-opacity', payload: 0.1 }],
    'the opacity current at load time must reach the renderer exactly once, clamped',
  );
});

const widgetList = {
  today: [{ id: 'today-1', title: '<img src=x onerror=alert(1)>' }],
  all: [{ id: 'all-1', title: 'Parallel agent work' }],
  projects: [{ id: 'work', title: 'Work' }],
  activeView: 'work',
  labels: {
    today: 'Today',
    all: 'All',
    empty: 'Empty',
    complete: 'Complete',
    open: 'Open',
  },
};

test('list mode renders without an active timer and restores content after reload', async () => {
  const mod = loadModule();
  const main = new FakeBrowserWindow();
  mod.initTaskWidgetSettingsListener();
  ipcHandlers.get('UPDATE_TASK_WIDGET_LIST')(
    { sender: main.webContents, senderFrame: main.webContents.mainFrame },
    widgetList,
  );
  ipcHandlers.get('UPDATE_TASK_WIDGET_SETTINGS')(
    {},
    { isEnabled: true, isAlwaysShow: true, displayMode: 'today' },
  );
  await flush();
  const win = createdWindows[1];
  win.webContents.emitOnce('did-finish-load');
  const content = win.webContents.sent
    .filter((x) => x.channel === 'update-content')
    .at(-1).payload;
  assert.deepEqual(content.list.tasks, widgetList.all);
  assert.equal(content.list.activeView, 'work');
  assert.equal(win.workspaceOptions.skipTransformProcessType, true);
  win.emit('ready-to-show');
  assert.equal(win.workspaceOptions.skipTransformProcessType, true);
  assert.equal(win.options.alwaysOnTop, true);
  assert.equal(win.options.height, 360);
  assert.equal(win.options.maxHeight, 900);
  assert.equal(win.isVisible(), true);
});

test('completion only forwards displayed task IDs from the widget main frame', async () => {
  const mod = loadModule();
  const main = new FakeBrowserWindow();
  mod.initTaskWidgetSettingsListener();
  ipcHandlers.get('UPDATE_TASK_WIDGET_LIST')(
    { sender: main.webContents, senderFrame: main.webContents.mainFrame },
    widgetList,
  );
  ipcHandlers.get('UPDATE_TASK_WIDGET_SETTINGS')(
    {},
    { isEnabled: true, displayMode: 'all' },
  );
  await flush();
  const win = createdWindows[1];
  const complete = ipcHandlers.get('task-widget-complete');
  complete(
    { sender: main.webContents, senderFrame: main.webContents.mainFrame },
    'all-1',
  );
  complete({ sender: win.webContents, senderFrame: {} }, 'all-1');
  complete(
    { sender: win.webContents, senderFrame: win.webContents.mainFrame },
    'missing',
  );
  assert.equal(
    main.webContents.sent.filter((x) => x.channel === 'TASK_WIDGET_COMPLETE').length,
    0,
  );
  complete({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, 'all-1');
  assert.deepEqual(
    main.webContents.sent.filter((x) => x.channel === 'TASK_WIDGET_COMPLETE'),
    [{ channel: 'TASK_WIDGET_COMPLETE', payload: 'all-1' }],
  );
});

test('empty today still supplies all tasks for renderer view switching', async () => {
  const mod = loadModule();
  const main = new FakeBrowserWindow();
  mod.initTaskWidgetSettingsListener();
  ipcHandlers.get('UPDATE_TASK_WIDGET_SETTINGS')(
    {},
    { isEnabled: true, displayMode: 'today' },
  );
  await flush();
  ipcHandlers.get('UPDATE_TASK_WIDGET_LIST')(
    { sender: main.webContents, senderFrame: main.webContents.mainFrame },
    { ...widgetList, today: [] },
  );
  const win = createdWindows[1];
  assert.deepEqual(
    win.webContents.sent.filter((x) => x.channel === 'update-content').at(-1).payload.list
      .tasks,
    widgetList.all,
  );
});

test('progress only forwards displayed task IDs from the widget main frame', async () => {
  const mod = loadModule();
  const main = new FakeBrowserWindow();
  mod.initTaskWidgetSettingsListener();
  ipcHandlers.get('UPDATE_TASK_WIDGET_LIST')(
    { sender: main.webContents, senderFrame: main.webContents.mainFrame },
    widgetList,
  );
  ipcHandlers.get('UPDATE_TASK_WIDGET_SETTINGS')(
    {},
    { isEnabled: true, displayMode: 'all' },
  );
  await flush();
  const win = createdWindows[1];
  const complete = ipcHandlers.get('task-widget-progress');
  complete(
    { sender: main.webContents, senderFrame: main.webContents.mainFrame },
    'all-1',
  );
  complete({ sender: win.webContents, senderFrame: {} }, 'all-1');
  complete(
    { sender: win.webContents, senderFrame: win.webContents.mainFrame },
    'missing',
  );
  assert.equal(
    main.webContents.sent.filter((x) => x.channel === 'TASK_WIDGET_PROGRESS').length,
    0,
  );
  complete({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, 'all-1');
  assert.deepEqual(
    main.webContents.sent.filter((x) => x.channel === 'TASK_WIDGET_PROGRESS'),
    [{ channel: 'TASK_WIDGET_PROGRESS', payload: 'all-1' }],
  );
});

test('Codex jump only opens the cached safe thread link for a displayed task', async () => {
  const mod = loadModule();
  const main = new FakeBrowserWindow();
  const url = 'codex://threads/01a06a8a-4bca-79b0-acd1-df7fea905221?hostId=remote-ssh-discovered%3Adevbox';
  mod.initTaskWidgetSettingsListener();
  ipcHandlers.get('UPDATE_TASK_WIDGET_LIST')(
    { sender: main.webContents, senderFrame: main.webContents.mainFrame },
    { ...widgetList, all: [{ id: 'all-1', title: 'Task', codexThreadUrl: url }] },
  );
  ipcHandlers.get('UPDATE_TASK_WIDGET_SETTINGS')(
    {},
    { isEnabled: true, displayMode: 'all' },
  );
  await flush();
  const win = createdWindows[1];
  const jump = ipcHandlers.get('task-widget-open-codex');
  jump({ sender: main.webContents, senderFrame: main.webContents.mainFrame }, 'all-1');
  jump({ sender: win.webContents, senderFrame: {} }, 'all-1');
  jump({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, url);
  assert.deepEqual(openedUrls, []);
  jump({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, 'all-1');
  assert.deepEqual(openedUrls, [url]);
});

test('Codex links reject commands, prompts and unrelated schemes', () => {
  const {
    isCodexThreadLink,
    getCodexThreadLink,
  } = require('./shared-with-frontend/codex-thread-link.ts');
  const {
    isExternalUrlSchemeAllowed,
  } = require('./shared-with-frontend/is-external-url-allowed.ts');
  const url = 'codex://threads/01a06a8a-4bca-79b0-acd1-df7fea905221';
  const hostedUrl = url + '?hostId=remote-ssh-discovered%3Adevbox';
  assert.equal(getCodexThreadLink(`[Open Codex](${url})`), url);
  assert.equal(isExternalUrlSchemeAllowed(url), true);
  assert.equal(getCodexThreadLink(`[Open Codex](${hostedUrl})`), hostedUrl);
  assert.equal(isExternalUrlSchemeAllowed(hostedUrl), true);
  for (const bad of [
    url + '?prompt=run',
    url + '/extra',
    'codex://threads/new',
    'codex://settings',
    'https://threads/a',
    url + '\n',
    hostedUrl + '&prompt=run',
    url + '?hostId=devbox%2Fother',
    url + '?hostId=devbox%ZZ',
  ]) {
    assert.equal(isCodexThreadLink(bad), false, bad);
  }
  assert.equal(isExternalUrlSchemeAllowed(url + '?prompt=run'), false);
  assert.equal(getCodexThreadLink(`[Open](${url}?prompt=run)`), undefined);
});

test('widget writes require the widget main frame, a visible task and a bounded title', async () => {
  const mod = loadModule();
  const main = new FakeBrowserWindow();
  mod.initTaskWidgetSettingsListener();
  ipcHandlers.get('UPDATE_TASK_WIDGET_LIST')(
    { sender: main.webContents, senderFrame: main.webContents.mainFrame },
    widgetList,
  );
  ipcHandlers.get('UPDATE_TASK_WIDGET_SETTINGS')(
    {},
    { isEnabled: true, displayMode: 'all' },
  );
  await flush();
  const win = createdWindows[1];
  const write = ipcHandlers.get('task-widget-write');
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  write(
    { sender: main.webContents, senderFrame: main.webContents.mainFrame },
    { id: null, title: 'New' },
  );
  write({ ...event, senderFrame: {} }, { id: null, title: 'New' });
  for (const payload of [
    null,
    {},
    { id: 'missing', title: 'New' },
    { id: null, title: ' ' },
    { id: null, title: 'x'.repeat(1001) },
  ])
    write(event, payload);
  assert.equal(
    main.webContents.sent.filter((x) => x.channel === 'TASK_WIDGET_WRITE').length,
    0,
  );
  write(event, { id: 'all-1', title: ' Renamed ' });
  write(event, { id: null, title: 'New task' });
  assert.deepEqual(
    main.webContents.sent.filter((x) => x.channel === 'TASK_WIDGET_WRITE'),
    [
      {
        channel: 'TASK_WIDGET_WRITE',
        payload: { id: 'all-1', title: 'Renamed', today: false },
      },
      {
        channel: 'TASK_WIDGET_WRITE',
        payload: { id: null, title: 'New task', today: false },
      },
    ],
  );
});

test('workflow commands reject other windows, subframes, unknown tasks and actions', async () => {
  const mod = loadModule();
  const main = new FakeBrowserWindow();
  mod.initTaskWidgetSettingsListener();
  ipcHandlers.get('UPDATE_TASK_WIDGET_LIST')(
    { sender: main.webContents, senderFrame: main.webContents.mainFrame },
    widgetList,
  );
  ipcHandlers.get('UPDATE_TASK_WIDGET_SETTINGS')(
    {},
    { isEnabled: true, displayMode: 'all' },
  );
  await flush();
  const win = createdWindows[1];
  const act = ipcHandlers.get('task-widget-action');
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  act(
    { ...event, sender: main.webContents },
    { id: 'all-1', action: 'status', value: 'review' },
  );
  act({ ...event, senderFrame: {} }, { id: null, action: 'setup' });
  for (const payload of [
    null,
    {},
    { id: 'missing', action: 'status' },
    { id: 'all-1', action: 'execute' },
    { id: 'all-1', action: 'project', value: {} },
  ])
    act(event, payload);
  assert.equal(
    main.webContents.sent.filter((x) => x.channel === 'TASK_WIDGET_ACTION').length,
    0,
  );
  act(event, { id: 'all-1', action: 'status', value: 'review' });
  act(event, { id: null, action: 'navigate', value: 'work' });
  act(event, { id: null, action: 'navigate', value: 'missing-project' });
  assert.deepEqual(
    main.webContents.sent.filter((x) => x.channel === 'TASK_WIDGET_ACTION'),
    [
      {
        channel: 'TASK_WIDGET_ACTION',
        payload: { id: 'all-1', action: 'status', value: 'review' },
      },
      {
        channel: 'TASK_WIDGET_ACTION',
        payload: { id: null, action: 'navigate', value: 'work' },
      },
    ],
  );
});
