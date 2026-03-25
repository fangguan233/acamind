import { type ChangeEvent, useMemo, useRef, useState } from 'react';
import { useAuth, useChatInteract, type IFileRef, type IStep } from '@chainlit/react-client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { FileText, Link2, Loader2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { v4 as uuidv4 } from 'uuid';

type PendingUploadRequest = {
  job_id?: string;
  paper_key?: string;
  paper_number?: number;
  title?: string;
  reason?: string;
  doi?: string;
  doi_url?: string;
  openalex_id?: string;
  source_links?: string[];
  source_url?: string;
  identifier?: {
    type?: string;
    value?: string;
    doi?: string;
    openalex_id?: string;
  };
};

const parsePendingUploads = (message: IStep): PendingUploadRequest[] => {
  const payload = (message.metadata as any)?.deep_research;
  const pending = payload?.pending_uploads;
  if (!Array.isArray(pending)) return [];
  return pending.filter((item) => item && typeof item === 'object');
};

const PendingUploadCard = ({ request }: { request: PendingUploadRequest }) => {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { user } = useAuth();
  const { sendMessage, uploadFile } = useChatInteract();
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);

  const title =
    String(request.title || '').trim() ||
    String(request.identifier?.doi || '').trim() ||
    String(request.doi || '').trim() ||
    String(request.openalex_id || '').trim() ||
    String(request.paper_key || '').trim() ||
    '未命名论文';
  const paperNumber = Number(request.paper_number || 0);
  const paperLabel = paperNumber > 0 ? `[${paperNumber}] ${title}` : title;
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
  const sourceLinks = [
    request.doi_url,
    ...(Array.isArray(request.source_links) ? request.source_links : []),
    request.source_url
  ].filter((item): item is string => Boolean(item));
  const externalLinks = sourceLinks.filter((item, index) => sourceLinks.indexOf(item) === index);

  const handleSelect = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = '';

    const lowerName = file.name.toLowerCase();
    const isPdf =
      file.type === 'application/pdf' || lowerName.endsWith('.pdf');
    if (!isPdf) {
      toast.error('请上传 PDF 文件。');
      return;
    }

    setIsUploading(true);
    setUploadProgress(0);
    try {
      const { promise } = uploadFile(file, (progress) => {
        setUploadProgress(progress);
      });
      const fileRef = (await promise) as IFileRef;
      const message: IStep = {
        threadId: '',
        id: uuidv4(),
        name: user?.identifier || 'User',
        type: 'user_message',
        output: `补充原文：${paperLabel}`,
        createdAt: new Date().toISOString(),
        modes: { feature: 'deep_research' },
        metadata: {
          location: window.location.href,
          deep_research: {
            action: 'supplement_upload',
            job_id: String(request.job_id || ''),
            paper_key: String(request.paper_key || ''),
            paper_title: title
          }
        }
      };
      sendMessage(message, [{ id: fileRef.id }]);
      setIsSubmitted(true);
      setUploadProgress(100);
      toast.success(`已提交补充 PDF：${file.name}`);
    } catch (error: any) {
      toast.error(`上传失败：${error?.message || error || '未知错误'}`);
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <Card className="border-dashed border-amber-300 bg-amber-50/60 p-4 dark:bg-amber-950/10">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-amber-700" />
            <div className="font-medium text-sm">{paperLabel}</div>
            <Badge variant="secondary">待补充原文</Badge>
          </div>
          <div className="text-sm text-muted-foreground leading-6">
            {String(request.reason || '').trim() ||
              '未获取到可自动精读的全文，请上传该论文 PDF。'}
          </div>
          {detailRows.length ? (
            <div className="space-y-1 text-xs text-muted-foreground">
              {detailRows.map((row) => (
                <div key={`${row.label}-${row.value}`}>
                  <span className="font-medium text-foreground/80">{row.label}：</span>
                  <span className="break-all">{row.value}</span>
                </div>
              ))}
            </div>
          ) : null}
          {externalLinks.length > 0 ? (
            <div className="flex flex-wrap gap-2 pt-1">
              {externalLinks.slice(0, 3).map((link, index) => (
                <a
                  key={`${link}-${index}`}
                  href={link}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
                >
                  <Link2 className="h-3.5 w-3.5" />
                  {index === 0 && request.doi_url ? 'DOI 链接' : `原始链接 ${index + 1}`}
                </a>
              ))}
            </div>
          ) : null}
        </div>
        <div className="min-w-[152px]">
          <input
            ref={inputRef}
            type="file"
            accept=".pdf,application/pdf"
            className="hidden"
            onChange={handleSelect}
          />
          <Button
            className="w-full"
            disabled={isUploading}
            onClick={() => inputRef.current?.click()}
          >
            {isUploading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                上传中
              </>
            ) : isSubmitted ? (
              <>
                <Upload className="mr-2 h-4 w-4" />
                重新上传 PDF
              </>
            ) : (
              <>
                <Upload className="mr-2 h-4 w-4" />
                补充原文 PDF
              </>
            )}
          </Button>
          {isUploading ? (
            <Progress className="mt-2 h-2" value={uploadProgress} />
          ) : isSubmitted ? (
            <div className="mt-2 text-xs text-emerald-700">
              已提交，后端会继续将其并入当前深度研究。
            </div>
          ) : (
            <div className="mt-2 text-xs text-muted-foreground">
              上传后会自动并入当前深度研究任务。
            </div>
          )}
        </div>
      </div>
    </Card>
  );
};

export function DeepResearchUploadRequests({ message }: { message: IStep }) {
  const pendingUploads = useMemo(() => parsePendingUploads(message), [message]);

  if (!pendingUploads.length) return null;

  return (
    <div className="mt-3 space-y-3">
      <div className="text-sm font-medium">补充原文</div>
      {pendingUploads.map((request, index) => (
        <PendingUploadCard
          key={`${request.paper_key || request.title || 'pending'}-${index}`}
          request={request}
        />
      ))}
    </div>
  );
}
