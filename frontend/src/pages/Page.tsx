import { ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useRecoilValue } from 'recoil';

import { sideViewState, useAuth, useConfig } from '@chainlit/react-client';

import ChatSettingsSidebar from '@/components/ChatSettings/ChatSettingsSidebar';
import DeepReadPdfPanel from '@/components/DeepReadPdfPanel';
import ElementSideView from '@/components/ElementSideView';
import LeftSidebar from '@/components/LeftSidebar';
import { TaskList } from '@/components/Tasklist';
import { Header } from '@/components/header';
import { Button } from '@/components/ui/button';
import { ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { useDeepReadPdfDock } from '@/hooks/useDeepReadPdfDock';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';

import { userEnvState } from 'state/user';

type Props = {
  children: JSX.Element;
};

const Page = ({ children }: Props) => {
  const { config } = useConfig();
  const { data } = useAuth();
  const userEnv = useRecoilValue(userEnvState);
  const sideView = useRecoilValue(sideViewState);
  const { pdfUrl, showPdfDock, closePdfDock, evidenceFocus } = useDeepReadPdfDock();
  const isMobile = useIsMobile();
  const [showMobilePdfView, setShowMobilePdfView] = useState(false);

  useEffect(() => {
    if (!isMobile || !showPdfDock || !pdfUrl) {
      setShowMobilePdfView(false);
      return;
    }
    setShowMobilePdfView(false);
  }, [isMobile, showPdfDock, pdfUrl]);

  useEffect(() => {
    if (!isMobile || !showPdfDock || !pdfUrl || !evidenceFocus?.ts) return;
    setShowMobilePdfView(true);
  }, [isMobile, showPdfDock, pdfUrl, evidenceFocus?.ts]);

  if (config?.userEnv) {
    for (const key of config.userEnv || []) {
      if (!userEnv[key]) return <Navigate to="/env" />;
    }
  }

  const showSettingsSidebar = config?.ui?.chat_settings_location === 'sidebar';
  const showMobilePdfDock = isMobile && showPdfDock && !!pdfUrl;

  const mainContent = (
    <div className="flex flex-col h-full w-full">
      <Header />
      {showMobilePdfDock ? (
        <>
          <div className="relative flex flex-1 min-h-0 min-w-0 overflow-hidden">
            <div className="flex flex-row flex-grow min-h-0 min-w-0 overflow-hidden h-full w-full">
              {children}
            </div>
            {!showMobilePdfView ? (
              <Button
                size="icon"
                className="absolute right-0 top-[46%] z-20 h-14 w-9 -translate-y-1/2 rounded-l-2xl rounded-r-none border border-r-0 border-border/70 bg-background/94 text-foreground shadow-lg backdrop-blur"
                variant="outline"
                onClick={() => setShowMobilePdfView(true)}
                title="查看论文"
              >
                <ChevronRight className="h-5 w-5" />
              </Button>
            ) : null}
            <div
              className={cn(
                'absolute inset-0 z-30 bg-background transition-transform duration-300 ease-out',
                showMobilePdfView ? 'translate-x-0' : 'translate-x-full pointer-events-none'
              )}
            >
              <div className="h-full w-full overflow-hidden">
                <DeepReadPdfPanel
                  pdfUrl={pdfUrl}
                  onClose={() => {
                    setShowMobilePdfView(false);
                    closePdfDock();
                  }}
                  onBack={() => setShowMobilePdfView(false)}
                  evidenceFocus={evidenceFocus}
                />
              </div>
            </div>
          </div>
          {sideView ? <ElementSideView /> : null}
          {showSettingsSidebar && <ChatSettingsSidebar />}
        </>
      ) : (
        <ResizablePanelGroup
          direction="horizontal"
          className="flex flex-row flex-grow min-h-0 min-w-0 overflow-hidden"
        >
          <ResizablePanel
            className="flex flex-col h-full w-full min-h-0 min-w-0 overflow-hidden"
            minSize={showPdfDock ? 30 : 40}
            defaultSize={showPdfDock ? 66 : 60}
          >
            <div className="flex flex-row flex-grow min-h-0 min-w-0 overflow-hidden">
              {children}
            </div>
          </ResizablePanel>
          {showPdfDock ? (
            <DeepReadPdfPanel
              pdfUrl={pdfUrl}
              onClose={closePdfDock}
              evidenceFocus={evidenceFocus}
            />
          ) : (
            <>
              {sideView ? <ElementSideView /> : <TaskList isMobile={false} />}
              {showSettingsSidebar && <ChatSettingsSidebar />}
            </>
          )}
        </ResizablePanelGroup>
      )}
    </div>
  );

  const localHistoryEnabled = !config?.dataPersistence;
  const historyEnabled =
    localHistoryEnabled || (config?.dataPersistence && data?.requireLogin);

  return (
    <SidebarProvider
      defaultOpen={config?.ui.default_sidebar_state !== 'closed'}
    >
      {historyEnabled ? (
        <>
          <LeftSidebar />
          <SidebarInset className="max-h-svh">{mainContent}</SidebarInset>
        </>
      ) : (
        <div className="h-screen w-screen flex">{mainContent}</div>
      )}
    </SidebarProvider>
  );
};

export default Page;
