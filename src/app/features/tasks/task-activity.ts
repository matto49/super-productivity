/** Cumulative observation imports live in ordinary notes for older-client compatibility. */
export interface TaskActivityDay {
  humanMs: number;
  aiMs: number;
}
export const IN_PROGRESS_TAG_ID = 'KANBAN_IN_PROGRESS';
export const REVIEW_TAG_ID = 'MATTO_REVIEW';
export const WAITING_TAG_ID = 'MATTO_WAITING';
const PREFIX = '<!-- sp-activity-v1:';
const SUFFIX = ' -->';
export type TaskActivityLedger = Record<string, TaskActivityDay>;

export const readTaskActivity = (notes: string = ''): TaskActivityLedger => {
  const start = notes.indexOf(PREFIX);
  if (start < 0) return {};
  const end = notes.indexOf(SUFFIX, start);
  if (end < 0) throw new Error('Invalid activity ledger');
  const value: unknown = JSON.parse(notes.slice(start + PREFIX.length, end));
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid activity ledger');
  const ledger: TaskActivityLedger = {};
  for (const [key, day] of Object.entries(value)) {
    if (
      !/^[a-zA-Z0-9_-]{1,64}\/\d{4}-\d{2}-\d{2}$/.test(key) ||
      !day ||
      typeof day !== 'object' ||
      !Number.isSafeInteger(day.humanMs) ||
      day.humanMs < 0 ||
      day.humanMs > 86400000 ||
      !Number.isSafeInteger(day.aiMs) ||
      day.aiMs < 0 ||
      day.aiMs > 86400000 * 100
    )
      throw new Error('Invalid activity ledger');
    ledger[key] = { humanMs: day.humanMs, aiMs: day.aiMs };
  }
  return ledger;
};

/** Aggregates receipt totals without conflating AI elapsed with native task time. */
export const sumTaskActivity = (notes: string = ''): TaskActivityDay =>
  Object.values(readTaskActivity(notes)).reduce(
    (total, day) => ({
      humanMs: total.humanMs + day.humanMs,
      aiMs: total.aiMs + day.aiMs,
    }),
    { humanMs: 0, aiMs: 0 },
  );

export const mergeTaskActivity = (
  notes: string,
  timeSpentOnDay: Record<string, number>,
  source: string,
  date: string,
  totals: TaskActivityDay,
): { notes: string; timeSpentOnDay: Record<string, number> } => {
  // Reuse the same validator for both the request and stored data.
  const key = `${source}/${date}`;
  readTaskActivity(`${PREFIX}${JSON.stringify({ [key]: totals })}${SUFFIX}`);
  if (new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date)
    throw new Error('Invalid activity date');
  const ledger = readTaskActivity(notes);
  const previous = ledger[key]?.humanMs || 0;
  ledger[key] = totals;
  const start = notes.indexOf(PREFIX);
  const cleanNotes =
    start < 0
      ? notes
      : notes.slice(0, start) + notes.slice(notes.indexOf(SUFFIX, start) + SUFFIX.length);
  return {
    notes:
      `${cleanNotes.trimEnd()}\n\n${PREFIX}${JSON.stringify(ledger)}${SUFFIX}`.trim(),
    timeSpentOnDay: {
      ...timeSpentOnDay,
      [date]: Math.max(0, (timeSpentOnDay[date] || 0) + totals.humanMs - previous),
    },
  };
};
