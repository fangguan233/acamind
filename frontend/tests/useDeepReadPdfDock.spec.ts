import { expect, it } from 'vitest';

import type { IStep } from '@chainlit/react-client';

import { findLatestDeepReadPdfUrl } from '../src/hooks/useDeepReadPdfDock';

const makeStep = (overrides: Partial<IStep> = {}): IStep =>
  ({
    threadId: 'thread-1',
    id: overrides.id || Math.random().toString(36).slice(2),
    name: overrides.name || 'step',
    type: overrides.type || 'tool',
    createdAt: overrides.createdAt || 0,
    ...overrides
  }) as IStep;

it('returns the latest PDF from a deep_read run tree', () => {
  const steps: IStep[] = [
    makeStep({
      id: 'run-deepread',
      name: 'on_message',
      type: 'run',
      steps: [
        makeStep({
          id: 'tool-deepread',
          name: 'OpenAlex download fulltext',
          input: { mode: 'deep_read' }
        }),
        makeStep({
          id: 'assistant-deepread',
          type: 'assistant_message',
          name: 'Assistant',
          output: 'Download: https://example.com/paper.pdf'
        })
      ]
    })
  ];

  expect(findLatestDeepReadPdfUrl(steps)).toBe('https://example.com/paper.pdf');
});

it('treats assistant messages with evidence links as deep_read PDF answers', () => {
  const steps: IStep[] = [
    makeStep({
      id: 'assistant-deepread-with-evidence',
      type: 'assistant_message',
      name: 'Assistant',
      output:
        'Download: https://example.com/paper.pdf\n\n' +
        '<a data-cl-href="cl://evidence?id=P1-S1&page=1&text=test">P1-S1</a>'
    })
  ];

  expect(findLatestDeepReadPdfUrl(steps)).toBe('https://example.com/paper.pdf');
});

it('ignores PDFs that only appear in non-deep_read results', () => {
  const steps: IStep[] = [
    makeStep({
      id: 'run-search',
      name: 'on_message',
      type: 'run',
      steps: [
        makeStep({
          id: 'assistant-search',
          type: 'assistant_message',
          name: 'Assistant',
          output: 'Candidate PDF: https://example.com/search-result.pdf'
        })
      ]
    })
  ];

  expect(findLatestDeepReadPdfUrl(steps)).toBe('');
});

it('prefers the latest PDF-bearing tree and suppresses older deep_read PDFs after search results', () => {
  const steps: IStep[] = [
    makeStep({
      id: 'run-deepread',
      name: 'on_message',
      type: 'run',
      steps: [
        makeStep({
          id: 'tool-deepread',
          name: 'OpenAlex download fulltext',
          input: { mode: 'deep_read' }
        }),
        makeStep({
          id: 'assistant-deepread',
          type: 'assistant_message',
          name: 'Assistant',
          output: 'Download: https://example.com/deepread.pdf'
        })
      ]
    }),
    makeStep({
      id: 'run-search',
      name: 'on_message',
      type: 'run',
      steps: [
        makeStep({
          id: 'assistant-search',
          type: 'assistant_message',
          name: 'Assistant',
          output: 'Candidate PDF: https://example.com/search-result.pdf'
        })
      ]
    })
  ];

  expect(findLatestDeepReadPdfUrl(steps)).toBe('');
});

it('keeps the latest deep_read PDF when newer messages have no PDF context', () => {
  const steps: IStep[] = [
    makeStep({
      id: 'run-deepread',
      name: 'on_message',
      type: 'run',
      steps: [
        makeStep({
          id: 'tool-deepread',
          name: 'OpenAlex download fulltext',
          input: { mode: 'deep_read' }
        }),
        makeStep({
          id: 'assistant-deepread',
          type: 'assistant_message',
          name: 'Assistant',
          output: 'Download: https://example.com/deepread.pdf'
        })
      ]
    }),
    makeStep({
      id: 'assistant-follow-up',
      type: 'assistant_message',
      name: 'Assistant',
      output: 'Follow-up answer without PDF'
    })
  ];

  expect(findLatestDeepReadPdfUrl(steps)).toBe('https://example.com/deepread.pdf');
});
