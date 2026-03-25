import { useCallback, useEffect, useMemo, useState } from 'react';

import { IStep, useChatMessages } from '@chainlit/react-client';

type DockState = {
  url: string;
  visible: boolean;
};

export type DeepReadEvidenceFocus = {
  id: string;
  page: number | null;
  text: string;
  bbox: string;
  ts: number;
};

const STORAGE_KEY = 'sci_deepread_pdf_dock_v1';
const DIRECT_URL_REGEX = /(?:https?:\/\/[^\s"'<>)]{6,}|\/public\/[^\s"'<>)]{3,})/gi;
const PDF_URL_HINT_KEYS = [
  'local_pdf_url',
  'pdf_url',
  'source_pdf_url',
  'download_url',
  'url'
];
const DEEP_READ_MODE_VALUES = new Set([
  'deep',
  'deepread',
  'deep_read',
  'deep-read',
  'deep read'
]);

const clampUrl = (raw: string): string => {
  const value = raw.trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('/')) {
    if (typeof window === 'undefined') return '';
    try {
      return new URL(value, window.location.origin).toString();
    } catch {
      return '';
    }
  }
  return '';
};

const isRenderablePdfUrl = (url: string): boolean => {
  const lowerUrl = url.toLowerCase();
  if (!/^https?:\/\//.test(lowerUrl)) return false;

  // Avoid passing DOI landing pages or local HTML snapshots to PDF.js.
  if (
    lowerUrl.includes('doi.org/') ||
    lowerUrl.endsWith('.html') ||
    lowerUrl.endsWith('.htm') ||
    lowerUrl.includes('.html?') ||
    lowerUrl.includes('.htm?')
  ) {
    return false;
  }

  if (
    lowerUrl.includes('/public/deepread-pdf-cache/') ||
    lowerUrl.includes('/openalex-cache/')
  ) {
    return lowerUrl.endsWith('.pdf') || lowerUrl.includes('.pdf?');
  }

  if (lowerUrl.endsWith('.pdf') || lowerUrl.includes('.pdf?')) return true;
  if (
    lowerUrl.includes('/doi/pdf/') ||
    lowerUrl.includes('/doi/epdf/') ||
    lowerUrl.includes('/doi/pdfdirect/') ||
    lowerUrl.includes('/pdf/')
  ) {
    return true;
  }
  return false;
};

const isLocalCachedPdfUrl = (url: string): boolean => {
  const lowerUrl = url.toLowerCase();
  return (
    lowerUrl.includes('/public/deepread-pdf-cache/') ||
    lowerUrl.includes('/openalex-cache/')
  );
};

const parseHtmlAnchors = (content: string): Array<{ url: string; label: string }> => {
  const anchors: Array<{ url: string; label: string }> = [];
  const regex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null = regex.exec(content);
  while (match) {
    const url = clampUrl(match[1] || '');
    const label = (match[2] || '').replace(/<[^>]+>/g, ' ').trim();
    if (url) {
      anchors.push({ url, label });
    }
    match = regex.exec(content);
  }
  return anchors;
};

const parseMarkdownLinks = (
  content: string
): Array<{ url: string; label: string }> => {
  const links: Array<{ url: string; label: string }> = [];
  const regex = /\[([^\]]{1,80})\]\((https?:\/\/[^)\s]+|\/[^)\s]+)\)/gi;
  let match: RegExpExecArray | null = regex.exec(content);
  while (match) {
    const url = clampUrl(match[2] || '');
    const label = (match[1] || '').trim();
    if (url) {
      links.push({ url, label });
    }
    match = regex.exec(content);
  }
  return links;
};

const parseDirectUrls = (
  content: string
): Array<{ url: string; label: string }> => {
  const links: Array<{ url: string; label: string }> = [];
  DIRECT_URL_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null = DIRECT_URL_REGEX.exec(content);
  while (match) {
    const url = clampUrl(match[0] || '');
    if (url) {
      links.push({ url, label: 'raw' });
    }
    match = DIRECT_URL_REGEX.exec(content);
  }
  return links;
};

const containsEvidenceLink = (value: unknown, depth = 0): boolean => {
  if (depth > 5 || value == null) return false;
  if (typeof value === 'string') {
    return /(?:data-cl-href=|href=)?["']?cl:\/\/evidence\?/i.test(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsEvidenceLink(item, depth + 1));
  }
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((item) =>
      containsEvidenceLink(item, depth + 1)
    );
  }
  return false;
};

