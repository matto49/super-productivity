export interface TaskPlan {
  taskId?: string;
  title: string;
  date?: string;
  time?: string;
  projectId?: string;
  reason: string;
}
export interface PlanningReply {
  plans: TaskPlan[];
  error?: string;
  explicit?: boolean;
}

// Model output is data. Reject invalid dates, unknown tasks and impossible times.
export const validatePlans = (
  value: unknown,
  ids: string[],
  projects: string[],
): TaskPlan[] => {
  if (!Array.isArray(value) || value.length > 12) throw new Error('Invalid plans');
  const seen = new Set<string>();
  return value.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid plan');
    const p = raw as Record<string, unknown>;
    if (
      typeof p.title !== 'string' ||
      !p.title.trim() ||
      p.title.length > 1000 ||
      typeof p.reason !== 'string' ||
      p.reason.length > 500
    )
      throw new Error('Invalid plan fields');
    if (
      p.taskId != null &&
      (typeof p.taskId !== 'string' || !ids.includes(p.taskId) || seen.has(p.taskId))
    )
      throw new Error('Unknown or repeated task');
    if (typeof p.taskId === 'string') seen.add(p.taskId);
    if (
      p.projectId != null &&
      (typeof p.projectId !== 'string' || !projects.includes(p.projectId))
    )
      throw new Error('Unknown project');
    if (
      p.date != null &&
      (typeof p.date !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(p.date) ||
        !Number.isFinite(Date.parse(p.date)) ||
        new Date(p.date).toISOString().slice(0, 10) !== p.date)
    )
      throw new Error('Invalid date');
    if (
      p.time != null &&
      (!p.date || typeof p.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(p.time))
    )
      throw new Error('Invalid time');
    return {
      title: p.title.trim(),
      reason: p.reason,
      ...(typeof p.taskId === 'string' ? { taskId: p.taskId } : {}),
      ...(typeof p.projectId === 'string' ? { projectId: p.projectId } : {}),
      ...(typeof p.date === 'string' ? { date: p.date } : {}),
      ...(typeof p.time === 'string' ? { time: p.time } : {}),
    };
  });
};

// Only explicit capture syntax is applied automatically. Ambiguity goes to preview.
export const explicitCapture = (text: string, now: Date): TaskPlan | undefined => {
  const match = text
    .trim()
    .match(
      /^(今天|明天)\s*(?:(上午|下午|晚上)?\s*(\d{1,2})(?::(\d{2})|点(?:(\d{1,2})分)?)\s*)?(.+?)[，,\s]+(?:预计|估计|大约|需要)?\s*(\d+)\s*(分钟|小时)[。.]?$/,
    );
  if (!match || /截止|之前|以前|最晚|不要|不做|取消|可能|或|提醒/.test(text))
    return undefined;
  const [, day, period, hour, minuteA, minuteB, title] = match;
  let time: string | undefined;
  if (hour) {
    let h = Number(hour);
    if (period && (h < 1 || h > 12)) return undefined;
    if ((period === '下午' || period === '晚上') && h < 12) h += 12;
    if (period === '上午' && h === 12) h = 0;
    const m = Number(minuteA || minuteB || 0);
    if (h > 23 || m > 59) return undefined;
    time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  const date = new Date(now);
  date.setDate(date.getDate() + (day === '明天' ? 1 : 0));
  const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  if (time && new Date(`${dateStr}T${time}:00`).getTime() < now.getTime())
    return undefined;
  return {
    title: title.trim(),
    date: dateStr,
    time,
    reason: 'explicit',
  };
};
