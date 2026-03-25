import { describe, expect, it } from 'vitest';

import { toThreadHistoryState } from './localThreadHistory';

describe('toThreadHistoryState', () => {
  it('builds grouped history immediately for local threads', () => {
    const state = toThreadHistoryState({
      threads: [
        {
          id: 'thread-1',
          createdAt: Date.now(),
          name: 'Local Thread',
          steps: []
        }
      ],
      currentThreadId: 'thread-1'
    });

    expect(state.threads).toHaveLength(1);
    expect(state.timeGroupedThreads).toBeDefined();
    expect(Object.values(state.timeGroupedThreads || {})).toEqual([
      [
        expect.objectContaining({
          id: 'thread-1',
          name: 'Local Thread'
        })
      ]
    ]);
  });
});
