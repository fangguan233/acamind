import { useCallback, useContext, useEffect, useRef } from 'react';
import { useRecoilState, useSetRecoilState } from 'recoil';
import isEqual from 'lodash/isEqual';

import {
  ChainlitContext,
  IMessageElement,
  ITasklistElement,
  IStep,
  elementState,
  messagesState,
  modesState,
  tasklistState,
  threadHistoryState
} from '@chainlit/react-client';

import {
  getLocalThread,
  toThreadHistoryState,
  upsertLocalThread
} from '@/lib/localThreadHistory';
import {
  ACTIVE_DEEP_RESEARCH_STATUSES,
  DEEP_RESEARCH_SYNC_EVENT,
  DeepResearchThreadSnapshot,
  applyModeSelection,
  getNextResearchPollingState,
  mergeResearchElements,
  mergeResearchMessages,
  mergeResearchTasklists,
  mergeThreadMetadata,
  shouldRestoreDeepResearchMode
} from '@/lib/deepResearchSync';

type UseDeepResearchSyncOptions = {
  threadId?: string;
  localHistoryEnabled: boolean;
};

const RESEARCH_POLL_INTERVAL_MS = 750;
export function useDeepResearchSync({
  threadId,
  localHistoryEnabled
}: UseDeepResearchSyncOptions) {
  const apiClient = useContext(ChainlitContext);
  const setMessages = useSetRecoilState(messagesState);
  const setElements = useSetRecoilState(elementState);
  const setTasklists = useSetRecoilState(tasklistState);
  const setThreadHistory = useSetRecoilState(threadHistoryState);
  const [modes, setModes] = useRecoilState(modesState);
  const pollingRef = useRef<number | null>(null);
  const hadJobRef = useRef(false);
  const missCountRef = useRef(0);
  const inFlightRef = useRef(false);

  const mergeSnapshot = useCallback(
    (snapshot: DeepResearchThreadSnapshot) => {
      const incomingMessages = Array.isArray(snapshot.messages)
        ? (snapshot.messages as IStep[])
        : [];
      const incomingTasklist =
        snapshot.tasklist && typeof snapshot.tasklist === 'object'
          ? (snapshot.tasklist as ITasklistElement)
          : null;
      const incomingElements = Array.isArray(snapshot.elements)
        ? (snapshot.elements as IMessageElement[])
        : [];
      const incomingMetadata =
        snapshot.thread_metadata && typeof snapshot.thread_metadata === 'object'
          ? snapshot.thread_metadata
          : undefined;

      if (incomingMessages.length > 0) {
        setMessages((prev) => mergeResearchMessages(prev, incomingMessages));
      }
      if (incomingTasklist) {
        setTasklists((prev) => mergeResearchTasklists(prev, incomingTasklist));
      }
      if (incomingElements.length > 0) {
        setElements((prev) => mergeResearchElements(prev as IMessageElement[], incomingElements));
      }

      if (shouldRestoreDeepResearchMode(incomingMetadata)) {
        setModes((prev) => applyModeSelection(prev, 'feature', 'deep_research'));
      }

      if (!localHistoryEnabled || !threadId) return;
      const localThread = getLocalThread(threadId);
      const mergedMessages = mergeResearchMessages(
        (localThread?.steps || []) as IStep[],
        incomingMessages
      );
      const existingElements = (localThread?.elements || []) as unknown as Array<
        IMessageElement | ITasklistElement
      >;
      const tasklistElements = existingElements.filter(
        (element) => (element as any)?.type === 'tasklist'
      ) as ITasklistElement[];
      const nonTasklistElements = existingElements.filter(
        (element) => (element as any)?.type !== 'tasklist'
      ) as IMessageElement[];
      const mergedTasklists = incomingTasklist
        ? mergeResearchTasklists(tasklistElements, incomingTasklist)
        : tasklistElements;
      const mergedElements = mergeResearchElements(
        nonTasklistElements,
        incomingElements
      );
      const mergedMetadata = mergeThreadMetadata(
        localThread?.metadata,
        incomingMetadata
      );
      const hasChanges =
        mergedMessages !== ((localThread?.steps || []) as IStep[]) ||
        mergedTasklists !== tasklistElements ||
        mergedElements !== nonTasklistElements ||
        !isEqual(localThread?.metadata || {}, mergedMetadata || {});
      if (!hasChanges) return;
      const history = upsertLocalThread({
        id: threadId,
        name: localThread?.name,
        steps: mergedMessages,
        elements: [...mergedTasklists, ...mergedElements],
        metadata: mergedMetadata
      });
      setThreadHistory((prev) => ({
        ...prev,
        ...toThreadHistoryState(history)
      }));
    },
    [
      localHistoryEnabled,
      setMessages,
      setElements,
      setModes,
      setTasklists,
      setThreadHistory,
      threadId
    ]
  );

  const syncOnce = useCallback(
    async (): Promise<'missing' | 'active' | 'terminal'> => {
      if (!threadId) return 'missing';
      const endpoint = apiClient.buildEndpoint(`/research/thread/${threadId}`);
      try {
        const response = await fetch(endpoint, { credentials: 'include' });
        if (!response.ok) return 'missing';
        const snapshot = (await response.json()) as DeepResearchThreadSnapshot;
        if (!snapshot?.job) return 'missing';
        mergeSnapshot(snapshot);
        return ['queued', 'running', 'cancel_requested'].includes(
          String(snapshot.job?.status || '')
        )
          ? 'active'
          : 'terminal';
      } catch {
        return 'missing';
      }
    },
    [apiClient, mergeSnapshot, threadId]
  );

  useEffect(() => {
    const stopPolling = () => {
      if (pollingRef.current) {
        window.clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };

    const runSync = async (): Promise<boolean> => {
      if (inFlightRef.current) return true;
      inFlightRef.current = true;
      try {
        const outcome = await syncOnce();
        if (outcome === 'active') {
          hadJobRef.current = true;
          missCountRef.current = 0;
          return true;
        }
        if (outcome === 'terminal') {
          hadJobRef.current = true;
          missCountRef.current = 0;
          stopPolling();
          return false;
        }
        const nextState = getNextResearchPollingState({
          hadJob: hadJobRef.current,
          missCount: missCountRef.current,
          outcome
        });
        hadJobRef.current = nextState.hadJob;
        missCountRef.current = nextState.missCount;
        if (!nextState.shouldPoll) {
          stopPolling();
        }
        return nextState.shouldPoll;
      } finally {
        inFlightRef.current = false;
      }
    };

    const startPolling = () => {
      if (pollingRef.current) return;
      pollingRef.current = window.setInterval(() => {
        void runSync();
      }, RESEARCH_POLL_INTERVAL_MS);
    };

    if (pollingRef.current) {
      window.clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
    hadJobRef.current = false;
    missCountRef.current = 0;
    inFlightRef.current = false;
    if (!threadId) return;

    const handleSyncEvent = (event: Event) => {
      const detail = (event as CustomEvent<{
        snapshot?: DeepResearchThreadSnapshot;
        forcePolling?: boolean;
      }>).detail;
      const snapshot = detail?.snapshot;
      if (snapshot?.job) {
        mergeSnapshot(snapshot);
      }
      const shouldForcePolling =
        Boolean(detail?.forcePolling) ||
        ACTIVE_DEEP_RESEARCH_STATUSES.has(String(snapshot?.job?.status || ''));
      if (!shouldForcePolling) {
        return;
      }
      hadJobRef.current = true;
      missCountRef.current = 0;
      if (!pollingRef.current) {
        startPolling();
      }
    };
    window.addEventListener(DEEP_RESEARCH_SYNC_EVENT, handleSyncEvent as EventListener);

    let cancelled = false;
    void runSync().then((shouldPoll) => {
      if (cancelled || !shouldPoll || pollingRef.current) return;
      startPolling();
    });

    return () => {
      cancelled = true;
      window.removeEventListener(DEEP_RESEARCH_SYNC_EVENT, handleSyncEvent as EventListener);
      stopPolling();
      hadJobRef.current = false;
      missCountRef.current = 0;
      inFlightRef.current = false;
    };
  }, [syncOnce, threadId]);

  useEffect(() => {
    if (!shouldRestoreDeepResearchMode(getLocalThread(threadId || '')?.metadata)) {
      return;
    }
    if (!modes.length) return;
    setModes((prev) => applyModeSelection(prev, 'feature', 'deep_research'));
  }, [modes.length, setModes, threadId]);
}
