import { mergeTaskActivity, readTaskActivity, sumTaskActivity } from './task-activity';

describe('task activity imports', () => {
  it('deduplicates retries and preserves manually tracked time', () => {
    const first = mergeTaskActivity(
      'My notes',
      { ['2026-09-07']: 5000 },
      'mac',
      '2026-09-07',
      { humanMs: 60000, aiMs: 120000 },
    );
    const retry = mergeTaskActivity(
      first.notes,
      first.timeSpentOnDay,
      'mac',
      '2026-09-07',
      { humanMs: 60000, aiMs: 120000 },
    );
    expect(retry).toEqual(first);
    expect(retry.timeSpentOnDay['2026-09-07']).toBe(65000);
    expect(readTaskActivity(retry.notes)['mac/2026-09-07'].aiMs).toBe(120000);
  });
  it('supports corrections and independent days and sources', () => {
    const first = mergeTaskActivity('', {}, 'mac', '2026-09-07', {
      humanMs: 60000,
      aiMs: 120000,
    });
    const corrected = mergeTaskActivity(
      first.notes,
      first.timeSpentOnDay,
      'mac',
      '2026-09-07',
      { humanMs: 30000, aiMs: 120000 },
    );
    const second = mergeTaskActivity(
      corrected.notes,
      corrected.timeSpentOnDay,
      'laptop',
      '2026-09-07',
      { humanMs: 10000, aiMs: 50000 },
    );
    expect(second.timeSpentOnDay['2026-09-07']).toBe(40000);
    expect(sumTaskActivity(second.notes)).toEqual({ humanMs: 40000, aiMs: 170000 });
  });
  it('rejects corrupted receipts and invalid totals without resetting history', () => {
    expect(() => readTaskActivity('<!-- sp-activity-v1:broken -->')).toThrow();
    expect(() =>
      mergeTaskActivity('', {}, 'mac', '2026-02-31', { humanMs: 1, aiMs: 2 }),
    ).toThrow();
    expect(() =>
      mergeTaskActivity('', {}, 'mac', '2026-09-07', { humanMs: -1, aiMs: 2 }),
    ).toThrow();
  });
});