const scoreCandidate = (url: string, label: string): number => {
  const lowerUrl = url.toLowerCase();
  const lowerLabel = label.toLowerCase();
  let score = 0;
  if (
    lowerUrl.includes('/public/deepread-pdf-cache/') ||
    lowerUrl.includes('/openalex-cache/')
  ) {
    score += 30;
  }
  if (lowerLabel.includes('pdf')) score += 10;
  if (lowerLabel.includes('oa')) score += 4;
  if (lowerUrl.endsWith('.pdf') || lowerUrl.includes('.pdf?')) score += 8;
  if (
    lowerUrl.includes('arxiv.org') ||
    lowerUrl.includes('hal.science') ||
    lowerUrl.includes('researchsquare') ||
    lowerUrl.includes('api.istex.fr')
  ) {
    score += 4;
  }
  if (
    lowerUrl.includes('doi.org') ||
    lowerUrl.includes('onlinelibrary.wiley.com/doi/')
  ) {
    score -= 2;
  }
  return score;
};

const extractFromText = (text: string): Array<{ url: string; label: string }> => {
  if (!text.trim()) return [];
  const candidates = [
    ...parseHtmlAnchors(text),
    ...parseMarkdownLinks(text),
    ...parseDirectUrls(text)
  ];
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.url}@@${candidate.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const extractFromUnknown = (
  value: unknown,
  depth = 0
): Array<{ url: string; label: string }> => {
  if (depth > 5 || value == null) return [];
  if (typeof value === 'string') {
    return extractFromText(value);
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => extractFromUnknown(item, depth + 1));
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const urls: Array<{ url: string; label: string }> = [];

    for (const key of PDF_URL_HINT_KEYS) {
      const raw = record[key];
      if (typeof raw === 'string') {
        const url = clampUrl(raw);
        if (url) urls.push({ url, label: key });
      }
    }

    for (const [key, raw] of Object.entries(record)) {
      const keyHint = key.toLowerCase();
      const mayContainUrl = /(?:url|link|href|pdf|source)/.test(keyHint);
      if (typeof raw === 'string') {
        if (mayContainUrl) {
          urls.push(
            ...extractFromText(raw).map((item) => ({
              ...item,
              label: `${key}:${item.label}`
            }))
          );
        }
      } else {
        urls.push(...extractFromUnknown(raw, depth + 1));
      }
    }

    return urls;
  }
  return [];
};

const extractPdfUrlFromStep = (step: IStep): string => {
  const candidates = [
    ...extractFromUnknown(step.output),
    ...extractFromUnknown(step.input),
    ...extractFromUnknown((step as any).content),
    ...extractFromUnknown((step as any).name),
    ...extractFromUnknown((step as any).metadata)
  ];
  if (!candidates.length) return '';

  const renderableCandidates = candidates.filter((candidate) =>
    isRenderablePdfUrl(candidate.url)
  );
  if (!renderableCandidates.length) return '';

  const scored = renderableCandidates
    .map((candidate) => ({
      ...candidate,
      score: scoreCandidate(candidate.url, candidate.label)
    }))
    .sort((a, b) => b.score - a.score);

  return scored[0]?.url || '';
};

const parseModeValue = (value: unknown): 'deep_read' | 'search' | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'search') return 'search';
  if (DEEP_READ_MODE_VALUES.has(normalized)) return 'deep_read';
  return null;
};

const extractModeFromUnknown = (
  value: unknown,
  depth = 0
): 'deep_read' | 'search' | null => {
  if (depth > 5 || value == null) return null;
  const directMode = parseModeValue(value);
  if (directMode) return directMode;

  if (Array.isArray(value)) {
    for (const item of value) {
      const nestedMode = extractModeFromUnknown(item, depth + 1);
      if (nestedMode) return nestedMode;
    }
    return null;
  }

  if (typeof value !== 'object') return null;

  const record = value as Record<string, unknown>;
  const keyedMode = parseModeValue(record.mode);
  if (keyedMode) return keyedMode;

  for (const [key, nestedValue] of Object.entries(record)) {
    if (key === 'mode') continue;
    const nestedMode = extractModeFromUnknown(nestedValue, depth + 1);
    if (nestedMode) return nestedMode;
  }

  return null;
};

const stepMode = (step: IStep): 'deep_read' | 'search' | null => {
  const sources = [
    step.input,
    step.output,
    (step as any).content,
    (step as any).metadata,
    (step as any).name
  ];

  for (const source of sources) {
    const mode = extractModeFromUnknown(source);
    if (mode) return mode;
  }

  return null;
};

type StepTreeInspection = {
  hasDeepRead: boolean;
  latestPdfUrl: string;
};

const inspectStepTree = (step: IStep): StepTreeInspection => {
  let hasDeepRead =
    stepMode(step) === 'deep_read' ||
    containsEvidenceLink(step.output) ||
    containsEvidenceLink(step.input) ||
    containsEvidenceLink((step as any).content) ||
    containsEvidenceLink((step as any).metadata);
  let latestPdfUrl = '';

  const nestedSteps = Array.isArray(step.steps) ? (step.steps as IStep[]) : [];
  for (let index = nestedSteps.length - 1; index >= 0; index -= 1) {
    const nested = inspectStepTree(nestedSteps[index]);
    if (!latestPdfUrl && nested.latestPdfUrl) {
      latestPdfUrl = nested.latestPdfUrl;
    }
    if (nested.hasDeepRead) {
      hasDeepRead = true;
    }
  }

  const ownPdfUrl = extractPdfUrlFromStep(step);
  if (!latestPdfUrl && ownPdfUrl) {
    latestPdfUrl = ownPdfUrl;
  }

  return { hasDeepRead, latestPdfUrl };
};

