import { useEffect, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { useSetRecoilState } from 'recoil';

import Page from 'pages/Page';

import {
  actionState,
  currentThreadIdState,
  elementState,
  messagesState,
  tasklistState,
  useChatMessages,
  useChatSession,
  useConfig
} from '@chainlit/react-client';

import AutoResumeThread from '@/components/AutoResumeThread';
import { Loader } from '@/components/Loader';
import { ReadOnlyThread } from '@/components/ReadOnlyThread';
import Chat from '@/components/chat';
import {
  getLocalThread,
  loadLocalThreadHistory,
  saveLocalThreadHistory
} from '@/lib/localThreadHistory';

export default function ThreadPage() {
  const { id } = useParams();
  const location = useLocation();
  const { config } = useConfig();
  const localHistoryEnabled = !config?.dataPersistence;

  const setMessages = useSetRecoilState(messagesState);
  const setElements = useSetRecoilState(elementState);
  const setTasklists = useSetRecoilState(tasklistState);
  const setActions = useSetRecoilState(actionState);
  const setCurrentThreadId = useSetRecoilState(currentThreadIdState);

  const { threadId } = useChatMessages();
  const { session } = useChatSession();
  const [isHydratingLocalSession, setIsHydratingLocalSession] = useState(
    localHistoryEnabled && Boolean(id)
  );

  const isCurrentThread = threadId === id;

  useEffect(() => {
    if (!localHistoryEnabled || !id) return;
    const history = loadLocalThreadHistory();
    if (history.currentThreadId !== id) {
      saveLocalThreadHistory({ ...history, currentThreadId: id });
    }
    const thread = getLocalThread(id);
    if (thread?.steps) {
      setMessages(thread.steps);
    }
    const elements = thread?.elements || [];
    setTasklists(
      elements.filter((e) => (e as any)?.type === 'tasklist') as any
    );
    setElements(
      elements.filter(
        (e) => (e as any)?.type !== 'tasklist' && (e as any)?.type !== 'avatar'
      ) as any
    );
    setActions([]);
    setCurrentThreadId(id);
  }, [id, localHistoryEnabled]);

  useEffect(() => {
    if (!localHistoryEnabled || !id) {
      setIsHydratingLocalSession(false);
      return;
    }
    setIsHydratingLocalSession(true);
    if (!session?.socket) return;
    const thread = getLocalThread(id);
    if (!thread) {
      setIsHydratingLocalSession(false);
      return;
    }
    session.socket.emit(
      'hydrate_local_thread',
      thread,
      (response?: { ok?: boolean }) => {
        setIsHydratingLocalSession(false);
        if (response?.ok === false) {
          console.error('Failed to hydrate local thread context.');
        }
      }
    );
  }, [id, localHistoryEnabled, session?.socket]);

  const isSharedRoute = location.pathname.startsWith('/share/');

  if (localHistoryEnabled) {
    return (
      <Page>
        {isHydratingLocalSession ? (
          <div className="flex flex-grow items-center justify-center">
            <Loader className="!size-6" />
          </div>
        ) : (
          <Chat />
        )}
      </Page>
    );
  }

  return (
    <Page>
      <>
        {isSharedRoute ? <ReadOnlyThread id={id!} /> : null}
        {config?.threadResumable && !isCurrentThread && !isSharedRoute ? (
          <AutoResumeThread id={id!} />
        ) : null}
        {config?.threadResumable && !isSharedRoute ? (
          isCurrentThread ? (
            <Chat />
          ) : (
            <div className="flex flex-grow items-center justify-center">
              <Loader className="!size-6" />
            </div>
          )
        ) : null}
        {config && !config.threadResumable && !isSharedRoute ? (
          isCurrentThread ? (
            <Chat />
          ) : (
            <ReadOnlyThread id={id!} />
          )
        ) : null}
      </>
    </Page>
  );
}
