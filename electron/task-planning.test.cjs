const test = require('node:test');
const assert = require('node:assert/strict');
require('ts-node/register/transpile-only');
const {
  validatePlans,
  explicitCapture,
} = require('./shared-with-frontend/task-planning.ts');
const p = { title: 'Work', reason: 'test', date: '2026-09-15' };
test('explicit capture extracts scheduling intent without a model', () => {
  const now = new Date(2026, 8, 14, 10);
  assert.deepEqual(explicitCapture('明天下午3点检查回归，预计30分钟', now), {
    title: '检查回归',
    date: '2026-09-15',
    time: '15:00',
    reason: 'explicit',
  });
  assert.equal(explicitCapture('今天9点检查回归，预计30分钟', now), undefined);
  assert.equal(explicitCapture('明天截止检查回归，预计30分钟', now), undefined);
  assert.equal(explicitCapture('明天可能检查回归，预计30分钟', now), undefined);
});
test('rejects invalid calendar dates, model invented IDs and duplicate ownership', () => {
  for (const invalid of [
    { ...p, date: '2026-02-30' },
    { ...p, time: '25:00' },
    { ...p, taskId: 'unknown' },
    { ...p, projectId: 'fake' },
  ])
    assert.throws(() => validatePlans([invalid], ['a'], ['work']));
  assert.throws(() =>
    validatePlans(
      [
        { ...p, taskId: 'a' },
        { ...p, taskId: 'a' },
      ],
      ['a'],
      [],
    ),
  );
});
test('strips commands and accepts only schedule data', () => {
  assert.deepEqual(validatePlans([{ ...p, command: 'rm -rf example' }], [], []), [p]);
});
const { suggestPlans } = require('./task-widget/ai-planner.ts');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
test('model suggestions are bounded by existing time and known task identity', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-plan-'));
  fs.writeFileSync(
    path.join(dir, 'ai-planner.json'),
    JSON.stringify({
      baseUrl: 'http://127.0.0.1:8317/v1',
      apiKey: 'test',
      model: 'test',
    }),
  );
  const original = global.fetch;
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const data = {
    all: [
      { id: 'a', title: 'Review' },
      { id: 'occupied', title: 'Existing', today: true, estimateMs: 120 * 60000 },
    ],
    projects: [],
  };
  const proposal = { ...p, taskId: 'a', date: today };
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      output: [
        {
          content: [{ type: 'output_text', text: JSON.stringify({ plans: [proposal] }) }],
        },
      ],
    }),
  });
  try {
    assert.equal((await suggestPlans(dir, '', true, data)).plans.length, 1);
    proposal.taskId = 'invented';
    assert.equal((await suggestPlans(dir, '', true, data)).error, 'unavailable');
  } finally {
    global.fetch = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
