import isEqual from 'lodash/isEqual';
import React, { memo, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { DEEP_RESEARCH_SYNC_EVENT } from '@/lib/deepResearchSync';

type BuildEndpoint = (path: string) => string;

type UploadFileFn = (
  file: File,
  onProgress: (progress: number) => void,
  parentId?: string
) => {
  promise: Promise<{ id: string }>;
};

type ClarificationAnswer = {
  label?: string;
  other?: string;
  value?: string;
};

type ClarificationRequest = {
  job_id?: string;
  request_id?: string;
  reason?: string;
  questions?: Array<{
    id: string;
    prompt?: string;
    options?: Array<{
      label?: string;
      description?: string;
    }>;
    allow_other?: boolean;
    required?: boolean;
  }>;
};

type UploadRequest = {
  job_id?: string;
  request_id?: string;
  paper_key?: string;
  paper_number?: number;
  title?: string;
  reason?: string;
  doi?: string;
  doi_url?: string;
  openalex_id?: string;
  source_url?: string;
  source_links?: string[];
  status?: string;
  waiting_until?: string;
  identifier?: {
    type?: string;
    value?: string;
    doi?: string;
    openalex_id?: string;
  };
};

type RoundItem = {
  round?: number;
  status?: string;
  plan?: string;
  tool_runs?: Array<{
    tool_name?: string;
    summary?: string;
  }>;
  round_summary?: string;
  review?: string;
  collapsed_by_default?: boolean;
};

type DeepResearchCardData = {
  summary?: {
    job_id?: string;
    question?: string;
    status?: string;
    status_label?: string;
    phase?: string;
    phase_label?: string;
    round?: number;
    latest_progress?: string;
    budget?: {
      max_rounds?: number;
      max_tool_calls?: number;
      max_paper_reads?: number;
    };
    error?: string;
    can_regenerate?: boolean;
  };
  rounds?: RoundItem[];
  clarification_requests?: ClarificationRequest[];
  upload_requests?: UploadRequest[];
};

interface Props {
  card: DeepResearchCardData;
  buildEndpoint: BuildEndpoint;
  uploadFile?: UploadFileFn;
  sessionId?: string;
}

const statusTone = (status?: string) => {
  if (status === 'completed') return 'default';
  if (status === 'failed' || status === 'canceled') return 'destructive';
  return 'secondary';
};

const dispatchResearchSnapshot = (snapshot?: unknown, forcePolling = false) => {
  if (typeof window === 'undefined' || !snapshot || typeof snapshot !== 'object') {
    return;
  }
  window.dispatchEvent(
    new CustomEvent(DEEP_RESEARCH_SYNC_EVENT, {
      detail: { snapshot, forcePolling }
    })
  );
};

function SectionTitle({ title, extra }: { title: string; extra?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="text-sm font-semibold">{title}</div>
      {extra}
    </div>
  );
}

function RoundCard({ round, initialOpen }: { round: RoundItem; initialOpen: boolean }) {
  const [open, setOpen] = useState(Boolean(initialOpen));
  const toolRuns = Array.isArray(round.tool_runs) ? round.tool_runs : [];

  const statusLabel =
    round.status === 'in_progress'
      ? '进行中'
      : round.status === 'failed'
        ? '失败'
        : round.status === 'canceled'
          ? '已取消'
          : '已记录';

  return (
    <Card className="border border-slate-200 shadow-none">
      <CardHeader className="pb-3">
        <button
          type="button"
          className="flex w-full items-center justify-between text-left"
          onClick={() => setOpen((value) => !value)}
        >
          <div className="space-y-1">
            <CardTitle className="text-base">第 {round.round || 1} 轮</CardTitle>
            <div className="text-xs text-muted-foreground">{statusLabel}</div>
          </div>
          <div className="text-xs text-muted-foreground">{open ? '收起' : '展开'}</div>
        </button>
      </CardHeader>
      {open ? (
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <SectionTitle title="拆题与计划" />
            <div className="whitespace-pre-wrap rounded-md bg-slate-50 p-3 text-sm leading-6">
              {round.plan || '暂无'}
            </div>
          </div>
          <div className="space-y-2">
            <SectionTitle
              title="证据采集"
              extra={<Badge variant="outline">{toolRuns.length} 次调用</Badge>}
            />
            <div className="space-y-2">
              {toolRuns.length ? (
                toolRuns.map((item, index) => (
                  <div
                    key={`${item.tool_name || 'tool'}-${index}`}
                    className="rounded-md border p-3 text-sm"
                  >
                    <div className="font-medium">{item.tool_name || 'tool'}</div>
                    <div className="mt-1 text-muted-foreground">
                      {item.summary || '暂无摘要'}
                    </div>
                  </div>
                ))
              ) : (
                <div className="rounded-md bg-slate-50 p-3 text-sm text-muted-foreground">
                  暂无
                </div>
              )}
            </div>
          </div>
          <div className="space-y-2">
            <SectionTitle title="阶段总结" />
            <div className="whitespace-pre-wrap rounded-md bg-slate-50 p-3 text-sm leading-6">
              {round.round_summary || '暂无'}
            </div>
          </div>
          <div className="space-y-2">
            <SectionTitle title="质量审查与补强建议" />
            <div className="whitespace-pre-wrap rounded-md bg-slate-50 p-3 text-sm leading-6">
              {round.review || '暂无'}
            </div>
          </div>
        </CardContent>
      ) : null}
    </Card>
  );
}

function ClarificationCard({
  request,
  buildEndpoint
}: {
  request: ClarificationRequest;
  buildEndpoint: BuildEndpoint;
}) {
  const questions = Array.isArray(request.questions) ? request.questions : [];
  const [answers, setAnswers] = useState<Record<string, ClarificationAnswer>>({});
  const [pending, setPending] = useState(false);

  const updateAnswer = (
    questionId: string,
    value: string,
    type: keyof ClarificationAnswer = 'label'
  ) => {
    setAnswers((prev) => ({
      ...prev,
      [questionId]: {
        ...(prev[questionId] || {}),
        [type]: value,
        value
      }
    }));
  };

  const submit = async () => {
    for (const question of questions) {
      const answer = answers[question.id];
      const hasChoice = Boolean(answer?.label || answer?.other || answer?.value);
      if (question.required && !hasChoice) {
        toast.error('请先完成问题澄清');
        return;
      }
    }

    setPending(true);
    try {
      const response = await fetch(
        buildEndpoint(`/research/jobs/${request.job_id}/clarification`),
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            request_id: request.request_id,
            answers
          })
        }
      );
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = await response.json().catch(() => null);
      dispatchResearchSnapshot(payload?.snapshot, true);
      toast.success('已提交研究方向澄清');
    } catch (error: any) {
      toast.error(String(error?.message || error || '提交失败'));
    } finally {
      setPending(false);
    }
  };

  return (
    <Card className="border-amber-200 bg-amber-50/60 shadow-none">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">问题澄清</CardTitle>
        <div className="text-sm text-muted-foreground">
          {request.reason || '请先明确研究方向'}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {questions.map((question) => {
          const options = Array.isArray(question.options) ? question.options : [];
          return (
            <div key={question.id} className="space-y-2">
              <div className="text-sm font-medium">{question.prompt}</div>
              <div className="space-y-2">
                {options.map((option) => {
                  const checked = answers?.[question.id]?.label === option.label;
                  return (
                    <label
                      key={option.label}
                      className="flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm"
                    >
                      <input
                        type="radio"
                        name={question.id}
                        checked={checked}
                        onChange={() => updateAnswer(question.id, option.label || '')}
                      />
                      <span>
                        <span className="font-medium">{option.label}</span>
                        {option.description ? (
                          <span className="block text-xs text-muted-foreground">
                            {option.description}
                          </span>
                        ) : null}
                      </span>
                    </label>
                  );
                })}
                {question.allow_other ? (
                  <Input
                    placeholder="其他方向"
                    value={answers?.[question.id]?.other || ''}
                    onChange={(event) =>
                      updateAnswer(question.id, event.target.value, 'other')
                    }
                  />
                ) : null}
              </div>
            </div>
          );
        })}
        <Button disabled={pending} onClick={submit}>
          {pending ? '提交中...' : '确认研究方向'}
        </Button>
      </CardContent>
    </Card>
  );
}

