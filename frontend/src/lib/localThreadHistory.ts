import { IThread, IStep, ThreadHistory } from '@chainlit/react-client';

export type LocalThread = IThread & {
  updatedAt?: number;
};

export type LocalThreadHistory = {
  threads: LocalThread[];
  currentThreadId?: string;
};

const STORAGE_KEY = 'chainlit_local_thread_history_v1';

const groupLocalThreadsByDate = (threads: LocalThread[]) => {
  const grouped: Record<string, LocalThread[]> = {};
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  [...threads]
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )
    .forEach((thread) => {
      const threadDate = new Date(thread.createdAt);
      threadDate.setHours(0, 0, 0, 0);

      const daysDiff = Math.floor(
        (today.getTime() - threadDate.getTime()) / 86400000
      );

      let category: string;
      if (daysDiff === 0) {
        category = 'Today';
      } else if (daysDiff === 1) {
        category = 'Yesterday';
      } else if (daysDiff <= 7) {
        category = 'Previous 7 days';
      } else if (daysDiff <= 30) {
        category = 'Previous 30 days';
      } else {
        category = threadDate.toLocaleString('default', {
          month: 'long',
          year: 'numeric'
        });
      }

      grouped[category] ??= [];
      grouped[category].push(thread);
    });

  return grouped;
};

const normalizeHistory = (value: any): LocalThreadHistory => {
  if (!value || !Array.isArray(value.threads)) {
    return { threads: [] };
  }
  return {
    threads: value.threads as LocalThread[],
    currentThreadId:
      typeof value.currentThreadId === 'string'
        ? value.currentThreadId
        : undefined
  };
};

export const loadLocalThreadHistory = (): LocalThreadHistory => {
  if (typeof window === 'undefined') return { threads: [] };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { threads: [] };
    return normalizeHistory(JSON.parse(raw));
  } catch {
    return { threads: [] };
  }
};

export const saveLocalThreadHistory = (history: LocalThreadHistory) => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
};

export const toThreadHistoryState = (
  history: LocalThreadHistory
): ThreadHistory => ({
  threads: history.threads,
  currentThreadId: history.currentThreadId,
  timeGroupedThreads: groupLocalThreadsByDate(history.threads),
  pageInfo: undefined
});

export const getLocalThread = (threadId: string): LocalThread | undefined => {
  const history = loadLocalThreadHistory();
  return history.threads.find((thread) => thread.id === threadId);
};

export const upsertLocalThread = (thread: {
  id: string;
  name?: string;
  createdAt?: number | string;
  steps: IStep[];
  metadata?: Record<string, any>;
  elements?: IThread['elements'];
}): LocalThreadHistory => {
  const history = loadLocalThreadHistory();
  const now = Date.now();
  const existingIndex = history.threads.findIndex((t) => t.id === thread.id);
  const existing = existingIndex >= 0 ? history.threads[existingIndex] : undefined;
  const createdAt = thread.createdAt ?? existing?.createdAt ?? now;

  const updated: LocalThread = {
    id: thread.id,
    createdAt,
    updatedAt: now,
    name: thread.name ?? existing?.name,
    steps: thread.steps ?? existing?.steps ?? [],
    elements: thread.elements ?? existing?.elements ?? [],
    metadata: { ...(existing?.metadata || {}), ...(thread.metadata || {}) }
  };

  const nextThreads =
    existingIndex >= 0
      ? history.threads.map((t, idx) => (idx === existingIndex ? updated : t))
      : [updated, ...history.threads];

  const nextHistory: LocalThreadHistory = {
    threads: nextThreads,
    currentThreadId: thread.id
  };

  saveLocalThreadHistory(nextHistory);
  return nextHistory;
};

export const renameLocalThread = (
  threadId: string,
  name: string
): LocalThreadHistory => {
  const history = loadLocalThreadHistory();
  const nextThreads = history.threads.map((thread) =>
    thread.id === threadId ? { ...thread, name, updatedAt: Date.now() } : thread
  );
  const nextHistory: LocalThreadHistory = {
    ...history,
    threads: nextThreads
  };
  saveLocalThreadHistory(nextHistory);
  return nextHistory;
};

export const deleteLocalThread = (threadId: string): LocalThreadHistory => {
  const history = loadLocalThreadHistory();
  const nextThreads = history.threads.filter((t) => t.id !== threadId);
  const nextHistory: LocalThreadHistory = {
    threads: nextThreads,
    currentThreadId:
      history.currentThreadId === threadId
        ? nextThreads[0]?.id
        : history.currentThreadId
  };
  saveLocalThreadHistory(nextHistory);
  return nextHistory;
};

export const clearLocalThreadHistory = (): LocalThreadHistory => {
  const nextHistory: LocalThreadHistory = {
    threads: [],
    currentThreadId: undefined
  };
  saveLocalThreadHistory(nextHistory);
  return nextHistory;
};
