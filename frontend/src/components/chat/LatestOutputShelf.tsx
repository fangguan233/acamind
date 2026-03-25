import { useMemo } from 'react';
import { useRecoilValue } from 'recoil';

import {
  latestOutputsState,
  useChatData,
  useChatInteract
} from '@chainlit/react-client';

import { Button } from '@/components/ui/button';

const MODE_LABELS: Record<string, string> = {
  chat: '对话',
  openalex: '学术查询',
  websearch: '联网查询'
};

export function LatestOutputShelf() {
  const snapshots = useRecoilValue(latestOutputsState);
  const { regenLatestOutput } = useChatInteract();
  const { loading } = useChatData();

  const entries = useMemo(
    () =>
      Object.values(snapshots)
        .filter((item) => item?.mode)
        .sort((a, b) => (b.created_at || 0) - (a.created_at || 0)),
    [snapshots]
  );

  if (!entries.length) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-2 rounded-md border border-border/60 bg-muted/50 p-2">
      {entries.map((snapshot) => {
        const label = MODE_LABELS[snapshot.mode] || snapshot.mode;
        return (
          <Button
            variant="ghost"
            size="sm"
            key={snapshot.mode}
            title={snapshot.content_preview}
            disabled={loading}
            onClick={() => regenLatestOutput(snapshot)}
            className="h-7 border border-border/80 text-xs"
          >
            {label}
          </Button>
        );
      })}
    </div>
  );
}