function UploadCard({
  request,
  buildEndpoint,
  uploadFile,
  sessionId
}: {
  request: UploadRequest;
  buildEndpoint: BuildEndpoint;
  uploadFile?: UploadFileFn;
  sessionId?: string;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [pending, setPending] = useState(false);
  const [progress, setProgress] = useState(0);

  const displayTitle =
    request.title ||
    request.identifier?.doi ||
    request.doi ||
    request.openalex_id ||
    request.paper_key ||
    '未命名论文';

  const detailRows = [
    request.doi || request.identifier?.doi
      ? { label: 'DOI', value: request.doi || request.identifier?.doi || '' }
      : null,
    request.openalex_id || request.identifier?.openalex_id
      ? {
          label: 'OpenAlex',
          value: request.openalex_id || request.identifier?.openalex_id || ''
        }
      : null,
    request.identifier?.type && request.identifier?.value
      ? {
          label: `标识 (${request.identifier.type})`,
          value: request.identifier.value
        }
      : null,
    request.paper_key ? { label: '论文键', value: request.paper_key } : null
  ].filter(Boolean) as Array<{ label: string; value: string }>;

  const externalLinks = useMemo(() => {
    const items = [
      request.doi_url,
      ...(Array.isArray(request.source_links) ? request.source_links : []),
      request.source_url
    ];
    const seen = new Set<string>();
    return items.filter((item): item is string => {
      const value = String(item || '').trim();
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
  }, [request.doi_url, request.source_links, request.source_url]);

  const upload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!uploadFile) {
      toast.error('当前页面无法上传文件');
      return;
    }

    setPending(true);
    setProgress(0);
    try {
      const { promise } = uploadFile(file, (value) => setProgress(value));
      const fileRef = await promise;
      const response = await fetch(
        buildEndpoint(`/research/jobs/${request.job_id}/upload`),
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            request_id: request.request_id,
            paper_key: request.paper_key,
            file_ids: [fileRef.id],
            session_id: sessionId
          })
        }
      );
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = await response.json().catch(() => null);
      dispatchResearchSnapshot(payload?.snapshot, true);
      setProgress(100);
      toast.success('已提交补充 PDF');
    } catch (error: any) {
      toast.error(String(error?.message || error || '上传失败'));
    } finally {
      setPending(false);
    }
  };

  const skip = async () => {
    setPending(true);
    try {
      const response = await fetch(
        buildEndpoint(`/research/jobs/${request.job_id}/skip-upload`),
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            request_id: request.request_id,
            paper_key: request.paper_key,
            reason: '用户选择跳过该文献'
          })
        }
      );
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = await response.json().catch(() => null);
      dispatchResearchSnapshot(payload?.snapshot, true);
      toast.success('已跳过该文献');
    } catch (error: any) {
      toast.error(String(error?.message || error || '操作失败'));
    } finally {
      setPending(false);
    }
  };

  return (
    <Card className="border-dashed border-slate-300 shadow-none">
      <CardContent className="space-y-3 pt-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">
            {request.status === 'waiting' ? '等待补原文' : '待补原文'}
          </Badge>
          <div className="text-sm font-medium">
            {request.paper_number ? `[${request.paper_number}] ` : ''}
            {displayTitle}
          </div>
        </div>
        <div className="text-sm text-muted-foreground">
          {request.reason || '需要用户补充 PDF 才能继续精读。'}
        </div>
        {detailRows.length ? (
          <div className="rounded-md bg-slate-50 p-3 text-xs text-slate-700">
            <div className="space-y-2">
              {detailRows.map((item) => (
                <div key={`${item.label}-${item.value}`} className="grid gap-1">
                  <div className="font-medium text-slate-500">{item.label}</div>
                  <div className="break-all font-mono">{item.value}</div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        {request.waiting_until ? (
          <div className="text-xs text-muted-foreground">
            等待截止：{request.waiting_until}
          </div>
        ) : null}
        {externalLinks.length ? (
          <div className="space-y-1 text-sm">
            {externalLinks.map((item, index) => (
              <a
                key={`${item}-${index}`}
                className="block break-all text-blue-600 underline"
                href={item}
                rel="noreferrer"
                target="_blank"
              >
                {index === 0 && request.doi_url ? 'DOI 链接' : `原始链接 ${index + 1}`}
              </a>
            ))}
          </div>
        ) : null}
        {pending ? <Progress value={progress} /> : null}
        <div className="flex flex-wrap gap-2">
          <Button disabled={pending} onClick={() => inputRef.current?.click()}>
            补充原文 PDF
          </Button>
          <Button disabled={pending} variant="outline" onClick={skip}>
            跳过该文献
          </Button>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,application/pdf"
          className="hidden"
          onChange={upload}
        />
      </CardContent>
    </Card>
  );
}

function BuiltinDeepResearchCard({
  card,
  buildEndpoint,
  uploadFile,
  sessionId
}: Props) {
  const summary = card.summary || {};
  const [regenerating, setRegenerating] = useState(false);
  const rounds = Array.isArray(card.rounds) ? card.rounds : [];
  const clarificationRequests = Array.isArray(card.clarification_requests)
    ? card.clarification_requests
    : [];
  const uploadRequests = Array.isArray(card.upload_requests) ? card.upload_requests : [];
  const progressText = summary.latest_progress || '等待开始';
  const budget = summary.budget || {};
  const budgetText = useMemo(() => {
    const items: string[] = [];
    if (budget.max_rounds) items.push(`轮次 ${budget.max_rounds}`);
    if (budget.max_tool_calls) items.push(`工具 ${budget.max_tool_calls}`);
    if (budget.max_paper_reads) items.push(`精读 ${budget.max_paper_reads}`);
    return items.join(' / ');
  }, [budget.max_paper_reads, budget.max_rounds, budget.max_tool_calls]);
  const canRegenerate =
    Boolean(summary.can_regenerate) &&
    Boolean(summary.job_id) &&
    !clarificationRequests.length &&
    !uploadRequests.length;

  const regenerate = async () => {
    if (!summary.job_id) return;
    setRegenerating(true);
    try {
      const response = await fetch(
        buildEndpoint(`/research/jobs/${summary.job_id}/regenerate-report`),
        {
          method: 'POST',
          credentials: 'include'
        }
      );
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = await response.json().catch(() => null);
      dispatchResearchSnapshot(payload?.snapshot, true);
      toast.success('已开始重新生成综述');
    } catch (error: any) {
      toast.error(String(error?.message || error || '重新生成失败'));
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="shadow-none">
        <CardHeader className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="text-2xl">深度研究</CardTitle>
            <Badge variant={statusTone(summary.status)}>
              {summary.status_label || summary.status || '未知'}
            </Badge>
          </div>
          <div className="grid gap-2 text-sm text-slate-700">
            <div>当前阶段：{summary.phase_label || summary.phase || '未知'}</div>
            <div>当前轮次：第 {summary.round || 1} 轮</div>
            <div>研究问题：{summary.question || '暂无'}</div>
            <div>预算摘要：{budgetText || '默认预算'}</div>
            <div>最新进度：{progressText}</div>
          </div>
          {summary.error ? (
            <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 whitespace-pre-wrap">
              {summary.error}
            </div>
          ) : null}
          {canRegenerate ? (
            <div className="flex justify-end">
              <Button disabled={regenerating} variant="outline" onClick={regenerate}>
                {regenerating ? '重新生成中...' : '重新生成综述'}
              </Button>
            </div>
          ) : null}
        </CardHeader>
      </Card>

      {clarificationRequests.length ? (
        <div className="space-y-3">
          {clarificationRequests.map((request) => (
            <ClarificationCard
              key={request.request_id || request.job_id}
              request={request}
              buildEndpoint={buildEndpoint}
            />
          ))}
        </div>
      ) : null}

      {uploadRequests.length ? (
        <div className="space-y-3">
          <div className="text-sm font-semibold">补充原文</div>
          {uploadRequests.map((request) => (
            <UploadCard
              key={request.request_id || request.paper_key}
              request={request}
              buildEndpoint={buildEndpoint}
              uploadFile={uploadFile}
              sessionId={sessionId}
            />
          ))}
        </div>
      ) : null}

      <div className="space-y-3">
        <div className="text-sm font-semibold">研究轮次</div>
        {rounds.length ? (
          rounds.map((round) => (
            <RoundCard
              key={`round-${round.round || 1}`}
              round={round}
              initialOpen={!round.collapsed_by_default}
            />
          ))
        ) : (
          <Card className="shadow-none">
            <CardContent className="pt-6 text-sm text-muted-foreground">
              暂无轮次记录。
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

export default memo(
  BuiltinDeepResearchCard,
  (prevProps, nextProps) =>
    prevProps.buildEndpoint === nextProps.buildEndpoint &&
    prevProps.uploadFile === nextProps.uploadFile &&
    prevProps.sessionId === nextProps.sessionId &&
    isEqual(prevProps.card, nextProps.card)
);
