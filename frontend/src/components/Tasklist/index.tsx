import { cn } from '@/lib/utils';
import useSWR from 'swr';

import { useChatData, useConfig } from '@chainlit/react-client';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader } from '@/components/ui/card';

import { ITaskList, Task } from './Task';

interface HeaderProps {
  status: string;
}

const fetcher = async (url: string) => {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) {
    throw new Error(`Failed to load tasklist (${response.status})`);
  }
  const json = await response.json();
  if (!json || !Array.isArray(json.tasks)) {
    throw new Error('Invalid tasklist payload');
  }
  return json as ITaskList;
};

const Header = ({ status }: HeaderProps) => {
  return (
    <CardHeader className="flex flex-row items-center justify-between gap-2 p-3">
      <div className="font-semibold">Tasks</div>
      <Badge variant="secondary">{status || '?'}</Badge>
    </CardHeader>
  );
};

interface TaskListProps {
  isMobile: boolean;
  isCopilot?: boolean;
}

const TaskList = ({ isMobile, isCopilot }: TaskListProps) => {
  const { tasklists } = useChatData();
  const { config } = useConfig();
  const safeTasklists = Array.isArray(tasklists) ? tasklists : [];
  const tasklist = safeTasklists.length
    ? safeTasklists[safeTasklists.length - 1]
    : undefined;

  const allowHtml = config?.features?.unsafe_allow_html;
  const latex = config?.features?.latex;

  const { error, data, isLoading } = useSWR<ITaskList>(
    tasklist?.url || null,
    fetcher,
    {
      keepPreviousData: true
    }
  );

  if (!tasklist?.url) return null;

  if (isLoading && !data) {
    return null;
  }

  if (error) {
    return null;
  }

  const content = data as ITaskList;
  if (!content) return null;

  const tasks = Array.isArray(content.tasks) ? content.tasks : [];

  if (isMobile) {
    // Get the first running or ready task, or the latest task
    let highlightedTaskIndex = tasks.length - 1;
    for (let i = 0; i < tasks.length; i++) {
      if (tasks[i].status === 'running' || tasks[i].status === 'ready') {
        highlightedTaskIndex = i;
        break;
      }
    }
    const highlightedTask = tasks?.[highlightedTaskIndex];

    return (
      <aside
        className={cn('w-full tasklist-mobile', !isCopilot && 'md:hidden')}
      >
        <Card>
          <Header status={content.status} />
          {highlightedTask && (
            <CardContent className="p-2.5">
              <Task
                index={highlightedTaskIndex + 1}
                task={highlightedTask}
                allowHtml={allowHtml}
                latex={latex}
              />
            </CardContent>
          )}
        </Card>
      </aside>
    );
  }

  return (
    <aside className="hidden tasklist max-w-[21rem] flex-grow md:block overflow-y-auto mr-3 mb-3">
      <Card className="overflow-y-auto h-full">
        <Header status={content?.status} />
        <CardContent className="flex flex-col gap-1 p-2.5">
          {tasks?.map((task, index) => (
            <Task
              key={index}
              index={index + 1}
              task={task}
              allowHtml={allowHtml}
              latex={latex}
            />
          ))}
        </CardContent>
      </Card>
    </aside>
  );
};

export { TaskList };
