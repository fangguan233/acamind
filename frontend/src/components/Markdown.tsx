import { cn } from '@/lib/utils';
import { omit } from 'lodash';
import { useCallback, useContext, useMemo } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import { PluggableList } from 'react-markdown/lib';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import remarkDirective from 'remark-directive';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { visit } from 'unist-util-visit';
import { useNavigate } from 'react-router-dom';
import { useRecoilValue } from 'recoil';
import { toast } from 'sonner';

import {
  ChainlitContext,
  sessionIdState,
  type IMessageElement,
  useChatInteract
} from '@chainlit/react-client';
import { remarkMathTextFix } from '@/lib/remarkMathTextFix';

import { AspectRatio } from '@/components/ui/aspect-ratio';
import { Card } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table';

import BlinkingCursor from './BlinkingCursor';
import CodeSnippet from './CodeSnippet';
import { ElementRef } from './Elements/ElementRef';
import {
  type AlertProps,
  MarkdownAlert,
  alertComponents,
  normalizeAlertType
} from './MarkdownAlert';

interface Props {
  allowHtml?: boolean;
  latex?: boolean;
  refElements?: IMessageElement[];
  children: string;
  className?: string;
}

const cursorPlugin = () => {
  return (tree: any) => {
    visit(tree, 'text', (node: any, index, parent) => {
      const placeholderPattern = /\u200B/g;
      const matches = [...(node.value?.matchAll(placeholderPattern) || [])];

      if (matches.length > 0) {
        const newNodes: any[] = [];
        let lastIndex = 0;

        matches.forEach((match) => {
          const [fullMatch] = match;
          const startIndex = match.index!;
          const endIndex = startIndex + fullMatch.length;

          if (startIndex > lastIndex) {
            newNodes.push({
              type: 'text',
              value: node.value!.slice(lastIndex, startIndex)
            });
          }

          newNodes.push({
            type: 'blinkingCursor',
            data: {
              hName: 'blinkingCursor',
              hProperties: { text: 'Blinking Cursor' }
            }
          });

          lastIndex = endIndex;
        });

        if (lastIndex < node.value!.length) {
          newNodes.push({
            type: 'text',
            value: node.value!.slice(lastIndex)
          });
        }

        parent!.children.splice(index, 1, ...newNodes);
      }
    });
  };
};

const foldDirectivePlugin = () => {
  return (tree: any) => {
    visit(tree, (node: any) => {
      if (node?.type !== 'containerDirective' || node?.name !== 'fold') {
        return;
      }
      const rawTitle =
        typeof node?.attributes?.title === 'string'
          ? node.attributes.title
          : '详情';
      const title = rawTitle.trim() || '详情';
      node.data = {
        ...(node.data || {}),
        hName: 'foldsection',
        hProperties: { title }
      };
    });
  };
};

const FoldSection = ({
  title,
  children
}: {
  title?: string;
  children?: any;
}) => {
  return (
    <details className="my-4 rounded-xl border border-border/70 bg-muted/20 px-4 py-3">
      <summary className="cursor-pointer list-none select-none text-base font-semibold text-foreground marker:hidden">
        <span className="inline-flex items-center gap-2">
          <span>{title || '详情'}</span>
          <span className="text-xs font-normal text-muted-foreground">
            点击展开
          </span>
        </span>
      </summary>
      <div className="mt-4">{children}</div>
    </details>
  );
};

