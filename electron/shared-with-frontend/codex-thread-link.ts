// Only navigation to an existing thread. Never accept prompt/command parameters.
const THREAD_LINK =
  /^codex:\/\/threads\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?:\?hostId=([A-Za-z0-9_.%-]+))?$/i;

export const isCodexThreadLink = (value: unknown): value is string => {
  if (typeof value !== 'string' || value !== value.trim()) return false;
  const match = THREAD_LINK.exec(value);
  if (!match) return false;
  if (!match[1]) return true;
  try {
    const hostId = decodeURIComponent(match[1]);
    return (
      /^[A-Za-z0-9_.:-]{1,128}$/.test(hostId) && encodeURIComponent(hostId) === match[1]
    );
  } catch {
    return false;
  }
};

export const getCodexThreadLink = (notes: string = ''): string | undefined => {
  const association = getCodexAssociation(notes);
  if (association) return association.threadUrl;
  for (const match of Array.from(
    notes.matchAll(/\[[^\]\n]*\]\((codex:\/\/[^\s)]+)\)/gi),
  )) {
    if (isCodexThreadLink(match[1])) return match[1];
  }
  return undefined;
};

export interface CodexAssociationSummary {
  threadUrl: string;
  threadCount: number;
  status: 'needs_scope' | 'not_collected' | 'missing' | 'collected';
  checkedAt: string;
  since: string;
  humanStatus: string;
}

export const getCodexAssociation = (
  notes: string = '',
): CodexAssociationSummary | undefined => {
  const match = notes.match(/<!-- sp-codex-v1:(.*?) -->/);
  if (!match) return undefined;
  try {
    const value: unknown = JSON.parse(match[1]);
    if (!value || typeof value !== 'object') return undefined;
    const entry = value as Record<string, unknown>;
    if (
      !isCodexThreadLink(entry.threadUrl) ||
      !Number.isSafeInteger(entry.threadCount) ||
      (entry.threadCount as number) < 1 ||
      !['needs_scope', 'not_collected', 'missing', 'collected'].includes(
        String(entry.status),
      ) ||
      typeof entry.checkedAt !== 'string' ||
      !Number.isFinite(Date.parse(entry.checkedAt)) ||
      typeof entry.since !== 'string' ||
      !Number.isFinite(Date.parse(entry.since)) ||
      typeof entry.humanStatus !== 'string'
    )
      return undefined;
    return entry as unknown as CodexAssociationSummary;
  } catch {
    return undefined;
  }
};
