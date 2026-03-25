import { uniqBy } from 'lodash';
import { useContext, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useRecoilState } from 'recoil';

import {
  ChainlitContext,
  threadHistoryState,
  useChatMessages,
  useConfig
} from '@chainlit/react-client';

import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu
} from '@/components/ui/sidebar';

import { ThreadList } from './ThreadList';
import {
  loadLocalThreadHistory,
  toThreadHistoryState
} from '@/lib/localThreadHistory';

const BATCH_SIZE = 35;
let _scrollTop = 0;

export function ThreadHistory() {
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);
  const apiClient = useContext(ChainlitContext);
  const { firstInteraction, messages, threadId } = useChatMessages();
  const { config } = useConfig();
  const [threadHistory, setThreadHistory] = useRecoilState(threadHistoryState);
  const [error, setError] = useState<string>();
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isFetching, setIsFetching] = useState(false);
  const [shouldLoadMore, setShouldLoadMore] = useState(false);
  const [hasHydratedInitialHistory, setHasHydratedInitialHistory] = useState(
    Boolean(threadHistory?.threads)
  );

  // Restore scroll position
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = _scrollTop;
    }
  }, []);

  const localHistoryEnabled = !config?.dataPersistence;

  useEffect(() => {
    if (threadHistory?.threads) {
      setHasHydratedInitialHistory(true);
    }
  }, [threadHistory?.threads]);

  useEffect(() => {
    if (error) {
      setHasHydratedInitialHistory(true);
    }
  }, [error]);

  // Handle first interaction
  useEffect(() => {
    const handleFirstInteraction = async () => {
      if (!firstInteraction) return;

      const isActualResume =
        firstInteraction === 'resume' &&
        messages[0]?.output.toLowerCase() !== 'resume';

      if (isActualResume) return;

      if (!localHistoryEnabled) {
        await fetchThreads(undefined, true);
      }

      const currentPage = new URL(window.location.href);
      if (threadId && currentPage.pathname === '/') {
        navigate(`/thread/${threadId}`);
      }
    };

    handleFirstInteraction();
  }, [firstInteraction]);

  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollHeight, clientHeight, scrollTop } = scrollRef.current;
    const atBottom = scrollTop + clientHeight >= scrollHeight - 10;

    _scrollTop = scrollTop;
    setShouldLoadMore(atBottom);
  };

  const fetchThreads = async (
    cursor?: string | number,
    isLoadingMore = false
  ) => {
    if (localHistoryEnabled) return;
    try {
      setIsLoadingMore(!!cursor || isLoadingMore);
      setIsFetching(!cursor && !isLoadingMore);

      const { pageInfo, data } = await apiClient.listThreads(
        { first: BATCH_SIZE, cursor },
        {}
      );

      setError(undefined);

      // Prevent duplicate threads
      const allThreads = uniqBy(
        cursor ? threadHistory?.threads?.concat(data) : data,
        'id'
      );

      if (allThreads) {
        setThreadHistory((prev) => ({
          ...prev,
          pageInfo,
          threads: allThreads
        }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error occurred');
    } finally {
      if (!cursor) {
        setHasHydratedInitialHistory(true);
      }
      setShouldLoadMore(false);
      setIsLoadingMore(false);
      setIsFetching(false);
    }
  };

  // Initial fetch
  useEffect(() => {
    if (localHistoryEnabled) return;
    if (!isFetching && !threadHistory?.threads && !error) {
      fetchThreads();
    }
  }, [isFetching, threadHistory, error, localHistoryEnabled]);

  // Handle infinite scroll
  useEffect(() => {
    if (localHistoryEnabled) return;
    if (threadHistory?.pageInfo) {
      const { hasNextPage, endCursor } = threadHistory.pageInfo;

      if (shouldLoadMore && !isLoadingMore && hasNextPage && endCursor) {
        fetchThreads(endCursor);
      }
    }
  }, [shouldLoadMore, isLoadingMore, threadHistory, localHistoryEnabled]);

  useEffect(() => {
    if (!localHistoryEnabled) return;
    const localHistory = loadLocalThreadHistory();
    setThreadHistory((prev) => ({
      ...prev,
      ...toThreadHistoryState(localHistory)
    }));
    setHasHydratedInitialHistory(true);
  }, [localHistoryEnabled]);

  return (
    <SidebarContent onScroll={handleScroll} ref={scrollRef}>
      <SidebarGroup>
        <SidebarMenu>
          {threadHistory ? (
            <div id="thread-history" className="flex-grow">
              <ThreadList
                threadHistory={threadHistory}
                error={error}
                hasHydratedInitialHistory={hasHydratedInitialHistory}
                isFetching={isFetching}
                isLoadingMore={isLoadingMore}
              />
            </div>
          ) : null}
        </SidebarMenu>
      </SidebarGroup>
    </SidebarContent>
  );
}
