import { ArrowLeft, ExternalLink, Loader2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ResizableHandle, ResizablePanel } from '@/components/ui/resizable';
import type { DeepReadEvidenceFocus } from '@/hooks/useDeepReadPdfDock';
import { useIsMobile } from '@/hooks/use-mobile';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type Props = {
  pdfUrl: string;
  onClose: () => void;
  onBack?: () => void;
  evidenceFocus: DeepReadEvidenceFocus | null;
};

type TextBox = {
  left: number;
  top: number;
  width: number;
  height: number;
  text: string;
};

type RectBox = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type ParsedFocusBbox = {
  rects: Array<{ x: number; y: number; width: number; height: number }>;
  pageWidth: number | null;
  pageHeight: number | null;
  page: number | null;
};

const getHostLabel = (rawUrl: string): string => {
  try {
    const parsed = new URL(rawUrl);
    return parsed.host;
  } catch {
    return '';
  }
};

const normalizeNeedle = (value: string): string =>
  (value || '')
    .replace(/^(?:句子|sentence)\s*[:：]\s*/i, '')
    .replace(/\s+/g, ' ')
    .replace(/[()[\]{}"“”‘’]/g, ' ')
    .trim();

const normalizeForMatch = (value: string): string =>
  normalizeNeedle(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\u4e00-\u9fff ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const findHighlightIndices = (texts: string[], needleRaw: string): Set<number> => {
  const needle = normalizeForMatch(needleRaw);
  if (!needle) return new Set<number>();

  const normalizedItems = texts.map((text) => normalizeForMatch(text));
  const ranges: Array<{ start: number; end: number }> = [];
  let joined = '';
  for (const item of normalizedItems) {
    if (!item) {
      ranges.push({ start: -1, end: -1 });
      continue;
    }
    const start = joined.length;
    joined += joined ? ` ${item}` : item;
    ranges.push({ start, end: joined.length });
  }

  if (!joined) return new Set<number>();

  let matchStart = joined.indexOf(needle);
  let matchLen = needle.length;
  if (matchStart < 0 && needle.length > 24) {
    const prefix = needle.slice(0, 24);
    const suffix = needle.slice(Math.max(0, needle.length - 24));
    const prefixStart = joined.indexOf(prefix);
    if (prefixStart >= 0) {
      matchStart = prefixStart;
      matchLen = Math.max(prefix.length, suffix.length);
    }
  }

  const highlighted = new Set<number>();
  if (matchStart >= 0) {
    const matchEnd = matchStart + matchLen;
    ranges.forEach((range, index) => {
      if (range.start < 0) return;
      if (range.end > matchStart && range.start < matchEnd) {
        highlighted.add(index);
      }
    });
    return highlighted;
  }

  const tokenSet = new Set(
    needle
      .split(/\s+/)
      .filter((token) => token.length >= 4 || /[\u4e00-\u9fff]/.test(token))
      .slice(0, 12)
  );
  if (!tokenSet.size) return highlighted;

  normalizedItems.forEach((item, index) => {
    if (!item) return;
    for (const token of tokenSet) {
      if (item.includes(token)) {
        highlighted.add(index);
        break;
      }
    }
  });
  return highlighted;
};

const coerceNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const parseFocusBbox = (raw: string): ParsedFocusBbox | null => {
  const value = (raw || '').trim();
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }

  const rects: Array<{ x: number; y: number; width: number; height: number }> = [];
  let pageWidth: number | null = null;
  let pageHeight: number | null = null;
  let page: number | null = null;

  const addRect = (candidate: unknown) => {
    if (!candidate || typeof candidate !== 'object') return;
    const record = candidate as Record<string, unknown>;
    const x = coerceNumber(record.x);
    const y = coerceNumber(record.y);
    const width = coerceNumber(record.width);
    const height = coerceNumber(record.height);
    if (x == null || y == null || width == null || height == null) return;
    if (width <= 0 || height <= 0) return;
    rects.push({ x, y, width, height });
    const pw = coerceNumber(record.page_width);
    const ph = coerceNumber(record.page_height);
    const p = coerceNumber(record.page);
    if (pw != null && pw > 0) pageWidth = pw;
    if (ph != null && ph > 0) pageHeight = ph;
    if (p != null && p > 0) page = Math.floor(p);
  };

  if (Array.isArray(parsed)) {
    parsed.forEach((item) => addRect(item));
  } else if (parsed && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>;
    const embeddedRects = record.rects;
    if (Array.isArray(embeddedRects)) {
      embeddedRects.forEach((item) => addRect(item));
    } else {
      addRect(record);
    }
    const pw = coerceNumber(record.page_width);
    const ph = coerceNumber(record.page_height);
    const p = coerceNumber(record.page);
    if (pw != null && pw > 0) pageWidth = pw;
    if (ph != null && ph > 0) pageHeight = ph;
    if (p != null && p > 0) page = Math.floor(p);
  }

  if (!rects.length) return null;
  return { rects, pageWidth, pageHeight, page };
};

const findBestPageByText = async (pdfDoc: any, needleRaw: string): Promise<number | null> => {
  const needle = normalizeForMatch(needleRaw);
  if (!needle) return null;
  const tokenSet = new Set(
    needle
      .split(/\s+/)
      .filter((token) => token.length >= 4 || /[\u4e00-\u9fff]/.test(token))
      .slice(0, 14)
  );

  let bestPage: number | null = null;
  let bestScore = -1;
  const scanPages = Math.min(120, Number(pdfDoc?.numPages || 0));
  for (let pageNum = 1; pageNum <= scanPages; pageNum += 1) {
    const page = await pdfDoc.getPage(pageNum);
    const textContent = await page.getTextContent();
    const pageText = normalizeForMatch(
      (textContent?.items || [])
        .map((item: any) => (typeof item?.str === 'string' ? item.str : ''))
        .join(' ')
    );
    if (!pageText) continue;
    if (pageText.includes(needle)) return pageNum;

    let score = 0;
    for (const token of tokenSet) {
      if (pageText.includes(token)) score += token.length;
    }
    if (score > bestScore) {
      bestScore = score;
      bestPage = pageNum;
    }
  }
  return bestScore > 0 ? bestPage : null;
};

const DeepReadPdfPanel = ({ pdfUrl, onClose, onBack, evidenceFocus }: Props) => {
  const isMobile = useIsMobile();
  const host = useMemo(() => getHostLabel(pdfUrl), [pdfUrl]);
  const focusText = useMemo(
    () => normalizeNeedle(evidenceFocus?.text || ''),
    [evidenceFocus?.text]
  );
  const focusBbox = useMemo(
    () => parseFocusBbox(evidenceFocus?.bbox || ''),
    [evidenceFocus?.bbox]
  );
  const focusLabel = useMemo(() => {
    if (!evidenceFocus?.id) return '';
    if (evidenceFocus?.page && evidenceFocus.page > 0) {
      return `${evidenceFocus.id} | p.${evidenceFocus.page}`;
    }
    return evidenceFocus.id;
  }, [evidenceFocus?.id, evidenceFocus?.page]);

  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [loadingPdf, setLoadingPdf] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [rendering, setRendering] = useState(false);
  const [boxes, setBoxes] = useState<TextBox[]>([]);
  const [highlighted, setHighlighted] = useState<Set<number>>(new Set<number>());
  const [bboxRects, setBboxRects] = useState<RectBox[]>([]);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [panelWidth, setPanelWidth] = useState(680);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderTaskRef = useRef<any>(null);
  const renderTokenRef = useRef(0);
  const loadTokenRef = useRef(0);
  const measuredWidthRef = useRef(0);

  useEffect(() => {
    if (!panelRef.current) return;
    const element = panelRef.current;
    const update = () => {
      const minPanelWidth = isMobile ? 260 : 320;
      const nextWidth = Math.max(minPanelWidth, Math.floor(element.clientWidth || 680));
      const prevWidth = measuredWidthRef.current || 0;
      if (prevWidth !== 0 && Math.abs(nextWidth - prevWidth) < 10) return;
      measuredWidthRef.current = nextWidth;
      setPanelWidth(nextWidth);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [isMobile]);

  useEffect(() => {
    if (!pdfUrl) return;
    const loadToken = ++loadTokenRef.current;
    let cancelled = false;
    let task: any = null;

    const timer = window.setTimeout(() => {
      if (cancelled || loadToken !== loadTokenRef.current) return;
      task = pdfjsLib.getDocument({ url: pdfUrl });

      const load = async () => {
        setLoadingPdf(true);
        setLoadError('');
        setPdfDoc(null);
        setPageCount(0);
        setCurrentPage(1);
        try {
          const doc = await task.promise;
          if (cancelled || loadToken !== loadTokenRef.current) {
            await doc.destroy();
            return;
          }
          setPdfDoc(doc);
          setPageCount(Number(doc.numPages || 0));
        } catch (error) {
          if (cancelled || loadToken !== loadTokenRef.current) return;
          setLoadError(String(error || 'Failed to load PDF'));
        } finally {
          if (!cancelled && loadToken === loadTokenRef.current) {
            setLoadingPdf(false);
          }
        }
      };
      void load();
    }, 120);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (task) {
        void task.destroy();
      }
    };
  }, [pdfUrl]);

  useEffect(() => {
    if (!pdfDoc || !pageCount) return;
    let cancelled = false;
    const run = async () => {
      if (evidenceFocus?.page && evidenceFocus.page > 0) {
        const page = Math.min(pageCount, Math.max(1, Math.floor(evidenceFocus.page)));
        if (!cancelled) setCurrentPage(page);
        return;
      }
      if (focusBbox?.page && focusBbox.page > 0) {
        const page = Math.min(pageCount, Math.max(1, Math.floor(focusBbox.page)));
        if (!cancelled) setCurrentPage(page);
        return;
      }
      if (!focusText) return;
      const bestPage = await findBestPageByText(pdfDoc, focusText);
      if (!cancelled && bestPage) {
        setCurrentPage(Math.min(pageCount, Math.max(1, bestPage)));
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [pdfDoc, pageCount, evidenceFocus?.page, focusBbox?.page, focusText, evidenceFocus?.ts]);

  useEffect(() => {
    if (!pdfDoc || !pageCount || currentPage <= 0 || !canvasRef.current) return;
    let cancelled = false;
    const renderToken = ++renderTokenRef.current;
    const run = async () => {
      setRendering(true);
      try {
        const page = await pdfDoc.getPage(currentPage);
        if (cancelled || renderToken !== renderTokenRef.current) return;
        const unscaledViewport = page.getViewport({ scale: 1 });
        const minRenderWidth = isMobile ? 240 : 360;
        const maxWidth = Math.max(minRenderWidth, panelWidth - (isMobile ? 16 : 24));
        const scale = Math.max(0.8, Math.min(3.2, maxWidth / unscaledViewport.width));
        const viewport = page.getViewport({ scale });

        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        if (renderTaskRef.current) {
          try {
            renderTaskRef.current.cancel();
            await renderTaskRef.current.promise;
          } catch {
            // Ignore cancellation errors.
          } finally {
            renderTaskRef.current = null;
          }
        }

        const ratio = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        const renderTask = page.render({ canvasContext: ctx, viewport });
        renderTaskRef.current = renderTask;
        await renderTask.promise;
        if (renderTaskRef.current === renderTask) {
          renderTaskRef.current = null;
        }
        if (cancelled || renderToken !== renderTokenRef.current) return;

        const textContent = await page.getTextContent();
        const nextBoxes: TextBox[] = [];
        const texts: string[] = [];
        for (const item of textContent.items as any[]) {
          if (typeof item?.str !== 'string') continue;
          const text = item.str.trim();
          if (!text) continue;
          const transform = (pdfjsLib as any).Util.transform(viewport.transform, item.transform);
          const x = Number(transform[4] || 0);
          const y = Number(transform[5] || 0);
          const width = Math.max(2, Number(item.width || 0) * viewport.scale);
          const height = Math.max(
            8,
            Number(item.height || 0) * viewport.scale ||
              Math.hypot(Number(transform[2] || 0), Number(transform[3] || 0))
          );

          nextBoxes.push({
            left: x,
            top: y - height,
            width,
            height,
            text
          });
          texts.push(text);
        }

        if (cancelled) return;
        setViewportSize({ width: viewport.width, height: viewport.height });
        setBoxes(nextBoxes);
        setHighlighted(findHighlightIndices(texts, focusText));
        if (focusBbox?.rects?.length) {
          const scaleX = focusBbox.pageWidth && focusBbox.pageWidth > 0
            ? viewport.width / focusBbox.pageWidth
            : 1;
          const scaleY = focusBbox.pageHeight && focusBbox.pageHeight > 0
            ? viewport.height / focusBbox.pageHeight
            : 1;
          const nextRects = focusBbox.rects
            .map((rect) => ({
              left: rect.x * scaleX,
              top: rect.y * scaleY,
              width: rect.width * scaleX,
              height: rect.height * scaleY
            }))
            .filter((rect) => rect.width > 1 && rect.height > 1);
          setBboxRects(nextRects);
        } else {
          setBboxRects([]);
        }
      } catch (error: any) {
        const message = String(error || '');
        const isCancelled =
          error?.name === 'RenderingCancelledException' ||
          /renderingcancelled/i.test(message);
        if (!cancelled && !isCancelled) {
          setLoadError(String(error || 'Failed to render PDF page'));
        }
      } finally {
        if (!cancelled) setRendering(false);
      }
    };
    void run();

    return () => {
      cancelled = true;
      if (renderTaskRef.current) {
        try {
          renderTaskRef.current.cancel();
        } catch {
          // ignore
        }
      }
    };
  }, [pdfDoc, pageCount, currentPage, panelWidth, focusText, focusBbox, evidenceFocus?.ts]);

  if (!pdfUrl) return null;

  const cardContent = (
    <Card className="h-full min-h-0 w-full flex flex-col overflow-hidden border-border/70 shadow-none">
      <CardHeader className="px-3 py-2 gap-1 border-b border-border/60">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            {isMobile && onBack ? (
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 shrink-0"
                onClick={onBack}
                title="Back to chat"
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
            ) : null}
            <CardTitle className="text-sm truncate">Paper PDF</CardTitle>
          </div>
          <div className="flex items-center gap-1">
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={() => window.open(pdfUrl, '_blank', 'noopener,noreferrer')}
              title="Open in new tab"
            >
              <ExternalLink className="h-4 w-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={onClose}
              title="Close PDF preview"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
        {host ? (
          <div className="text-[11px] text-muted-foreground truncate">{host}</div>
        ) : null}
        {focusLabel ? (
          <div className="text-[11px] text-muted-foreground truncate">{focusLabel}</div>
        ) : null}
        {focusText ? (
          <div className="text-[11px] text-muted-foreground truncate bg-yellow-200/50 dark:bg-yellow-900/30 px-1.5 py-0.5 rounded">
            {focusText}
          </div>
        ) : null}
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2"
            onClick={() => setCurrentPage((prev) => Math.max(1, prev - 1))}
            disabled={!pageCount || currentPage <= 1}
          >
            Prev
          </Button>
          <span>
            p.{currentPage}/{pageCount || '?'}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2"
            onClick={() =>
              setCurrentPage((prev) => Math.min(pageCount || prev, prev + 1))
            }
            disabled={!pageCount || currentPage >= pageCount}
          >
            Next
          </Button>
          {rendering || loadingPdf ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="flex-1 min-h-0 p-0">
        <div
          ref={panelRef}
          className="acamind-pdf-scroll h-full w-full overflow-y-auto overflow-x-auto bg-muted/10"
        >
          {loadError ? (
            <div className="p-3 text-xs text-red-500">{loadError}</div>
          ) : (
            <div
              className="relative mx-auto my-2"
              style={{ width: `${viewportSize.width}px`, height: `${viewportSize.height}px` }}
            >
              <canvas ref={canvasRef} className="block border border-border shadow-sm bg-white" />
              <div className="absolute inset-0 pointer-events-none">
                {bboxRects.map((rect, index) => (
                  <div
                    key={`bbox-${index}-${rect.left}-${rect.top}`}
                    className="absolute bg-amber-400/35 dark:bg-amber-500/35 border border-amber-500/70 rounded-sm"
                    style={{
                      left: `${rect.left}px`,
                      top: `${rect.top}px`,
                      width: `${rect.width}px`,
                      height: `${rect.height}px`
                    }}
                  />
                ))}
                {boxes.map((box, index) => (
                  <div
                    key={`${index}-${box.left}-${box.top}`}
                    className={
                      highlighted.has(index)
                        ? 'absolute bg-yellow-300/45 dark:bg-yellow-500/35 rounded-sm'
                        : 'absolute'
                    }
                    style={{
                      left: `${box.left}px`,
                      top: `${box.top}px`,
                      width: `${box.width}px`,
                      height: `${box.height}px`
                    }}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );

  if (isMobile) {
    return (
      <aside className="h-full min-h-0 w-full overflow-hidden bg-background p-2 pl-0">
        {cardContent}
      </aside>
    );
  }

  return (
    <>
      <ResizableHandle className="sm:hidden md:block bg-transparent" />
      <ResizablePanel
        minSize={20}
        defaultSize={34}
        maxSize={70}
        className="hidden md:flex min-w-0 overflow-hidden"
      >
        <aside className="h-full min-h-0 w-full overflow-hidden p-2 pl-0">
          {cardContent}
        </aside>
      </ResizablePanel>
    </>
  );
};

export default DeepReadPdfPanel;