const shouldAutoDisplayMathLine = (line: string): boolean => {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (trimmed.includes('$')) return false;
  if (/^```/.test(trimmed)) return false;
  if (/^>/.test(trimmed)) return false;
  if (/^#+\s/.test(trimmed)) return false;
  if (/^(- |\d+\.)/.test(trimmed)) return false;
  if (/\|/.test(trimmed)) return false;
  if (
    /\\(section|subsection|subsubsection|textbf|textit|textcolor|begin|end|item|noindent|vspace|hspace|geometry|maketitle)\b/i.test(
      trimmed
    )
  ) {
    return false;
  }
  if (!/\\[a-zA-Z]+/.test(trimmed)) return false;
  if (
    !/(\\oint|\\iint|\\int|\\sum|\\prod|\\lim|\\frac|\\partial|\\sqrt|\\cdot|\\times|\\leq|\\geq|\\neq|\\to|\\rightarrow|\\leftarrow|\\leftrightarrow|\\Rightarrow|\\Leftarrow|\\xrightarrow|\\xleftarrow|\\nabla|\\infty|\\equiv|\\approx|\\tag)\b/i.test(
      trimmed
    )
  ) {
    return false;
  }
  return true;
};

const autoWrapBareMathLinesMarkdown = (input: string): string => {
  if (!input) return input;
  const lines = input.split(/\r?\n/);
  const out: string[] = [];
  let buffer: string[] = [];
  let inFence = false;
  let fenceMarker = '';
  let inDisplayMath = false;

  const flush = () => {
    if (!buffer.length) return;
    out.push('$$', buffer.join('\n'), '$$');
    buffer = [];
  };

  for (const line of lines) {
    const fenceMatch = line.match(/^```+/);
    if (fenceMatch) {
      flush();
      const marker = fenceMatch[0];
      if (inFence && line.startsWith(fenceMarker)) {
        inFence = false;
        fenceMarker = '';
      } else if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      }
      out.push(line);
      continue;
    }

    if (inFence) {
      out.push(line);
      continue;
    }

    const singleLineDisplay = line.match(/^\s*\$\$([\s\S]*?)\$\$\s*$/);
    if (singleLineDisplay && !singleLineDisplay[1].includes('\n')) {
      flush();
      out.push('$$', singleLineDisplay[1].trim(), '$$');
      continue;
    }

    const hasBeginEnv =
      /\\begin\{(equation\*?|align\*?|aligned|gather\*?|multline\*?)\}/i.test(
        line
      );
    const hasEndEnv =
      /\\end\{(equation\*?|align\*?|aligned|gather\*?|multline\*?)\}/i.test(
        line
      );
    const hasOpenBracket = /\\\[/.test(line);
    const hasCloseBracket = /\\\]/.test(line);
    const dollarCount = (line.match(/(^|[^\\])\$\$/g) || []).length;

    if (hasBeginEnv || hasEndEnv || hasOpenBracket || hasCloseBracket || dollarCount) {
      flush();
      out.push(line);
      if (hasBeginEnv) inDisplayMath = true;
      if (hasEndEnv) inDisplayMath = false;
      if (hasOpenBracket) inDisplayMath = true;
      if (hasCloseBracket) inDisplayMath = false;
      if (dollarCount % 2 === 1) inDisplayMath = !inDisplayMath;
      continue;
    }

    if (inDisplayMath) {
      out.push(line);
      continue;
    }

    if (shouldAutoDisplayMathLine(line)) {
      buffer.push(line.trim());
      continue;
    }

    flush();
    out.push(line);
  }

  flush();
  return out.join('\n');
};

