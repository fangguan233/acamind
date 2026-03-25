import {
  IMessageElement,
  IMode,
  IStep,
  ITasklistElement,
  addMessage,
  hasMessageById,
  updateMessageById
} from '@chainlit/react-client';
import isEqual from 'lodash/isEqual';

export const ACTIVE_DEEP_RESEARCH_STATUSES = new Set([
  'queued',
  'running',
  'cancel_requested'
]);
export const DEEP_RESEARCH_SYNC_EVENT = 'deep-research-sync';

export const INITIAL_RESEARCH_MISS_LIMIT = 8;
export const ACTIVE_RESEARCH_MISS_LIMIT = 20;

export type DeepResearchThreadMetadata = {
  deep_research?: {
    job_id?: string;
    status?: string;
    active_mode?: string;
  };
};

export type DeepResearchThreadSnapshot = {
  job?: {
    job_id?: string;
    status?: string;
    phase?: string;
    round?: number;
    waiting_kind?: string;
  } | null;
  messages?: IStep[];
  elements?: IMessageElement[];
  tasklist?: ITasklistElement | null;
  pdf_refs?: Array<Record<string, any>>;
  upload_requests?: Array<Record<string, any>>;
  clarification_requests?: Array<Record<string, any>>;
  research_card?: Record<string, any> | null;
  thread_metadata?: DeepResearchThreadMetadata;
};

export type ResearchSyncOutcome = 'missing' | 'active' | 'terminal';

export const getNextResearchPollingState = ({
  hadJob,
  missCount,
  outcome
}: {
  hadJob: boolean;
  missCount: number;
  outcome: ResearchSyncOutcome;
}): {
  hadJob: boolean;
  missCount: number;
  shouldPoll: boolean;
} => {
  if (outcome === 'active') {
    return { hadJob: true, missCount: 0, shouldPoll: true };
  }
  if (outcome === 'terminal') {
    return { hadJob: true, missCount: 0, shouldPoll: false };
  }
  const nextMissCount = missCount + 1;
  if (hadJob) {
    return {
      hadJob: true,
      missCount: nextMissCount,
      shouldPoll: nextMissCount < ACTIVE_RESEARCH_MISS_LIMIT
    };
  }
  return {
    hadJob: false,
    missCount: nextMissCount,
    shouldPoll: nextMissCount < INITIAL_RESEARCH_MISS_LIMIT
  };
};

export const mergeResearchMessages = (
  current: IStep[],
  incoming: IStep[]
): IStep[] => {
  let next = [...current];
  let changed = false;
  incoming.forEach((message) => {
    if (!message?.id) return;
    if (hasMessageById(next, message.id)) {
      const existing = findMessageById(next, message.id);
      if (existing && isEqual(existing, message)) {
        return;
      }
      next = updateMessageById(next, message.id, message);
      changed = true;
    } else {
      next = addMessage(next, message);
      changed = true;
    }
  });
  return changed ? next : current;
};

export const mergeResearchTasklists = (
  current: ITasklistElement[],
  incoming?: ITasklistElement | null
): ITasklistElement[] => {
  if (!incoming?.id) return current;
  const index = current.findIndex((item) => item.id === incoming.id);
  if (index < 0) {
    return [...current, incoming];
  }
  if (isEqual(current[index], incoming)) {
    return current;
  }
  const next = [...current];
  next[index] = { ...next[index], ...incoming };
  return next;
};

export const mergeResearchElements = (
  current: IMessageElement[],
  incoming: IMessageElement[]
): IMessageElement[] => {
  let next = [...current];
  let changed = false;
  incoming.forEach((element) => {
    if (!element?.id) return;
    const index = next.findIndex((item) => item.id === element.id);
    if (index < 0) {
      next.push(element);
      changed = true;
      return;
    }
    if (isEqual(next[index], element)) {
      return;
    }
    next[index] = { ...next[index], ...element };
    changed = true;
  });
  return changed ? next : current;
};

export const applyModeSelection = (
  modes: IMode[],
  modeId: string,
  optionId: string
): IMode[] => {
  let changed = false;
  const nextModes = modes.map((mode) => {
    if (mode.id !== modeId) return mode;
    const alreadySelected = mode.options.some(
      (option) => option.id === optionId && option.default
    );
    if (alreadySelected) {
      return mode;
    }
    changed = true;
    return {
      ...mode,
      options: mode.options.map((option) => ({
        ...option,
        default: option.id === optionId
      }))
    };
  });
  return changed ? nextModes : modes;
};

export const shouldRestoreDeepResearchMode = (
  metadata?: DeepResearchThreadMetadata | Record<string, any> | null
): boolean => {
  const research = metadata?.deep_research;
  if (!research || typeof research !== 'object') return false;
  const activeMode = typeof research.active_mode === 'string' ? research.active_mode : '';
  const status = typeof research.status === 'string' ? research.status : '';
  return (
    activeMode === 'deep_research' || ACTIVE_DEEP_RESEARCH_STATUSES.has(status)
  );
};

export const mergeThreadMetadata = (
  current?: Record<string, any>,
  incoming?: Record<string, any>
): Record<string, any> => {
  const merged = {
    ...(current || {}),
    ...(incoming || {}),
    deep_research: {
      ...(current?.deep_research || {}),
      ...(incoming?.deep_research || {})
    }
  };
  return isEqual(current || {}, merged) ? current || merged : merged;
};

const findMessageById = (
  messages: IStep[],
  id: string
): IStep | undefined => {
  for (const message of messages) {
    if (message.id === id) return message;
    const steps = (message as any)?.steps;
    if (Array.isArray(steps)) {
      const nested = findMessageById(steps as IStep[], id);
      if (nested) return nested;
    }
  }
  return undefined;
};
