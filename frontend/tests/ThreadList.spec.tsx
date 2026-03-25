import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RecoilRoot } from 'recoil';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let mockThreadId: string | undefined;
let mockIdToResume: string | undefined;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key
  })
}));

vi.mock('recoil', async () => {
  const actual = await vi.importActual<typeof import('recoil')>('recoil');

  return {
    ...actual,
    useSetRecoilState: () => vi.fn()
  };
});

vi.mock('@chainlit/react-client', async () => {
  const React = await import('react');

  return {
    ChainlitContext: React.createContext({
      deleteThread: vi.fn(),
      renameThread: vi.fn()
    }),
    ClientError: class ClientError extends Error {},
    threadHistoryState: {},
    useChatInteract: () => ({ clear: vi.fn() }),
    useChatMessages: () => ({ threadId: mockThreadId }),
    useChatSession: () => ({ idToResume: mockIdToResume }),
    useConfig: () => ({
      config: { dataPersistence: true, threadSharing: false }
    })
  };
});

vi.mock('@/components/Alert', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}));

vi.mock('@/components/Loader', () => ({
  Loader: () => <div data-testid="loader">loading</div>
}));

vi.mock('@/components/share/ShareDialog', () => ({
  default: () => null
}));

vi.mock('../src/components/i18n', () => ({
  Translator: ({ path }: { path: string }) => <span>{path}</span>
}));

vi.mock('../src/components/LeftSidebar/ThreadOptions', () => ({
  default: () => <div data-testid="thread-options" />
}));

vi.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogAction: ({ children, onClick }: any) => (
    <button onClick={onClick}>{children}</button>
  ),
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => (
    <button>{children}</button>
  ),
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  )
}));

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}));

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>
}));

vi.mock('@/components/ui/input', () => ({
  Input: (props: any) => <input {...props} />
}));

vi.mock('@/components/ui/label', () => ({
  Label: ({ children, ...props }: any) => <label {...props}>{children}</label>
}));

vi.mock('@/components/ui/sidebar', () => ({
  SidebarGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarGroupContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SidebarGroupLabel: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SidebarMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarMenuButton: ({
    children,
    isActive
  }: {
    children: React.ReactNode;
    isActive?: boolean;
  }) => <button data-active={isActive ? 'true' : 'false'}>{children}</button>,
  SidebarMenuItem: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  )
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  TooltipProvider: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  )
}));

import { ThreadList } from '../src/components/LeftSidebar/ThreadList';

const threadHistory = {
  threads: [
    {
      id: 'thread-1',
      createdAt: Date.now(),
      name: 'Thread One',
      steps: []
    }
  ],
  currentThreadId: 'stale-thread',
  timeGroupedThreads: {
    Today: [
      {
        id: 'thread-1',
        createdAt: Date.now(),
        name: 'Thread One',
        steps: []
      }
    ]
  },
  pageInfo: undefined
};

const renderThreadList = (props: Partial<React.ComponentProps<typeof ThreadList>> = {}) =>
  render(
    <RecoilRoot>
      <MemoryRouter>
        <ThreadList
          threadHistory={threadHistory}
          error={undefined}
          hasHydratedInitialHistory
          isFetching={false}
          isLoadingMore={false}
          {...props}
        />
      </MemoryRouter>
    </RecoilRoot>
  );

describe('ThreadList', () => {
  beforeEach(() => {
    mockThreadId = undefined;
    mockIdToResume = undefined;
  });

  it('keeps the initial state on the loader until history hydration completes', () => {
    renderThreadList({
      threadHistory: {
        threads: undefined,
        currentThreadId: undefined,
        timeGroupedThreads: undefined,
        pageInfo: undefined
      },
      hasHydratedInitialHistory: false
    });

    expect(screen.getByTestId('loader')).toBeInTheDocument();
    expect(
      screen.queryByText('threadHistory.sidebar.empty')
    ).not.toBeInTheDocument();
  });

  it('keeps the list visible while loading more pages', () => {
    renderThreadList({ isLoadingMore: true });

    expect(screen.getAllByText('Thread One').length).toBeGreaterThan(0);
    expect(screen.getByTestId('loader')).toBeInTheDocument();
    expect(
      screen.queryByText('threadHistory.sidebar.empty')
    ).not.toBeInTheDocument();
  });

  it('uses the current thread id for the selected state instead of stale history selection', () => {
    mockThreadId = 'thread-1';

    renderThreadList();

    const selectedButton = screen.getByRole('button', { name: /Thread One/i });
    expect(selectedButton).toHaveAttribute('data-active', 'true');
  });
});