const normalizeLatexDelimitersMarkdown = (input: string): string => {
  if (!input) return input;
  const lines = input.split(/\r?\n/);
  const out: string[] = [];
  let inFence = false;
  let fenceMarker = '';

  for (let line of lines) {
    const fenceMatch = line.match(/^```+/);
    if (fenceMatch) {
      const marker = fenceMatch[0];
      if (inFence && line.startsWith(fenceMarker)) {
        inFence = false;
        fenceMarker = '';
      } else if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      }
      out.push(line);
      continue;
    }

    if (inFence) {
      out.push(line);
      continue;
    }

    const trimmed = line.trim();
    // Support both "\[" and "\\[" (some models over-escape backslashes in Markdown output).
    if (/^(?:\\){1,2}\[$/.test(trimmed) || /^(?:\\){1,2}\]$/.test(trimmed)) {
      out.push('$$');
      continue;
    }

    // Convert \[ ... \] / \\[ ... \\] (same line) to $$ ... $$ for Markdown math parsing.
    line = line.replace(
      /(?:\\){1,2}\[(.+?)(?:\\){1,2}\]/g,
      (_m, inner) => `$$${inner}$$`
    );

    // Convert \( ... \) / \\( ... \\) to $ ... $ for Markdown math parsing.
    line = line.replace(
      /(?:\\){1,2}\((.+?)(?:\\){1,2}\)/g,
      (_m, inner) => `$${inner}$`
    );

    out.push(line);
  }

  return out.join('\n');
};

const Markdown = ({
  allowHtml,
  latex,
  refElements,
  className,
  children
}: Props) => {
  const apiClient = useContext(ChainlitContext);
  const sessionId = useRecoilValue(sessionIdState);
  const navigate = useNavigate();
  const { clear } = useChatInteract();
  const processedChildren = useMemo(() => {
    if (!latex) return children;
    return autoWrapBareMathLinesMarkdown(
      normalizeLatexDelimitersMarkdown(children)
    );
  }, [children, latex]);

  const emitEvidenceFocus = useCallback((href: string) => {
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      return false;
    }
    if (url.hostname !== 'evidence') return false;

    const id = (url.searchParams.get('id') || '').trim();
    const text = (url.searchParams.get('text') || '').trim();
    const bbox = (url.searchParams.get('bbox') || '').trim();
    const rawPage = (url.searchParams.get('page') || '').trim();
    const page = /^\d+$/.test(rawPage) ? Number(rawPage) : null;
    if (!id && !text) return false;

    try {
      window.dispatchEvent(
        new CustomEvent('sci:deepread-evidence', {
          detail: {
            id,
            page: page && page > 0 ? page : null,
            text,
            bbox
          }
        })
      );
      return true;
    } catch {
      return false;
    }
  }, []);

  const handleClLink = useCallback(
    async (href: string) => {
      const PENDING_MESSAGE_KEY = 'acamind_pending_message_v1';
      let url: URL;
      try {
        url = new URL(href);
      } catch (err) {
        toast.error(String(err));
        return;
      }

      if (url.hostname === 'evidence') {
        emitEvidenceFocus(href);
        return;
      }

      if (url.hostname === 'action') {
        const actionName = url.pathname.replace(/^\//, '').trim();
        if (!actionName) return;
        const payload: Record<string, unknown> = {};
        url.searchParams.forEach((value, key) => {
          const trimmed = value.trim();
          if (/^-?\d+$/.test(trimmed)) {
            payload[key] = Number(trimmed);
          } else if (trimmed === 'true' || trimmed === 'false') {
            payload[key] = trimmed === 'true';
          } else {
            payload[key] = trimmed;
          }
        });
        try {
          await apiClient.callAction(
            {
              name: actionName,
              payload,
              label: actionName,
              tooltip: '',
              id: '',
              forId: ''
            } as any,
            sessionId
          );
        } catch (err) {
          toast.error(String(err));
        }
        return;
      }

      if (url.hostname === 'deepread') {
        const identifier = (url.searchParams.get('identifier') || '').trim();
        if (!identifier) {
          toast.error('Missing paper identifier');
          return;
        }
        const question = (url.searchParams.get('question') || '').trim();
        const title = (url.searchParams.get('title') || '').trim();
        const command = (url.searchParams.get('command') || '学术查询').trim();

        const parts: string[] = [`精读 ${identifier}`];
        parts.push(
          '要求：请先精读论文并用中文分析其主要工作（研究问题、方法/流程、关键结果、贡献、局限），然后再回答“用户问题”。'
        );
        if (title) {
          parts.push(`论文标题：${title}`);
        }
        if (question) {
          parts.push(`用户问题：${question}`);
        }
        const message = parts.join('\n\n').trim();

        try {
          window.sessionStorage.setItem(
            PENDING_MESSAGE_KEY,
            JSON.stringify({ message, command })
          );
        } catch (err) {
          toast.error(String(err));
          return;
        }

        clear({ preserveSettings: true });
        navigate('/');
        return;
      }
    },
    [apiClient, sessionId, clear, navigate, emitEvidenceFocus]
  );

  const handleMarkdownClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest('a') as HTMLAnchorElement | null;
      if (!anchor) return;
      const clHref =
        anchor.getAttribute('data-cl-href') || anchor.getAttribute('href') || '';
      if (!clHref.startsWith('cl://')) return;
      e.preventDefault();
      e.stopPropagation();
      void handleClLink(clHref);
    },
    [handleClLink]
  );

  const rehypePlugins = useMemo(() => {
    let rehypePlugins: PluggableList = [];
    if (allowHtml) {
      rehypePlugins = [rehypeRaw as any, ...rehypePlugins];
    }
    if (latex) {
      rehypePlugins = [
        [
          rehypeKatex as any,
          {
            throwOnError: false,
            strict: 'ignore',
            trust: false
          }
        ],
        ...rehypePlugins
      ];
    }
    return rehypePlugins;
  }, [allowHtml, latex]);

  const remarkPlugins = useMemo(() => {
    let remarkPlugins: PluggableList = [
      cursorPlugin,
      remarkGfm as any,
      remarkDirective as any,
      foldDirectivePlugin as any,
      MarkdownAlert
    ];

    if (latex) {
      remarkPlugins = [
        ...remarkPlugins,
        remarkMath as any,
        remarkMathTextFix as any
      ];
    }
    return remarkPlugins;
  }, [latex]);

  const markdownUrlTransform = useCallback((rawUrl: string) => {
    const url = (rawUrl || '').trim();
    if (url.toLowerCase().startsWith('cl://')) {
      return url;
    }
    return defaultUrlTransform(url);
  }, []);

  return (
    <div onClick={handleMarkdownClick}>
      <ReactMarkdown
        className={cn('prose lg:prose-xl', className)}
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        urlTransform={markdownUrlTransform}
        components={{
          ...alertComponents, // add alert components
          code(props) {
            return (
              <code
                {...omit(props, ['node'])}
                className="relative rounded bg-muted px-[0.3rem] py-[0.2rem] font-mono text-sm font-semibold"
              />
            );
          },
          pre({ children, ...props }: any) {
            return (
              <CodeSnippet
                {...props}
                allowHtml={allowHtml}
                latex={latex}
                markdownCodeBlockDepth={0}
                maxMarkdownCodeBlockDepth={1}
              />
            );
          },
          a({ children, ...props }) {
            const href = typeof props.href === 'string' ? props.href : '';
            const dataClHref =
              typeof (props as any)['data-cl-href'] === 'string'
                ? ((props as any)['data-cl-href'] as string)
                : '';
            const effectiveHref = (dataClHref || href).trim();
            const isClLink = effectiveHref.startsWith('cl://');
            const isEvidenceLink = (() => {
              if (!isClLink) return false;
              try {
                return new URL(effectiveHref).hostname === 'evidence';
              } catch {
                return false;
              }
            })();
            const flatText =
              typeof children === 'string'
                ? children
                : Array.isArray(children) &&
                    children.length === 1 &&
                    typeof children[0] === 'string'
                  ? children[0]
                  : '';
            const element = flatText
              ? refElements?.find((e) => e.name === flatText)
              : undefined;
            if (element) {
              return <ElementRef element={element} />;
            }
            return (
              <a
                {...props}
                className={cn('text-primary hover:underline', props.className)}
                target={isClLink ? undefined : '_blank'}
                rel={isClLink ? undefined : 'noreferrer'}
                onMouseEnter={
                  isEvidenceLink
                    ? (event) => {
                        if (props.onMouseEnter) {
                          (props.onMouseEnter as any)(event);
                        }
                        emitEvidenceFocus(effectiveHref);
                      }
                    : props.onMouseEnter
                }
                onFocus={
                  isEvidenceLink
                    ? (event) => {
                        if (props.onFocus) {
                          (props.onFocus as any)(event);
                        }
                        emitEvidenceFocus(effectiveHref);
                      }
                    : props.onFocus
                }
                onClick={
                  isClLink
                    ? async (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        await handleClLink(effectiveHref);
                      }
                    : props.onClick
                }
              >
                {children}
              </a>
            );
          },
          img: (image: any) => {
          // Check if the image source is actually a video file
          const src = image.src.startsWith('/public')
            ? apiClient.buildEndpoint(image.src)
            : image.src;
          
          const videoExtensions = ['.mp4', '.webm', '.mov', '.avi', '.ogv', '.m4v'];
          const isVideo = videoExtensions.some(ext => 
            src.toLowerCase().split(/[?#]/)[0].endsWith(ext)
          );

          if (isVideo) {
            return (
              <div className="sm:max-w-sm md:max-w-md">
                <video
                  src={src}
                  controls
                  className="w-full h-auto rounded-md"
                  style={{ maxWidth: '100%' }}
                >
                  Your browser does not support the video tag.
                </video>
              </div>
            );
          }

          return (
            <div className="sm:max-w-sm md:max-w-md">
              <AspectRatio
                ratio={16 / 9}
                className="bg-muted rounded-md overflow-hidden"
              >
                <img
                  src={src}
                  alt={image.alt}
                  className="h-full w-full object-contain"
                />
              </AspectRatio>
            </div>
          );
          },
          blockquote(props) {
          return (
            <blockquote
              {...omit(props, ['node'])}
              className="mt-6 border-l-2 pl-6 italic"
            />
          );
          },
          em(props) {
          return <span {...omit(props, ['node'])} className="italic" />;
          },
          strong(props) {
          return <span {...omit(props, ['node'])} className="font-bold" />;
          },
          hr() {
          return <Separator />;
          },
          ul(props) {
          return (
            <ul
              {...omit(props, ['node'])}
              className="my-3 ml-3 list-disc pl-2 [&>li]:mt-1"
            />
          );
          },
          ol(props) {
          return (
            <ol
              {...omit(props, ['node'])}
              className="my-3 ml-3 list-decimal pl-2 [&>li]:mt-1"
            />
          );
          },
          h1(props) {
          return (
            <h1
              {...omit(props, ['node'])}
              className="scroll-m-20 text-4xl font-extrabold tracking-tight lg:text-5xl mt-8 first:mt-0"
            />
          );
          },
          h2(props) {
          return (
            <h2
              {...omit(props, ['node'])}
              className="scroll-m-20 border-b pb-2 text-3xl font-semibold tracking-tight mt-8 first:mt-0"
            />
          );
          },
          h3(props) {
          return (
            <h3
              {...omit(props, ['node'])}
              className="scroll-m-20 text-2xl font-semibold tracking-tight mt-6 first:mt-0"
            />
          );
          },
          h4(props) {
          return (
            <h4
              {...omit(props, ['node'])}
              className="scroll-m-20 text-xl font-semibold tracking-tight mt-6 first:mt-0"
            />
          );
          },
          p(props) {
          return (
            <div
              {...omit(props, ['node'])}
              className="leading-7 [&:not(:first-child)]:mt-4 whitespace-pre-wrap break-words"
              role="article"
            />
          );
          },
          table({ children, ...props }) {
          return (
            <Card className="[&:not(:first-child)]:mt-2 [&:not(:last-child)]:mb-2">
              <Table {...(props as any)}>{children}</Table>
            </Card>
          );
          },
          thead({ children, ...props }) {
          return <TableHeader {...(props as any)}>{children}</TableHeader>;
          },
          tr({ children, ...props }) {
          return <TableRow {...(props as any)}>{children}</TableRow>;
          },
          th({ children, ...props }) {
          return <TableHead {...(props as any)}>{children}</TableHead>;
          },
          td({ children, ...props }) {
          return <TableCell {...(props as any)}>{children}</TableCell>;
          },
          tbody({ children, ...props }) {
          return <TableBody {...(props as any)}>{children}</TableBody>;
          },
          // @ts-expect-error custom plugin
          blinkingCursor: () => <BlinkingCursor whitespace />,
          alert: ({
            type,
            children,
            ...props
          }: AlertProps & { type?: string }) => {
            const alertType = normalizeAlertType(type || props.variant || 'info');
            return alertComponents.Alert({ variant: alertType, children });
          },
          foldsection: ({
            title,
            children
          }: {
            title?: string;
            children?: any;
          }) => {
            return <FoldSection title={title}>{children}</FoldSection>;
          }
        }}
      >
        {processedChildren}
      </ReactMarkdown>
    </div>
  );
};

export { Markdown };