export const findLatestDeepReadPdfUrl = (steps: IStep[]): string => {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const inspection = inspectStepTree(steps[index]);
    if (!inspection.latestPdfUrl) continue;
    return inspection.hasDeepRead ? inspection.latestPdfUrl : '';
  }
  return '';
};

const loadState = (): DockState => {
  if (typeof window === 'undefined') {
    return { url: '', visible: false };
  }
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return { url: '', visible: false };
    const parsed = JSON.parse(raw) as Partial<DockState>;
    const url = clampUrl(parsed.url || '');
    if (!url || !isRenderablePdfUrl(url)) return { url: '', visible: false };
    return { url, visible: parsed.visible !== false };
  } catch {
    return { url: '', visible: false };
  }
};

const saveState = (state: DockState) => {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    return;
  }
};

const parseEvidenceFocus = (detail: unknown): DeepReadEvidenceFocus | null => {
  if (!detail || typeof detail !== 'object') return null;
  const record = detail as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const text = typeof record.text === 'string' ? record.text.trim() : '';
  const bbox = typeof record.bbox === 'string' ? record.bbox.trim() : '';
  const rawPage = record.page;
  let page: number | null = null;
  if (typeof rawPage === 'number' && Number.isFinite(rawPage) && rawPage > 0) {
    page = Math.floor(rawPage);
  } else if (typeof rawPage === 'string' && /^\d+$/.test(rawPage.trim())) {
    const parsed = Number(rawPage.trim());
    if (parsed > 0) page = parsed;
  }
  if (!page && id) {
    const match = id.match(/^P(\d+)-S\d+$/i);
    if (match) {
      const parsed = Number(match[1]);
      if (Number.isFinite(parsed) && parsed > 0) {
        page = Math.floor(parsed);
      }
    }
  }
  if (!id && !text) return null;
  return {
    id,
    page,
    text,
    bbox,
    ts: Date.now()
  };
};

export const useDeepReadPdfDock = () => {
  const { messages } = useChatMessages();
  const [state, setState] = useState<DockState>(() => loadState());
  const [evidenceFocus, setEvidenceFocus] = useState<DeepReadEvidenceFocus | null>(
    null
  );

  const latestPdfUrl = useMemo(() => {
    return findLatestDeepReadPdfUrl(messages as IStep[]);
  }, [messages]);

  useEffect(() => {
    if (!latestPdfUrl) {
      setState((prev) => {
        if (!prev.url && !prev.visible) return prev;
        return { url: '', visible: false };
      });
      return;
    }

    setState((prev) => {
      if (prev.url === latestPdfUrl && prev.visible) return prev;
      if (!prev.url) return { url: latestPdfUrl, visible: true };

      const prevLocal = isLocalCachedPdfUrl(prev.url);
      const nextLocal = isLocalCachedPdfUrl(latestPdfUrl);
      if (prevLocal && !nextLocal) {
        // Keep a stable local cached PDF instead of bouncing to remote URLs.
        return prev;
      }

      const prevScore = scoreCandidate(prev.url, 'state');
      const nextScore = scoreCandidate(latestPdfUrl, 'auto');
      if (nextScore < prevScore) return prev;
      if (nextScore === prevScore && !nextLocal) return prev;

      return { url: latestPdfUrl, visible: true };
    });
  }, [latestPdfUrl]);

  useEffect(() => {
    saveState(state);
  }, [state]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onEvidenceFocus = (event: Event) => {
      const custom = event as CustomEvent;
      const parsed = parseEvidenceFocus(custom.detail);
      if (!parsed) return;
      setEvidenceFocus({ ...parsed, ts: Date.now() });
      setState((prev) => (prev.url ? { ...prev, visible: true } : prev));
    };
    window.addEventListener('sci:deepread-evidence', onEvidenceFocus as EventListener);
    return () => {
      window.removeEventListener(
        'sci:deepread-evidence',
        onEvidenceFocus as EventListener
      );
    };
  }, []);

  const close = useCallback(() => {
    setState((prev) => ({ ...prev, visible: false }));
  }, []);

  const open = useCallback(() => {
    setState((prev) => (prev.url ? { ...prev, visible: true } : prev));
  }, []);

  const setUrl = useCallback((url: string) => {
    const normalized = clampUrl(url);
    if (!normalized || !isRenderablePdfUrl(normalized)) return;
    setState({ url: normalized, visible: true });
  }, []);

  return {
    pdfUrl: state.url,
    showPdfDock: state.visible && !!state.url,
    closePdfDock: close,
    openPdfDock: open,
    setPdfDockUrl: setUrl,
    evidenceFocus
  };
};
