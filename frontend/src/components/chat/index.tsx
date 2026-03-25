import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSetRecoilState } from 'recoil';
import { toast } from 'sonner';
import { v4 as uuidv4 } from 'uuid';

import {
  threadHistoryState,
  useChatData,
  useChatInteract,
  useChatMessages,
  useConfig
} from '@chainlit/react-client';

import Alert from '@/components/Alert';
import { TaskList } from '@/components/Tasklist';
import { Translator } from 'components/i18n';
import { useTranslation } from 'components/i18n/Translator';

import { useDeepResearchSync } from '@/hooks/useDeepResearchSync';
import { useUpload } from '@/hooks/useUpload';
import { useLayoutMaxWidth } from 'hooks/useLayoutMaxWidth';

import { IAttachment, attachmentsState } from 'state/chat';
import {
  toThreadHistoryState,
  upsertLocalThread
} from '@/lib/localThreadHistory';

import { ErrorBoundary } from '../ErrorBoundary';
import ChatFooter from './Footer';
import MessagesContainer from './MessagesContainer';
import ScrollContainer from './ScrollContainer';
import WelcomeScreen from './WelcomeScreen';
import { LatestOutputShelf } from './LatestOutputShelf';

const Chat = () => {
  const { config } = useConfig();
  const localHistoryEnabled = !config?.dataPersistence;
  const setAttachments = useSetRecoilState(attachmentsState);
  const setThreads = useSetRecoilState(threadHistoryState);

  const autoScrollRef = useRef(true);
  const { error, disabled, callFn, elements, tasklists } = useChatData();
  const { uploadFile } = useChatInteract();
  const uploadFileRef = useRef(uploadFile);
  const navigate = useNavigate();
  const location = useLocation();

  // Update file upload MIME types to use standard format following Mozilla's guidelines: @see https://developer.mozilla.org/en-US/docs/Web/HTML/Element/input/file#unique_file_type_specifiers
  // Instead of using '*/*' which may cause MIME type warnings, we specify exact MIME type categories:
  // - 'application/*' - for general files
  // - 'audio/*' - for audio files
  // - 'image/*' - for image files
  // - 'text/*' - for text files
  // - 'video/*' - for video files
  // This provides better type safety and clearer file type expectations.
  const fileSpec = useMemo(
    () => ({
      max_size_mb:
        config?.features?.spontaneous_file_upload?.max_size_mb || 500,
      max_files: config?.features?.spontaneous_file_upload?.max_files || 20,
      accept: config?.features?.spontaneous_file_upload?.accept || {
        'application/*': [], // All application files
        'audio/*': [], // All audio files
        'image/*': [], // All image files
        'text/*': [], // All text files
        'video/*': [] // All video files
      }
    }),
    [config]
  );

  const { t } = useTranslation();
  const layoutMaxWidth = useLayoutMaxWidth();

  useEffect(() => {
    if (callFn) {
      const event = new CustomEvent('chainlit-call-fn', {
        detail: callFn
      });
      window.dispatchEvent(event);
    }
  }, [callFn]);

  useEffect(() => {
    uploadFileRef.current = uploadFile;
  }, [uploadFile]);

  const onFileUpload = useCallback(
    (payloads: File[]) => {
      const attachements: IAttachment[] = payloads.map((file) => {
        const id = uuidv4();

        const { xhr, promise } = uploadFileRef.current(file, (progress) => {
          setAttachments((prev) =>
            prev.map((attachment) => {
              if (attachment.id === id) {
                return {
                  ...attachment,
                  uploadProgress: progress
                };
              }
              return attachment;
            })
          );
        });

        promise
          .then((res) => {
            setAttachments((prev) =>
              prev.map((attachment) => {
                if (attachment.id === id) {
                  return {
                    ...attachment,
                    // Update with the server ID
                    serverId: res.id,
                    uploaded: true,
                    uploadProgress: 100,
                    cancel: undefined
                  };
                }
                return attachment;
              })
            );
          })
          .catch((error) => {
            toast.error(
              `${t('chat.fileUpload.errors.failed')} ${file.name}: ${
                typeof error === 'object' && error !== null
                  ? error.message ?? error
                  : error
              }`
            );
            setAttachments((prev) =>
              prev.filter((attachment) => attachment.id !== id)
            );
          });

        return {
          id,
          type: file.type,
          name: file.name,
          size: file.size,
          uploadProgress: 0,
          cancel: () => {
            toast.info(`${t('chat.fileUpload.errors.cancelled')} ${file.name}`);
            xhr.abort();
            setAttachments((prev) =>
              prev.filter((attachment) => attachment.id !== id)
            );
          },
          remove: () => {
            setAttachments((prev) =>
              prev.filter((attachment) => attachment.id !== id)
            );
          }
        };
      });
      setAttachments((prev) => prev.concat(attachements));
    },
    [uploadFile]
  );

  const onFileUploadError = useCallback(
    (error: string) => toast.error(error),
    [toast]
  );

  const upload = useUpload({
    spec: fileSpec,
    onResolved: onFileUpload,
    onError: onFileUploadError,
    options: { noClick: true }
  });

  const { threadId, messages } = useChatMessages();
  const combinedElements = useMemo(
    () => [...(tasklists || []), ...(elements || [])],
    [elements, tasklists]
  );
  const saveTimeoutRef = useRef<number | null>(null);
  const routeThreadId = useMemo(() => {
    const match = location.pathname.match(/^\/thread\/([^/?#]+)/);
    return match?.[1] ? decodeURIComponent(match[1]) : undefined;
  }, [location.pathname]);
  const localHistoryThreadId = localHistoryEnabled
    ? routeThreadId || threadId
    : threadId;
  useDeepResearchSync({
    threadId: localHistoryThreadId,
    localHistoryEnabled
  });

  useEffect(() => {
    if (threadId && location.pathname === '/' && !localHistoryEnabled) {
      navigate(`/thread/${threadId}`);
    }
  }, [
    localHistoryEnabled,
    location.pathname,
    navigate,
    threadId
  ]);

  useEffect(() => {
    if (!localHistoryEnabled) return;
    if (!localHistoryThreadId) return;
    if (!messages.length) return;

    if (saveTimeoutRef.current) {
      window.clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = window.setTimeout(() => {
      const firstUserMessage = messages.find(
        (m) => m.type === 'user_message' && m.output
      );
      const name = firstUserMessage?.output
        ?.replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);

      const history = upsertLocalThread({
        id: localHistoryThreadId,
        name,
        steps: messages,
        elements: combinedElements
      });

      setThreads((prev) => ({
        ...prev,
        ...toThreadHistoryState(history)
      }));
    }, 400);

    return () => {
      if (saveTimeoutRef.current) {
        window.clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [
    localHistoryEnabled,
    localHistoryThreadId,
    messages,
    combinedElements,
    setThreads
  ]);

  const enableAttachments =
    !disabled && config?.features?.spontaneous_file_upload?.enabled;
  return (
    <div
      {...(enableAttachments
        ? upload.getRootProps({ className: 'dropzone' })
        : {})}
      // Disable the onFocus and onBlur events in react-dropzone to avoid interfering with child trigger events
      onBlur={undefined}
      onFocus={undefined}
      className="flex w-full h-full flex-col relative"
    >
      {enableAttachments ? (
        <input id="#upload-drop-input" {...upload.getInputProps()} />
      ) : null}

      {error ? (
        <div className="w-full mx-auto my-2">
          <Alert className="mx-2" id="session-error" variant="error">
            <Translator path="common.status.error.serverConnection" />
          </Alert>
        </div>
      ) : null}
      <LatestOutputShelf />
      <ErrorBoundary>
        <ScrollContainer
          autoScrollUserMessage={config?.features?.user_message_autoscroll}
          autoScrollAssistantMessage={
            config?.features?.assistant_message_autoscroll
          }
          autoScrollRef={autoScrollRef}
        >
          <div
            className="flex flex-col mx-auto w-full flex-grow p-4"
            style={{
              maxWidth: layoutMaxWidth
            }}
          >
            <TaskList isMobile={true} />
            <WelcomeScreen
              fileSpec={fileSpec}
              onFileUpload={onFileUpload}
              onFileUploadError={onFileUploadError}
              autoScrollRef={autoScrollRef}
            />
            <MessagesContainer navigate={navigate} />
          </div>
        </ScrollContainer>
        <div
          className="flex flex-col mx-auto w-full p-4 pt-0"
          style={{
            maxWidth: layoutMaxWidth
          }}
        >
          <ChatFooter
            fileSpec={fileSpec}
            onFileUpload={onFileUpload}
            onFileUploadError={onFileUploadError}
            autoScrollRef={autoScrollRef}
          />
        </div>
      </ErrorBoundary>
    </div>
  );
};

export default Chat;
