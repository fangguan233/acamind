import { describe, expect, it } from 'vitest';

import type { IMode, IStep, ITasklistElement } from '@chainlit/react-client';

import {
  applyModeSelection,
  getNextResearchPollingState,
  mergeResearchMessages,
  mergeResearchTasklists,
  shouldRestoreDeepResearchMode
} from './deepResearchSync';

describe('deepResearchSync utils', () => {
  it('merges research messages by id', () => {
    const current: IStep[] = [
      {
        id: 'm1',
        name: 'assistant',
        type: 'assistant_message',
        output: 'old',
        createdAt: 1
      }
    ];
    const incoming: IStep[] = [
      {
        id: 'm1',
        name: 'assistant',
        type: 'assistant_message',
        output: 'new',
        createdAt: 1
      },
      {
        id: 'm2',
        name: 'assistant',
        type: 'assistant_message',
        output: 'second',
        createdAt: 2
      }
    ];

    const merged = mergeResearchMessages(current, incoming);
    expect(merged).toHaveLength(2);
    expect(merged[0].output).toBe('new');
    expect(merged[1].id).toBe('m2');
  });

  it('merges tasklist elements by id', () => {
    const current: ITasklistElement[] = [
      { id: 't1', type: 'tasklist', forId: '', url: '/old' }
    ];
    const merged = mergeResearchTasklists(current, {
      id: 't1',
      type: 'tasklist',
      forId: '',
      url: '/new'
    });
    expect(merged).toHaveLength(1);
    expect(merged[0].url).toBe('/new');
  });

  it('restores deep research mode when metadata is active', () => {
    const modes: IMode[] = [
      {
        id: 'feature',
        name: '功能',
        options: [
          { id: 'chat', name: '聊天', default: true },
          { id: 'deep_research', name: '深度研究' }
        ]
      }
    ];
    const next = applyModeSelection(modes, 'feature', 'deep_research');
    expect(next[0].options.find((item) => item.id === 'deep_research')?.default).toBe(
      true
    );
    expect(
      shouldRestoreDeepResearchMode({
        deep_research: { status: 'running', active_mode: 'deep_research' }
      })
    ).toBe(true);
  });

  it('keeps polling through initial race and transient misses after a job is found', () => {
    expect(
      getNextResearchPollingState({
        hadJob: false,
        missCount: 0,
        outcome: 'missing'
      })
    ).toEqual({
      hadJob: false,
      missCount: 1,
      shouldPoll: true
    });
    expect(
      getNextResearchPollingState({
        hadJob: true,
        missCount: 0,
        outcome: 'missing'
      })
    ).toEqual({
      hadJob: true,
      missCount: 1,
      shouldPoll: true
    });
    expect(
      getNextResearchPollingState({
        hadJob: true,
        missCount: 19,
        outcome: 'missing'
      })
    ).toEqual({
      hadJob: true,
      missCount: 20,
      shouldPoll: false
    });
  });
});
