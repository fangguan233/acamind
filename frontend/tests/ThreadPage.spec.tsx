import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSocketEmit = vi.fn();
const mockSaveLocalThreadHistory = vi.fn();
const mockThread = {
  id: 'local-thread',
  createdAt: Date.now(),
  steps: [],
  elements: [],
  metadata: {}
};

let hydrateAck:
  | ((response?: { ok?: boolean; error?: string }) => void)
  | undefined;

const mockSession = {
  socket: {
    emit: (
      event: string,
      payload: unknown,
      callback?: (response?: { ok?: boolean; error?: string }) => void
    ) => {
      mockSocketEmit(event, payload, callback);
      hydrateAck = callback;
    }
  }
};

vi.mock('recoil', async () => {
  const actual = await vi.importActual<typeof import('recoil')>('recoil');

  return {
    ...actual,
    useSetRecoilState: () => vi.fn()
  };
});

vi.mock('@chainlit/react-client', () => ({
  actionState: {},
  currentThreadIdState: {},
  elementState: {},
  messagesState: {},
  tasklistState: {},
  useChatMessages: () => ({ threadId: 'local-thread' }),
  useChatSession: () => ({
    session: mockSession
  }),
  useConfig: () => ({
    config: { dataPersistence: false, threadResumable: true }
  })
}));

vi.mock('pages/Page', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}));

vi.mock('@/components/AutoResumeThread', () => ({
  default: () => null
}));

vi.mock('@/components/Loader', () => ({
  Loader: () => <div data-testid="loader">loading</div>
}));

vi.mock('@/components/ReadOnlyThread', () => ({
  ReadOnlyThread: () => null
}));

vi.mock('@/components/chat', () => ({
  default: () => <div data-testid="chat">chat</div>
}));

vi.mock('@/lib/localThreadHistory', () => ({
  getLocalThread: () => mockThread,
  loadLocalThreadHistory: () => ({
    threads: [mockThread],
    currentThreadId: undefined
  }),
  saveLocalThreadHistory: (...args: unknown[]) =>
    mockSaveLocalThreadHistory(...args)
}));

import ThreadPage from '../src/pages/Thread';

describe('ThreadPage', () => {
  beforeEach(() => {
    hydrateAck = undefined;
    mockSocketEmit.mockClear();
    mockSaveLocalThreadHistory.mockClear();
  });

  it('hydrates local thread context before rendering chat', async () => {
    render(
      <MemoryRouter initialEntries={['/thread/local-thread']}>
        <Routes>
          <Route path="/thread/:id" element={<ThreadPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByTestId('loader')).toBeInTheDocument();
    expect(mockSocketEmit).toHaveBeenCalledWith(
      'hydrate_local_thread',
      mockThread,
      expect.any(Function)
    );

    await act(async () => {
      hydrateAck?.({ ok: true });
    });

    expect(screen.getByTestId('chat')).toBeInTheDocument();
  });
});
