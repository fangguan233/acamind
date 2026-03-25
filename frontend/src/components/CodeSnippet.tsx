import { cn } from '@/lib/utils';
import asciimath2latex from 'asciimath-to-latex';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import katex from 'katex';
import getRouterBasename from '@/lib/router';
import { MathMLToLaTeX } from 'mathml-to-latex';
import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { fixMathText, remarkMathTextFix } from '@/lib/remarkMathTextFix';

import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

import 'highlight.js/styles/monokai-sublime.css';

import CopyButton from './CopyButton';

interface CodeSnippetProps {
  language: string;
  children: string;
}

const stripLatexMathDelimiters = (input: string): string => {
  let value = input.trim();
  if (!value) return value;

  const lines = value.split(/\r?\n/);
  if (lines.length >= 2) {
    const first = lines[0]?.trim();
    const last = lines[lines.length - 1]?.trim();
    if (first === '$$' && last === '$$') {
      value = lines.slice(1, -1).join('\n').trim();
    } else if (first === '\\[' && last === '\\]') {
      value = lines.slice(1, -1).join('\n').trim();
    } else if (first === '\\(' && last === '\\)') {
      value = lines.slice(1, -1).join('\n').trim();
    }
  }

  if (value.startsWith('$$') && value.endsWith('$$') && value.length >= 4) {
    return value.slice(2, -2).trim();
  }
  if (value.startsWith('\\[') && value.endsWith('\\]') && value.length >= 4) {
    return value.slice(2, -2).trim();
  }
  if (value.startsWith('\\(') && value.endsWith('\\)') && value.length >= 4) {
    return value.slice(2, -2).trim();
  }
  if (
    value.startsWith('$') &&
    value.endsWith('$') &&
    !value.startsWith('$$') &&
    !value.endsWith('$$') &&
    value.length >= 2
  ) {
    return value.slice(1, -1).trim();
  }

  return value;
};

const extractLatexDisplayBlocks = (input: string): string[] => {
  const blocks: string[] = [];

  for (const match of input.matchAll(/\$\$([\s\S]+?)\$\$/g)) {
    const inner = match[1]?.trim();
    if (inner) blocks.push(inner);
  }

  for (const match of input.matchAll(/\\\[([\s\S]+?)\\\]/g)) {
    const inner = match[1]?.trim();
    if (inner) blocks.push(inner);
  }

  for (const match of input.matchAll(
    /\\begin\{(equation\*?|align\*?|aligned|gather\*?|multline\*?)\}([\s\S]+?)\\end\{\1\}/g
  )) {
    const full = match[0]?.trim();
    if (full) blocks.push(full);
  }

  return blocks;
};

const extractMathMLBlocks = (input: string): string[] => {
  const blocks = [...input.matchAll(/<math[\s\S]*?<\/math>/gi)].map(
    (m) => m[0] || ''
  );
  return blocks.filter(Boolean);
};

const extractHtmlBodyInner = (input: string): string => {
  const bodyMatch = input.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch?.[1]) return bodyMatch[1];
  return input;
};

const extractHtmlHeadInner = (input: string): string => {
  const headMatch = input.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
  return headMatch?.[1] ?? '';
};

const extractHtmlStyleTexts = (input: string): string[] => {
  const styles: string[] = [];
  for (const match of input.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    const css = match[1]?.trim();
    if (css) styles.push(css);
  }
  return styles;
};

const isKatexErrorHtml = (html: string): boolean => {
  return html.includes('katex-error');
};

const stripMathMLAttributesForConvert = (input: string): string => {
  return input
    .replace(/\s+xmlns(:\w+)?=("([^"]*)"|'([^']*)')/gi, '')
    .replace(
      /<([a-zA-Z][\w:-]*)(\s+[^>]*?)?(\/?)>/g,
      (_match, tagName: string, _attrs: string | undefined, selfClose: string) =>
        `<${tagName}${selfClose === '/' ? '/' : ''}>`
    );
};

const joinRootPath = (rootPath: string, path: string): string => {
  const cleanRoot = (rootPath || '').replace(/\/$/, '');
  const cleanPath = path.replace(/^\//, '');
  if (!cleanRoot) return `/${cleanPath}`;
  return `${cleanRoot}/${cleanPath}`;
};

const SUPPORTED_TEX_PACKAGES = new Set([
  'chemfig',
  'tikz-cd',
  'circuitikz',
  'pgfplots',
  'array',
  'amsmath',
  'amstext',
  'amsfonts',
  'amssymb',
  'xcolor',
  'tikz-3dplot'
]);

const DEFAULT_CHEMFIG_TEX_PACKAGES: Record<string, string> = { chemfig: '' };

const stripPackageAndClassLines = (input: string): string => {
  return input
    .replace(/^\s*\\documentclass[^\n]*\n?/gim, '')
    .replace(
      /^\s*\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{[^}]*\}\s*\n?/gim,
      ''
    )
    .replace(/^\s*\\usetikzlibrary\{[^}]*\}\s*\n?/gim, '')
    .replace(/^\s*\\begin\{document\}\s*\n?/gim, '')
    .replace(/^\s*\\end\{document\}\s*\n?/gim, '')
    .trim();
};

const splitLatexDocument = (input: string) => {
  const match = input.match(
    /([\s\S]*?)\\begin\{document\}([\s\S]*?)\\end\{document\}/i
  );
  if (match) {
    return {
      preamble: match[1] ?? '',
      body: match[2] ?? ''
    };
  }
  return { preamble: '', body: input };
};

const parseTexPackages = (input: string) => {
  const packages: Record<string, string> = {};
  const unsupported: string[] = [];
  for (const match of input.matchAll(
    /\\(?:usepackage|RequirePackage)(?:\[([^\]]*)\])?\{([^}]*)\}/gi
  )) {
    const options = (match[1] ?? '').trim();
    const names = (match[2] ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    for (const name of names) {
      if (SUPPORTED_TEX_PACKAGES.has(name)) {
        packages[name] = options;
      } else {
        unsupported.push(name);
      }
    }
  }
  return { packages, unsupported };
};

const parseTikzLibraries = (
  input: string,
  defaults: string[] = []
): string => {
  const libs = new Set<string>(defaults);
  for (const match of input.matchAll(/\\usetikzlibrary\{([^}]*)\}/gi)) {
    const names = (match[1] ?? '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    for (const name of names) libs.add(name);
  }
  return Array.from(libs).join(',');
};

const extractTikzPictures = (input: string): string[] => {
  return [...input.matchAll(/\\begin\{tikzpicture\}[\s\S]*?\\end\{tikzpicture\}/gi)]
    .map((match) => match[0] || '')
    .filter(Boolean);
};

const splitLatexByTikzPictures = (
  input: string
): Array<{ type: 'text' | 'tikz'; content: string }> => {
  const parts: Array<{ type: 'text' | 'tikz'; content: string }> = [];
  const beginRegex = /\\begin\{tikzpicture\}/gi;
  const endRegex = /\\end\{tikzpicture\}/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = beginRegex.exec(input))) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      parts.push({
        type: 'text',
        content: input.slice(lastIndex, start)
      });
    }

    endRegex.lastIndex = beginRegex.lastIndex;
    const endMatch = endRegex.exec(input);
    if (!endMatch) {
      parts.push({ type: 'tikz', content: input.slice(start) });
      lastIndex = input.length;
      break;
    }

    const endIndex = (endMatch.index ?? 0) + endMatch[0].length;
    parts.push({ type: 'tikz', content: input.slice(start, endIndex) });
    lastIndex = endIndex;
    beginRegex.lastIndex = endIndex;
  }

  if (lastIndex < input.length) {
    parts.push({ type: 'text', content: input.slice(lastIndex) });
  }

  return parts;
};

const readBalanced = (
  input: string,
  startIndex: number,
  openChar: string,
  closeChar: string
) => {
  if (input[startIndex] !== openChar) return null;
  let depth = 0;
  for (let i = startIndex; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === openChar) depth += 1;
    if (ch === closeChar) depth -= 1;
    if (depth === 0) {
      return { content: input.slice(startIndex, i + 1), endIndex: i + 1 };
    }
  }
  return null;
};

const extractChemfigCommands = (input: string): string[] => {
  const results: string[] = [];
  const matcher = /\\chemfig\b/g;
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(input))) {
    let idx = match.index + match[0].length;
    while (/\s/.test(input[idx] || '')) idx += 1;

    let options = '';
    if (input[idx] === '[') {
      const opt = readBalanced(input, idx, '[', ']');
      if (opt) {
        options = opt.content;
        idx = opt.endIndex;
      }
    }

    while (/\s/.test(input[idx] || '')) idx += 1;
    if (input[idx] !== '{') continue;

    const body = readBalanced(input, idx, '{', '}');
    if (!body) continue;

    results.push(`\\chemfig${options}${body.content}`);
    matcher.lastIndex = body.endIndex;
  }

  return results;
};

const extractChemfigSchemes = (input: string): string[] => {
  return [
    ...input.matchAll(/\\schemestart[\s\S]*?\\schemestop/gi)
  ]
    .map((match) => match[0] || '')
    .filter(Boolean);
};

const splitLatexBySchemes = (
  input: string
): Array<{ type: 'text' | 'scheme'; content: string }> => {
  const parts: Array<{ type: 'text' | 'scheme'; content: string }> = [];
  let lastIndex = 0;
  for (const match of input.matchAll(/\\schemestart[\s\S]*?\\schemestop/gi)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      parts.push({
        type: 'text',
        content: input.slice(lastIndex, start)
      });
    }
    parts.push({ type: 'scheme', content: match[0] || '' });
    lastIndex = start + (match[0]?.length || 0);
  }
  if (lastIndex < input.length) {
    parts.push({ type: 'text', content: input.slice(lastIndex) });
  }
  return parts;
};

const stripChemfigSchemes = (input: string): string =>
  input.replace(/\\schemestart[\s\S]*?\\schemestop/gi, '');

const stripCeCommands = (input: string): string => {
  if (!input.includes('\\ce')) return input;
  let result = '';
  const matcher = /\\ce\b/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(input))) {
    result += input.slice(lastIndex, match.index);
    let idx = match.index + match[0].length;
    while (/\s/.test(input[idx] || '')) idx += 1;
    if (input[idx] !== '{') {
      lastIndex = match.index + match[0].length;
      continue;
    }
    const body = readBalanced(input, idx, '{', '}');
    if (!body) {
      lastIndex = match.index + match[0].length;
      continue;
    }
    lastIndex = body.endIndex;
    matcher.lastIndex = body.endIndex;
  }

  result += input.slice(lastIndex);
  return result;
};

const stripNonAscii = (input: string): string =>
  input.replace(/[^\x00-\x7F]/g, '');

const trimUnbalancedTail = (input: string): string => {
  let balance = 0;
  let lastBalancedIndex = -1;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === '{' && input[i - 1] !== '\\') balance += 1;
    if (ch === '}' && input[i - 1] !== '\\') balance -= 1;
    if (balance === 0) lastBalancedIndex = i;
  }
  if (balance > 0 && lastBalancedIndex >= 0) {
    return input.slice(0, lastBalancedIndex + 1);
  }
  return input;
};

const sanitizeTabularBlocks = (input: string): string => {
  const beginRegex = /\\begin\s*\{tabular\}/gi;
  const endRegex = /\\end\s*\{tabular\}/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let output = '';

  while ((match = beginRegex.exec(input))) {
    const start = match.index ?? 0;
    let idx = start + match[0].length;
    while (/\s/.test(input[idx] || '')) idx += 1;

    let headerEnd = idx;
    if (input[idx] === '{') {
      const spec = readBalanced(input, idx, '{', '}');
      if (spec) {
        headerEnd = spec.endIndex;
      }
    }

    output += input.slice(lastIndex, headerEnd);

    endRegex.lastIndex = headerEnd;
    const endMatch = endRegex.exec(input);
    const contentEnd = endMatch ? endMatch.index ?? input.length : input.length;
    const content = input.slice(headerEnd, contentEnd);

    const breakRegex = /\\\\(?:\[[^\]]*\])?|\\tabularnewline/gi;
    let lastBreakIndex = -1;
    let breakMatch: RegExpExecArray | null;
    while ((breakMatch = breakRegex.exec(content))) {
      lastBreakIndex = breakMatch.index + breakMatch[0].length;
    }

    const trimmed =
      lastBreakIndex >= 0 ? content.slice(0, lastBreakIndex) : '';
    output += trimmed;

    if (endMatch) {
      output += endMatch[0];
      lastIndex = (endMatch.index ?? 0) + endMatch[0].length;
      beginRegex.lastIndex = lastIndex;
      continue;
    }

    lastIndex = input.length;
    break;
  }

  if (lastIndex < input.length) {
    output += input.slice(lastIndex);
  }

  return output;
};

const autoCloseTikzBlocks = (input: string): string => {
  let value = sanitizeTabularBlocks(input);

  const countEnv = (env: string) => {
    const beginRegex = new RegExp(`\\\\begin\\s*\\{${env}\\}`, 'gi');
    const endRegex = new RegExp(`\\\\end\\s*\\{${env}\\}`, 'gi');
    const begins = (value.match(beginRegex) || []).length;
    const ends = (value.match(endRegex) || []).length;
    return { begins, ends };
  };

  const { begins: tabularBegins, ends: tabularEnds } = countEnv('tabular');
  const { begins: scopeBegins, ends: scopeEnds } = countEnv('scope');
  const { begins: tikzBegins, ends: tikzEnds } = countEnv('tikzpicture');

  if (tabularBegins > tabularEnds) {
    value +=
      '\n' +
      Array(tabularBegins - tabularEnds)
        .fill(`\\end{tabular}`)
        .join('\n');
  }

  value = trimUnbalancedTail(value);

  const lastSemicolon = value.lastIndexOf(';');
  const tail = lastSemicolon >= 0 ? value.slice(lastSemicolon + 1) : value;
  if (
    /\\(?:node|draw|path|fill|filldraw|shade|shadedraw|clip|coordinate|matrix|pic|graph|foreach)\b/i.test(
      tail
    )
  ) {
    value += '\n;';
  }

  if (scopeBegins > scopeEnds) {
    value +=
      '\n' +
      Array(scopeBegins - scopeEnds)
        .fill(`\\end{scope}`)
        .join('\n');
  }
  if (tikzBegins > tikzEnds) {
    value +=
      '\n' +
      Array(tikzBegins - tikzEnds)
        .fill(`\\end{tikzpicture}`)
        .join('\n');
  }

  return value;
};

const sanitizePreambleForTikzjax = (input: string): string => {
  if (!input) return '';
  const allowlist = [
    /^\\(?:re)?newcommand\b/i,
    /^\\def\b/i,
    /^\\DeclareMathOperator\*?\b/i,
    /^\\(?:re)?newenvironment\b/i,
    /^\\definecolor\b/i,
    /^\\colorlet\b/i,
    /^\\tikzset\b/i,
    /^\\pgfplotsset\b/i,
    /^\\setchemfig\b/i,
    /^\\chemfigset\b/i,
    /^\\setatomsep\b/i,
    /^\\setbondstyle\b/i,
    /^\\setcrambond\b/i,
    /^\\setcharge\b/i,
    /^\\definesubmol\b/i
  ];

  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => Boolean(line) && allowlist.some((re) => re.test(line)))
    .join('\n')
    .trim();
};

const collectPreambleAdditions = (preamble: string, body: string): string => {
  const combined = [preamble, body].filter(Boolean).join('\n');
  return sanitizePreambleForTikzjax(combined);
};

const booktabsFallbackPreamble = (input: string): string => {
  if (!/\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{[^}]*booktabs[^}]*\}/i.test(input)) {
    return '';
  }
  return [
    '\\newcommand{\\toprule}{\\hline}',
    '\\newcommand{\\midrule}{\\hline}',
    '\\newcommand{\\bottomrule}{\\hline}',
    '\\newcommand{\\cmidrule}[1]{\\hline}',
    '\\newcommand{\\addlinespace}[1]{}',
    '\\newcommand{\\specialrule}[3]{\\hline}'
  ].join('\n');
};

const getTikzjaxConfigFromDocument = (input: string) => {
  const { preamble, body } = splitLatexDocument(input);
  const cleanedPreamble = stripPackageAndClassLines(preamble);
  const cleanedBody = stripPackageAndClassLines(body);
  const sanitizedPreamble = collectPreambleAdditions(
    cleanedPreamble,
    cleanedBody
  );
  const fallbackPreamble = booktabsFallbackPreamble(input);
  const { packages } = parseTexPackages(input);
  const hasTikzPicture = /\\begin\{tikzpicture\}/i.test(input);
  const tikzLibraries = parseTikzLibraries(
    input,
    hasTikzPicture ? ['calc'] : []
  );

  const texPackages = { ...packages };
  if (/\\chemfig\b/.test(input)) {
    texPackages.chemfig = texPackages.chemfig ?? '';
  }

  return {
    texPackages: Object.keys(texPackages).length ? texPackages : undefined,
    tikzLibraries: tikzLibraries || undefined,
    addToPreamble:
      [sanitizedPreamble, fallbackPreamble].filter(Boolean).join('\n') ||
      undefined
  };
};

const shouldAutoDisplayMath = (line: string): boolean => {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (trimmed.includes('$')) return false;
  if (/^```/.test(trimmed)) return false;
  if (/^(- |\d+\.)/.test(trimmed)) return false;
  if (/\\(section|subsection|subsubsection|textbf|textit|textcolor|begin|end|item|noindent|vspace|hspace|geometry|maketitle)\b/i.test(trimmed)) {
    return false;
  }
  if (!/\\[a-zA-Z]+/.test(trimmed)) return false;
  if (!/(\\oint|\\iint|\\int|\\sum|\\prod|\\lim|\\frac|\\partial|\\sqrt|\\cdot|\\times|\\leq|\\geq|\\neq|\\to|\\rightarrow|\\leftarrow|\\leftrightarrow|\\Rightarrow|\\Leftarrow|\\xrightarrow|\\xleftarrow|\\nabla|\\infty|\\equiv|\\approx|\\tag)\b/i.test(trimmed)) {
    return false;
  }
  return true;
};

const autoWrapBareMathLines = (input: string): string => {
  if (!input) return input;
  const lines = input.split(/\r?\n/);
  const out: string[] = [];
  let buffer: string[] = [];

  const flush = () => {
    if (!buffer.length) return;
    out.push('$$', buffer.join('\n'), '$$');
    buffer = [];
  };

  for (const line of lines) {
    if (shouldAutoDisplayMath(line)) {
      buffer.push(line.trim());
      continue;
    }
    flush();
    out.push(line);
  }
  flush();
  return out.join('\n');
};

const latexToMarkdown = (input: string): string => {
  let text = input;

  text = text.replace(/^\s*\\documentclass[^\n]*\n?/gim, '');
  text = text.replace(
    /^\s*\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{[^}]*\}\s*\n?/gim,
    ''
  );
  text = text.replace(/^\s*\\usetikzlibrary\{[^}]*\}\s*\n?/gim, '');
  text = text.replace(/^\s*\\definecolor\{[^}]*\}\{[^}]*\}\{[^}]*\}\s*\n?/gim, '');
  text = text.replace(/^\s*\\colorlet\{[^}]*\}\{[^}]*\}\s*\n?/gim, '');
  text = text.replace(/^\s*\\begin\{document\}\s*\n?/gim, '');
  text = text.replace(/^\s*\\end\{document\}\s*\n?/gim, '');

  text = text.replace(/%.*$/gm, '');
  text = text.replace(/\\title\{[\s\S]*?\}\s*/gi, '');
  text = text.replace(/\\author\{[\s\S]*?\}\s*/gi, '');
  text = text.replace(/\\date\{[\s\S]*?\}\s*/gi, '');
  text = text.replace(/\\maketitle\s*/gi, '');
  text = text.replace(/\\section\*\{([\s\S]*?)\}/gi, '\n## $1\n');
  text = text.replace(/\\subsection\*\{([\s\S]*?)\}/gi, '\n### $1\n');
  text = text.replace(/\\subsubsection\*\{([\s\S]*?)\}/gi, '\n#### $1\n');
  text = text.replace(/\\textbf\{([\s\S]*?)\}/gi, '**$1**');
  text = text.replace(/\\textit\{([\s\S]*?)\}/gi, '*$1*');
  text = text.replace(/\\textcolor\{[^}]*\}\{([\s\S]*?)\}/gi, '$1');
  text = text.replace(/\\fontsize\{[^}]*\}\{[^}]*\}\\selectfont\s*/gi, '');
  text = text.replace(/\\selectfont\b/gi, '');
  text = text.replace(/\\newpage\b/gi, '\n');
  text = text.replace(/\\clearpage\b/gi, '\n');
  text = text.replace(/\\pagebreak\b/gi, '\n');
  text = text.replace(
    /\\(?:large|Large|LARGE|small|footnotesize|scriptsize|tiny|normalsize|bfseries|itshape|scshape|rmfamily|sffamily|ttfamily|centering|raggedright|raggedleft)\b/gi,
    ''
  );
  text = text.replace(
    /\{(?:\s*\\(?:large|Large|LARGE|small|footnotesize|scriptsize|tiny|normalsize|bfseries|itshape|scshape|rmfamily|sffamily|ttfamily|centering|raggedright|raggedleft)\b\s*)+([\s\S]*?)\}/gi,
    '$1'
  );
  text = text.replace(/\\noindent\s*/gi, '');
  text = text.replace(/\\vspace\*?\{[^}]*\}/gi, '\n');
  text = text.replace(/\\hspace\*?\{[^}]*\}/gi, ' ');
  text = text.replace(/\\begin\{center\}/gi, '\n');
  text = text.replace(/\\end\{center\}/gi, '\n');
  text = text.replace(/\\begin\{itemize\}/gi, '\n');
  text = text.replace(/\\end\{itemize\}/gi, '\n');
  text = text.replace(/\\item\s+/gi, '- ');
  text = text.replace(/\\begin\{equation\*?\}/gi, '\n$$\n');
  text = text.replace(/\\end\{equation\*?\}/gi, '\n$$\n');
  text = text.replace(/\\begin\{align\*?\}/gi, '\n$$\n');
  text = text.replace(/\\end\{align\*?\}/gi, '\n$$\n');
  text = text.replace(/\\geometry\{[^}]*\}\s*/gi, '');
  text = text.replace(/\\schemestart[\s\S]*?\\schemestop/gi, '');

  text = text.replace(/\\chemfig\s*(?:\[[^\]]*\])?\{[\s\S]*?\}/gi, (match) =>
    `\`${match}\``
  );

  text = text.replace(
    /\\begin\{tabular\}\{[^}]*\}([\s\S]*?)\\end\{tabular\}/gi,
    (_match, body: string) => {
      const cleaned = body
        .replace(/\\hline|\\toprule|\\midrule|\\bottomrule/gi, '')
        .replace(/\\\\/g, '\n')
        .replace(/\s*&\s*/g, ' | ')
        .trim();
      if (!cleaned) return '';
      return `\n\`\`\`\n${cleaned}\n\`\`\`\n`;
    }
  );

  text = text.replace(/\\\\/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');

  text = autoWrapBareMathLines(text);

  return text.trim();
};

const splitLatexByDisplayMath = (
  input: string
): Array<{ type: 'text' | 'math'; content: string }> => {
  const parts: Array<{ type: 'text' | 'math'; content: string }> = [];
  const regex =
    /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\begin\{(equation\*?|align\*?|aligned|gather\*?|multline\*?)\}[\s\S]+?\\end\{\2\})/gi;
  let lastIndex = 0;
  for (const match of input.matchAll(regex)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      parts.push({
        type: 'text',
        content: input.slice(lastIndex, start)
      });
    }
    parts.push({ type: 'math', content: match[0] || '' });
    lastIndex = start + (match[0]?.length || 0);
  }
  if (lastIndex < input.length) {
    parts.push({ type: 'text', content: input.slice(lastIndex) });
  }
  return parts;
};

const stripDisplayMathWrapper = (input: string): string => {
  let value = input.trim();
  if (value.startsWith('$$') && value.endsWith('$$')) {
    return value.slice(2, -2).trim();
  }
  if (value.startsWith('\\[') && value.endsWith('\\]')) {
    return value.slice(2, -2).trim();
  }
  const envMatch = value.match(
    /^\\begin\{(equation\*?|align\*?|aligned|gather\*?|multline\*?)\}([\s\S]*?)\\end\{\1\}$/i
  );
  if (envMatch) return (envMatch[2] || '').trim();
  return value;
};

const splitMathByChemfig = (
  input: string
): Array<{ type: 'latex' | 'chemfig'; content: string }> => {
  const parts: Array<{ type: 'latex' | 'chemfig'; content: string }> = [];
  const matcher = /\\chemfig\b/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(input))) {
    const start = match.index;
    if (start > lastIndex) {
      parts.push({
        type: 'latex',
        content: input.slice(lastIndex, start)
      });
    }

    let idx = match.index + match[0].length;
    while (/\s/.test(input[idx] || '')) idx += 1;

    let options = '';
    if (input[idx] === '[') {
      const opt = readBalanced(input, idx, '[', ']');
      if (opt) {
        options = opt.content;
        idx = opt.endIndex;
      }
    }

    while (/\s/.test(input[idx] || '')) idx += 1;
    if (input[idx] !== '{') {
      lastIndex = match.index + match[0].length;
      continue;
    }

    const body = readBalanced(input, idx, '{', '}');
    if (!body) {
      lastIndex = match.index + match[0].length;
      continue;
    }

    parts.push({
      type: 'chemfig',
      content: `\\chemfig${options}${body.content}`
    });
    lastIndex = body.endIndex;
    matcher.lastIndex = body.endIndex;
  }

  if (lastIndex < input.length) {
    parts.push({ type: 'latex', content: input.slice(lastIndex) });
  }

  return parts.filter((part) => part.content.trim());
};

const splitTextByChemfig = (
  input: string
): Array<{ type: 'text' | 'chemfig'; content: string }> => {
  const parts: Array<{ type: 'text' | 'chemfig'; content: string }> = [];
  const matcher = /\\chemfig\b/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(input))) {
    const start = match.index;
    if (start > lastIndex) {
      parts.push({
        type: 'text',
        content: input.slice(lastIndex, start)
      });
    }

    let idx = match.index + match[0].length;
    while (/\s/.test(input[idx] || '')) idx += 1;

    let options = '';
    if (input[idx] === '[') {
      const opt = readBalanced(input, idx, '[', ']');
      if (opt) {
        options = opt.content;
        idx = opt.endIndex;
      }
    }

    while (/\s/.test(input[idx] || '')) idx += 1;
    if (input[idx] !== '{') {
      lastIndex = match.index + match[0].length;
      continue;
    }

    const body = readBalanced(input, idx, '{', '}');
    if (!body) {
      lastIndex = match.index + match[0].length;
      continue;
    }

    parts.push({
      type: 'chemfig',
      content: `\\chemfig${options}${body.content}`
    });
    lastIndex = body.endIndex;
    matcher.lastIndex = body.endIndex;
  }

  if (lastIndex < input.length) {
    parts.push({ type: 'text', content: input.slice(lastIndex) });
  }

  return parts.filter((part) => part.content.trim());
};

const normalizeTikzjaxInput = (input: string) => {
  const trimmed = input.trim();
  const { preamble, body } = splitLatexDocument(trimmed);
  const { packages, unsupported } = parseTexPackages(trimmed);
  const hasTikzPicture = /\\begin\{tikzpicture\}/i.test(trimmed);
  const tikzLibraries = parseTikzLibraries(
    trimmed,
    hasTikzPicture ? ['calc'] : []
  );
  const cleanedPreamble = stripPackageAndClassLines(preamble);
  const cleanedBody = stripPackageAndClassLines(body || trimmed);

  const texPackages = { ...packages };
  if (/\\chemfig\b/.test(trimmed)) {
    texPackages.chemfig = texPackages.chemfig ?? '';
  }

  let bodyForRender = cleanedBody;
  const hasExplicitDocument = /\\documentclass|\\begin\{document\}/i.test(trimmed);
  if (hasExplicitDocument) {
    const tikzBlocks = extractTikzPictures(cleanedBody);
    const chemfigSchemes = extractChemfigSchemes(cleanedBody);
    const bodyWithoutSchemes = chemfigSchemes.length
      ? stripChemfigSchemes(cleanedBody)
      : cleanedBody;
    const chemfigBlocks = extractChemfigCommands(bodyWithoutSchemes);
    const diagrams = [...tikzBlocks, ...chemfigSchemes, ...chemfigBlocks].filter(
      Boolean
    );
    if (diagrams.length) {
      bodyForRender = diagrams.join('\n\n');
    }
  }

  const sanitizedPreamble = collectPreambleAdditions(
    cleanedPreamble,
    cleanedBody
  );
  const fallbackPreamble = booktabsFallbackPreamble(trimmed);
  const sanitizedBody = stripNonAscii(stripCeCommands(bodyForRender));

  return {
    body: sanitizedBody,
    addToPreamble:
      [sanitizedPreamble, fallbackPreamble].filter(Boolean).join('\n') ||
      undefined,
    texPackages: Object.keys(texPackages).length ? texPackages : undefined,
    tikzLibraries: tikzLibraries || undefined,
    unsupportedPackages: unsupported
  };
};

const ensureTikzPicture = (input: string): string => {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  if (/\\begin\{tikzpicture\}/.test(trimmed)) return trimmed;
  return `\\begin{tikzpicture}\n${trimmed}\n\\end{tikzpicture}`;
};

const ensureTexDocument = (input: string): string => {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  const hasBegin = /\\begin\{document\}/i.test(trimmed);
  const hasEnd = /\\end\{document\}/i.test(trimmed);
  if (hasBegin && hasEnd) return trimmed;
  return `\\begin{document}\n${trimmed}\n\\end{document}`;
};

const ensureChemfigCommand = (input: string): string => {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  if (/\\chemfig\b/.test(trimmed)) return trimmed;
  return `\\chemfig{${trimmed}}`;
};

const looksLikeSvg = (input: string): boolean => /<\s*svg[\s>]/i.test(input);

let tex2svgQueue: Promise<void> = Promise.resolve();
const tex2svgCache = new Map<string, string>();
const tex2svgPending = new Map<string, Promise<string>>();
const tikzjaxResourceCheckCache = new Map<string, Promise<void>>();

const checkTikzjaxResources = (texResourcesUrl: string) => {
  if (typeof fetch !== 'function') {
    return Promise.resolve();
  }

  const normalized = texResourcesUrl.replace(/\/$/, '');
  const url = `${normalized}/tex.wasm.gz`;
  const cached = tikzjaxResourceCheckCache.get(url);
  if (cached) return cached;

  const task = (async () => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`TikZJax resource fetch failed (${response.status})`);
    }

    const buffer = await response.arrayBuffer();
    const header = new Uint8Array(buffer.slice(0, 2));
    if (header.length < 2 || header[0] !== 0x1f || header[1] !== 0x8b) {
      throw new Error(
        'TikZJax resource is not gzipped (expected 1F 8B). Check /tikzjax routing or double gzip.'
      );
    }
  })();

  tikzjaxResourceCheckCache.set(url, task);
  return task;
};

const enqueueTex2svg = async (key: string, task: () => Promise<string>) => {
  const cached = tex2svgCache.get(key);
  if (cached) return cached;

  const pending = tex2svgPending.get(key);
  if (pending) return pending;

  const run = async () => {
    try {
      const result = await task();
      tex2svgCache.set(key, result);
      // Prevent unbounded growth
      if (tex2svgCache.size > 50) {
        const firstKey = tex2svgCache.keys().next().value;
        if (firstKey) tex2svgCache.delete(firstKey);
      }
      return result;
    } finally {
      tex2svgPending.delete(key);
    }
  };

  const next = tex2svgQueue.then(run, run);
  tex2svgQueue = next.then(
    () => undefined,
    () => undefined
  );
  tex2svgPending.set(key, next);
  return next;
};

const TikzjaxDiagram = ({
  texSource,
  texPackages,
  tikzLibraries,
  addToPreamble,
  showConsole,
  compact = false
}: {
  texSource: string;
  texPackages?: Record<string, string>;
  tikzLibraries?: string;
  addToPreamble?: string;
  showConsole?: boolean;
  compact?: boolean;
}) => {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rootPath =
    typeof document !== 'undefined' ? getRouterBasename() : '';
  const texResourcesUrl = joinRootPath(rootPath, 'tikzjax');
  const normalizedPackages = useMemo(() => {
    if (!texPackages) return undefined;
    return Object.fromEntries(
      Object.entries(texPackages).sort(([a], [b]) => a.localeCompare(b))
    );
  }, [texPackages]);
  const texDocument = useMemo(
    () => ensureTexDocument(texSource),
    [texSource]
  );
  const debugEnabled = useMemo(() => {
    if (typeof showConsole === 'boolean') return showConsole;
    if (typeof window === 'undefined') return false;
    return window.localStorage?.getItem('tikzjax_debug') === '1';
  }, [showConsole]);

  const key = useMemo(
    () =>
      JSON.stringify({
        texSource: texDocument,
        texPackages: normalizedPackages,
        tikzLibraries,
        addToPreamble,
        texResourcesUrl,
        showConsole: Boolean(debugEnabled)
      }),
    [
      addToPreamble,
      debugEnabled,
      texResourcesUrl,
      texDocument,
      tikzLibraries,
      normalizedPackages
    ]
  );

  useEffect(() => {
    let cancelled = false;

    const cached = tex2svgCache.get(key);
    if (cached) {
      setSvg(cached);
      setError(null);
      return () => {
        cancelled = true;
      };
    }

    const timer = setTimeout(() => {
      if (cancelled) return;
      setSvg(null);
      setError(null);

      enqueueTex2svg(key, async () => {
        await checkTikzjaxResources(texResourcesUrl);
        const { default: tex2svg } = await import('isomorphic-tikzjax');
        return (tex2svg as any)(texDocument, {
          texResourcesUrl,
          texPackages: normalizedPackages,
          tikzLibraries,
          addToPreamble,
          showConsole: Boolean(debugEnabled),
          disableOptimize: true
        });
      })
        .then((result) => {
          if (cancelled) return;
          setSvg(result);
        })
        .catch((e) => {
          if (cancelled) return;
          setError(e instanceof Error ? e.message : String(e));
        });
    }, 400);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key]);

  if (error) {
    return (
      <div
        className={
          compact
            ? 'inline-flex items-center text-sm text-destructive'
            : 'rounded-b-md overflow-x-auto bg-background p-4 text-sm text-destructive'
        }
      >
        TikZ/Chemfig render failed: {error}
      </div>
    );
  }

  if (!svg) {
    return (
      <div
        className={
          compact
            ? 'inline-flex items-center text-sm text-muted-foreground'
            : 'rounded-b-md overflow-x-auto bg-background p-4 text-sm text-muted-foreground'
        }
      >
        Rendering diagram…
      </div>
    );
  }

  const sanitized = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['style'],
    ADD_ATTR: ['style']
  });

  return (
    <div
      className={
        compact
          ? 'inline-flex items-center'
          : 'rounded-b-md overflow-x-auto bg-background p-4'
      }
      dangerouslySetInnerHTML={{ __html: sanitized }}
    />
  );
};

const HtmlDocumentFrame = ({ html }: { html: string }) => {
  const srcDoc = useMemo(() => {
    const stylesheetLinks =
      typeof window !== 'undefined'
        ? Array.from(window.document.querySelectorAll('link[rel="stylesheet"]'))
            .map((l) => l.getAttribute('href'))
            .filter(Boolean)
            .map((href) => new URL(href!, window.location.href).toString())
            .filter((href, idx, arr) => arr.indexOf(href) === idx)
        : [];

    const headInner = extractHtmlHeadInner(html);
    const styleTexts = extractHtmlStyleTexts(headInner);
    const bodyInner = extractHtmlBodyInner(html);

    const sanitizedBody = DOMPurify.sanitize(bodyInner, {
      USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
      ADD_TAGS: ['style'],
      ADD_ATTR: ['style']
    });

    const renderedBody = (() => {
      if (!sanitizedBody.toLowerCase().includes('<math')) return sanitizedBody;

      try {
        const parser = new DOMParser();
        const htmlDoc = parser.parseFromString(
          `<!doctype html><html><body>${sanitizedBody}</body></html>`,
          'text/html'
        );

        const mathNodes = Array.from(htmlDoc.body.querySelectorAll('math')).slice(
          0,
          200
        );

        for (const node of mathNodes) {
          const display = (node.getAttribute('display') || '').toLowerCase();
          const displayMode = display === 'block';

          let tex = '';
          try {
            tex = MathMLToLaTeX.convert(
              stripMathMLAttributesForConvert(node.outerHTML)
            );
          } catch {
            tex = '';
          }

          if (!tex.trim()) continue;

          let html = '';
          try {
            html = katex.renderToString(tex, {
              throwOnError: false,
              strict: 'ignore',
              trust: false,
              displayMode
            });
          } catch {
            html = '';
          }

          if (!html) continue;

          const wrapper = htmlDoc.createElement(displayMode ? 'div' : 'span');
          wrapper.innerHTML = html;
          node.replaceWith(wrapper);
        }

        return htmlDoc.body.innerHTML;
      } catch {
        return sanitizedBody;
      }
    })();

    const styleTag = styleTexts.length
      ? `<style>${styleTexts.join('\n\n')}</style>`
      : '';

    const appStyleTags = stylesheetLinks.length
      ? stylesheetLinks
          .map((href) => `<link rel="stylesheet" href="${href}" />`)
          .join('\n')
      : '';

    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    ${appStyleTags}
    ${styleTag}
  </head>
  <body>
    ${renderedBody}
  </body>
</html>`;
  }, [html]);

  return (
    <div className="rounded-b-md bg-background p-4">
      <div className="h-[700px] min-h-[240px] resize-y overflow-hidden rounded-md border">
        <iframe className="h-full w-full border-0" sandbox="" srcDoc={srcDoc} />
      </div>
    </div>
  );
};

const SvgBlock = ({ source }: { source: string }) => {
  const svgMatch = source.match(/<svg[\s\S]*?<\/svg>/i);
  const svgSource = (svgMatch?.[0] ?? source).trim();
  const sanitized = DOMPurify.sanitize(svgSource, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['style'],
    ADD_ATTR: ['style']
  });

  if (!looksLikeSvg(sanitized)) return null;

  return (
    <div
      className="rounded-b-md overflow-x-auto bg-background p-4"
      dangerouslySetInnerHTML={{ __html: sanitized }}
    />
  );
};

const HighlightedCode = ({ language, children }: CodeSnippetProps) => {
  const codeRef = useRef<HTMLElement>(null);

  if (!hljs.getLanguage(language)) {
    language = 'txt';
  }

  useEffect(() => {
    if (codeRef.current) {
      const highlighted =
        codeRef.current.getAttribute('data-highlighted') === 'yes';
      if (!highlighted) {
        hljs.highlightElement(codeRef.current);
      }
    }
  }, []);

  return (
    <pre className="m-0">
      <code
        ref={codeRef}
        className={`language-${language} font-mono text-sm rounded-b-md block`}
      >
        {children}
      </code>
    </pre>
  );
};

interface CodeProps {
  children: React.ReactNode;
  node?: {
    children?: Array<{
      properties?: {
        className?: string[];
      };
      children?: Array<{
        value?: string;
      }>;
    }>;
  };
  allowHtml?: boolean;
  latex?: boolean;
  markdownCodeBlockDepth?: number;
  maxMarkdownCodeBlockDepth?: number;
}

type RenderView = 'rendered' | 'source';

const KATEX_OPTIONS = {
  throwOnError: false,
  strict: 'ignore',
  trust: false,
  displayMode: true
} as const;

const KATEX_INLINE_OPTIONS = {
  ...KATEX_OPTIONS,
  displayMode: false
} as const;

export default function CodeSnippet({ ...props }: CodeProps) {
  const codeChildren = props.node?.children?.[0];
  const className = codeChildren?.properties?.className?.[0];
  const match = /language-([\w-]+)/.exec(className || '');
  const rawLanguage = match?.[1];
  const language = rawLanguage?.toLowerCase();
  const code = codeChildren?.children?.[0]?.value ?? '';

  const isMarkdown = language === 'markdown' || language === 'md';
  const isLatex =
    language === 'latex' ||
    language === 'letax' ||
    language === 'tex' ||
    language === 'katex';
  const isAsciiMath = language === 'asciimath';
  const isTikz = language === 'tikz' || language === 'tikzpicture';
  const isChemfig = language === 'chemfig';
  const isSvg = language === 'svg';
  const isHtmlDocument =
    (language === 'html' ||
      language === 'xml' ||
      language === 'xhtml' ||
      language === 'mathml') &&
    /<\s*html[\s>]/i.test(code);
  const isMathML =
    language === 'mathml' ||
    ((language === 'html' || language === 'xml') && /<\s*math[\s>]/i.test(code));
  const isSvgLikeXml =
    !isHtmlDocument &&
    !isMathML &&
    (language === 'xml' || language === 'html') &&
    looksLikeSvg(code);

  const canRenderMarkdown = useMemo(() => {
    if (!isMarkdown || !code) return false;
    const depth = props.markdownCodeBlockDepth ?? 0;
    const maxDepth = props.maxMarkdownCodeBlockDepth ?? 1;
    return depth < maxDepth;
  }, [code, isMarkdown, props.markdownCodeBlockDepth, props.maxMarkdownCodeBlockDepth]);

  const canRender =
    Boolean(code) &&
    (canRenderMarkdown ||
      isLatex ||
      isAsciiMath ||
      isMathML ||
      isHtmlDocument ||
      isTikz ||
      isChemfig ||
      isSvg ||
      isSvgLikeXml);

  const [view, setView] = useState<RenderView>(canRender ? 'rendered' : 'source');

  const showSyntaxHighlighter = match && code;

  const highlightedCode = showSyntaxHighlighter ? (
    <HighlightedCode language={match[1]}>{code}</HighlightedCode>
  ) : null;

  const nonHighlightedCode = showSyntaxHighlighter ? null : (
    <div
      className={cn('rounded-b-md overflow-x-auto bg-accent', code && 'p-2')}
    >
      <code className="whitespace-pre-wrap">{code}</code>
    </div>
  );

  const rendered = useMemo(() => {
    if (!canRender) return null;

    try {
      if (canRenderMarkdown) {
        const allowHtml = Boolean(props.allowHtml);
        const latexEnabled = Boolean(props.latex);

        const remarkPlugins = latexEnabled
          ? [remarkGfm, remarkMath, remarkMathTextFix]
          : [remarkGfm];
        const rehypePlugins = [
          ...(allowHtml ? [rehypeRaw as any] : []),
          ...(latexEnabled
            ? [
                [
                  rehypeKatex as any,
                  {
                    throwOnError: false,
                    strict: 'ignore',
                    trust: false
                  }
                ]
              ]
            : [])
        ] as any[];

        return (
          <div className="rounded-b-md overflow-x-auto bg-background p-4">
            <ReactMarkdown
              className="prose lg:prose-xl max-w-none"
              remarkPlugins={remarkPlugins as any}
              rehypePlugins={rehypePlugins}
              components={{
                code({ children, ...codeProps }) {
                  return (
                    <code
                      {...codeProps}
                      className="relative rounded bg-muted px-[0.3rem] py-[0.2rem] font-mono text-sm font-semibold"
                    >
                      {children}
                    </code>
                  );
                },
                pre({ children, ...preProps }) {
                  return (
                    <pre
                      {...preProps}
                      className="rounded-md overflow-x-auto bg-accent p-3"
                    >
                      {children}
                    </pre>
                  );
                }
              }}
            >
              {code}
            </ReactMarkdown>
          </div>
        );
      }

      if (isAsciiMath) {
        const tex = asciimath2latex(code.trim());
        const html = katex.renderToString(tex, KATEX_OPTIONS);
        return (
          <div
            className="rounded-b-md overflow-x-auto bg-background p-4"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        );
      }

      if (isLatex) {
        const trimmed = code.trim();
        const hasSchemes =
          /\\schemestart\b/i.test(trimmed) && /\\schemestop\b/i.test(trimmed);
        const looksLikeDocument = /\\documentclass|\\begin\{document\}|\\usepackage|\\end\{document\}/.test(
          trimmed
        );
        const hasTikzPictures = /\\begin\{tikzpicture\}/i.test(trimmed);
        const needsTexEngine = /\\begin\{tikzpicture\}|\\chemfig\b/.test(trimmed);
        const allowHtml = Boolean(props.allowHtml);
        const latexEnabled = props.latex !== false;
        const remarkPlugins = latexEnabled
          ? [remarkGfm, remarkMath, remarkMathTextFix]
          : [remarkGfm];
        const rehypePlugins = [
          ...(allowHtml ? [rehypeRaw as any] : []),
          ...(latexEnabled
            ? [
                [
                  rehypeKatex as any,
                  {
                    throwOnError: false,
                    strict: 'ignore',
                    trust: false
                  }
                ]
              ]
            : [])
        ] as any[];
        const docConfig = looksLikeDocument
          ? getTikzjaxConfigFromDocument(trimmed)
          : undefined;

        const renderMarkdownWithChemfig = (raw: string, key: string) => {
          if (!raw) return null;
          const parts = splitTextByChemfig(raw);
          const hasChemfig = parts.some((part) => part.type === 'chemfig');

          const renderMarkdown = (markdown: string, markdownKey: string) => {
            if (!markdown) return null;
            return (
              <ReactMarkdown
                key={markdownKey}
                className="prose lg:prose-xl max-w-none"
                remarkPlugins={remarkPlugins as any}
                rehypePlugins={rehypePlugins}
                components={{
                  code({ children, ...codeProps }) {
                    return (
                      <code
                        {...codeProps}
                        className="relative rounded bg-muted px-[0.3rem] py-[0.2rem] font-mono text-sm font-semibold"
                      >
                        {children}
                      </code>
                    );
                  },
                  pre({ children, ...preProps }) {
                    return (
                      <pre
                        {...preProps}
                        className="rounded-md overflow-x-auto bg-accent p-3"
                      >
                        {children}
                      </pre>
                    );
                  }
                }}
              >
                {markdown}
              </ReactMarkdown>
            );
          };

          if (!hasChemfig) {
            return renderMarkdown(latexToMarkdown(raw), key);
          }

          return (
            <div key={key} className="space-y-4">
              {parts.map((part, idx) => {
                if (part.type === 'chemfig') {
                  const cleaned = stripNonAscii(part.content);
                  if (!cleaned) return null;
                  const texSource = ensureChemfigCommand(cleaned);
                  return (
                    <TikzjaxDiagram
                      key={`${key}-chemfig-${idx}`}
                      texSource={texSource}
                      texPackages={docConfig?.texPackages ?? DEFAULT_CHEMFIG_TEX_PACKAGES}
                      tikzLibraries={docConfig?.tikzLibraries}
                      addToPreamble={docConfig?.addToPreamble}
                      compact
                    />
                  );
                }

                return renderMarkdown(
                  latexToMarkdown(part.content),
                  `${key}-text-${idx}`
                );
              })}
            </div>
          );
        };

        if (looksLikeDocument && (hasSchemes || hasTikzPictures)) {
          const { body } = splitLatexDocument(trimmed);
          const bodyText = body || trimmed;
          const schemeSegments = hasSchemes
            ? splitLatexBySchemes(bodyText)
            : [{ type: 'text', content: bodyText }];

          return (
            <div className="rounded-b-md overflow-x-auto bg-background p-4 space-y-4">
              {schemeSegments.flatMap((segment, idx) => {
                if (segment.type === 'scheme') {
                  const cleanedScheme = stripNonAscii(
                    stripCeCommands(segment.content || '')
                  ).trim();
                  if (!cleanedScheme) return [];
                  const texSource = cleanedScheme;
                  return [
                    <TikzjaxDiagram
                      key={`scheme-${idx}`}
                      texSource={texSource}
                      texPackages={docConfig?.texPackages}
                      tikzLibraries={docConfig?.tikzLibraries}
                      addToPreamble={docConfig?.addToPreamble}
                    />
                  ];
                }

                const tikzSegments = splitLatexByTikzPictures(
                  segment.content || ''
                );

                return tikzSegments.map((tikzSegment, jdx) => {
                  if (tikzSegment.type === 'tikz') {
                  const cleanedTikz = stripNonAscii(
                    stripCeCommands(tikzSegment.content || '')
                  ).trim();
                  if (!cleanedTikz) return null;
                  const safeTikz = autoCloseTikzBlocks(cleanedTikz);
                  return (
                    <TikzjaxDiagram
                      key={`tikz-${idx}-${jdx}`}
                      texSource={safeTikz}
                      texPackages={docConfig?.texPackages}
                      tikzLibraries={docConfig?.tikzLibraries}
                      addToPreamble={docConfig?.addToPreamble}
                    />
                  );
                  }

                  return renderMarkdownWithChemfig(
                    tikzSegment.content || '',
                    `text-${idx}-${jdx}`
                  );
                });
              })}
            </div>
          );
        }

        if (looksLikeDocument) {
          const { body } = splitLatexDocument(trimmed);
          const bodyText = body || trimmed;
          const segments = splitLatexByDisplayMath(bodyText);

          const renderMathBlock = (math: string, key: string) => {
            const inner = fixMathText(stripDisplayMathWrapper(math));
            if (!inner) return null;
            const parts = splitMathByChemfig(inner);
            const hasChemfig = parts.some((p) => p.type === 'chemfig');

            if (!hasChemfig) {
              if (!latexEnabled) {
                return (
                  <pre key={key} className="rounded-md overflow-x-auto bg-accent p-3">
                    {inner}
                  </pre>
                );
              }
              try {
                const html = katex.renderToString(inner, KATEX_OPTIONS);
                return (
                  <div
                    key={key}
                    dangerouslySetInnerHTML={{ __html: html }}
                  />
                );
              } catch {
                return (
                  <pre key={key} className="rounded-md overflow-x-auto bg-accent p-3">
                    {inner}
                  </pre>
                );
              }
            }

            return (
              <div
                key={key}
                className="flex flex-wrap items-center gap-2"
              >
                {parts.map((part, idx) => {
                  if (part.type === 'chemfig') {
                    const cleaned = stripNonAscii(part.content);
                    if (!cleaned) return null;
                    const texSource = cleaned;
                    return (
                      <TikzjaxDiagram
                        key={`${key}-chemfig-${idx}`}
                        texSource={texSource}
                        texPackages={docConfig?.texPackages}
                        tikzLibraries={docConfig?.tikzLibraries}
                        addToPreamble={docConfig?.addToPreamble}
                        compact
                      />
                    );
                  }

                  const text = fixMathText(part.content.trim());
                  if (!text) return null;
                  if (!latexEnabled) {
                    return (
                      <code
                        key={`${key}-latex-${idx}`}
                        className="rounded bg-muted px-1 py-0.5 text-sm font-mono"
                      >
                        {text}
                      </code>
                    );
                  }
                  try {
                    const html = katex.renderToString(
                      text,
                      KATEX_INLINE_OPTIONS
                    );
                    return (
                      <span
                        key={`${key}-latex-${idx}`}
                        dangerouslySetInnerHTML={{ __html: html }}
                      />
                    );
                  } catch {
                    return (
                      <code
                        key={`${key}-latex-${idx}`}
                        className="rounded bg-muted px-1 py-0.5 text-sm font-mono"
                      >
                        {text}
                      </code>
                    );
                  }
                })}
              </div>
            );
          };

          return (
            <div className="rounded-b-md overflow-x-auto bg-background p-4 space-y-4">
              {segments.map((segment, idx) => {
                if (segment.type === 'math') {
                  return renderMathBlock(segment.content, `math-${idx}`);
                }
                return renderMarkdownWithChemfig(
                  segment.content || '',
                  `text-${idx}`
                );
              })}
            </div>
          );
        }

        if (needsTexEngine) {
          const normalized = normalizeTikzjaxInput(trimmed);
          if (!normalized.body) return null;
          const texSource = /\\begin\{tikzpicture\}/i.test(normalized.body)
            ? autoCloseTikzBlocks(normalized.body)
            : normalized.body;
          return (
            <TikzjaxDiagram
              texSource={texSource}
              texPackages={normalized.texPackages}
              tikzLibraries={normalized.tikzLibraries}
              addToPreamble={normalized.addToPreamble}
            />
          );
        }

        const tex = stripLatexMathDelimiters(trimmed);
        const html = katex.renderToString(fixMathText(tex), KATEX_OPTIONS);
        return (
          <div
            className="rounded-b-md overflow-x-auto bg-background p-4"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        );
      }

      if (isHtmlDocument) {
        return <HtmlDocumentFrame html={code.trim()} />;
      }

      if (isSvg || isSvgLikeXml) {
        return <SvgBlock source={code} />;
      }

      if (isTikz) {
        const normalized = normalizeTikzjaxInput(code);
        const body = ensureTikzPicture(normalized.body || code);
        const texSource = autoCloseTikzBlocks(body);
        return (
          <TikzjaxDiagram
            texSource={texSource}
            texPackages={normalized.texPackages}
            tikzLibraries={normalized.tikzLibraries}
            addToPreamble={normalized.addToPreamble}
          />
        );
      }

      if (isChemfig) {
        const normalized = normalizeTikzjaxInput(code);
        const body = ensureChemfigCommand(normalized.body || code);
        const texSource = body;
        return (
          <TikzjaxDiagram
            texSource={texSource}
            texPackages={normalized.texPackages ?? DEFAULT_CHEMFIG_TEX_PACKAGES}
            tikzLibraries={normalized.tikzLibraries}
            addToPreamble={normalized.addToPreamble}
          />
        );
      }

      if (isMathML) {
        const trimmed = code.trim();
        const mathBlocks = extractMathMLBlocks(trimmed).slice(0, 100);
        const blocksToRender = mathBlocks.length ? mathBlocks : [trimmed];

        const renderedBlocks = blocksToRender
          .map((b, idx) => {
            const purified = DOMPurify.sanitize(b.trim(), {
              USE_PROFILES: { mathMl: true }
            });
            if (!purified || !purified.toLowerCase().includes('<math')) {
              return null;
            }

            let tex = '';
            try {
              tex = MathMLToLaTeX.convert(
                stripMathMLAttributesForConvert(purified)
              );
            } catch {
              tex = '';
            }

            if (tex.trim()) {
              const html = katex.renderToString(tex, KATEX_OPTIONS);
              if (isKatexErrorHtml(html)) {
                return <div key={idx} dangerouslySetInnerHTML={{ __html: purified }} />;
              }
              return (
                <div
                  key={idx}
                  dangerouslySetInnerHTML={{ __html: html }}
                />
              );
            }

            return (
              <div
                key={idx}
                dangerouslySetInnerHTML={{ __html: purified }}
              />
            );
          })
          .filter(Boolean);

        if (!renderedBlocks.length) return null;

        return (
          <div className="rounded-b-md overflow-x-auto bg-background p-4 space-y-4">
            {renderedBlocks}
          </div>
        );
      }

      return null;
    } catch {
      return null;
    }
  }, [
    canRender,
    canRenderMarkdown,
    code,
    isAsciiMath,
    isChemfig,
    isHtmlDocument,
    isLatex,
    isMathML,
    isSvg,
    isSvgLikeXml,
    isTikz,
    props.allowHtml,
    props.latex
  ]);

  const hasRendered = Boolean(rendered);
  const canToggle = canRender && hasRendered;
  const shouldShowRendered = canToggle && view === 'rendered';

  return (
    <Card className="relative my-2">
      <CardHeader className="flex flex-row items-center justify-between py-1 px-4">
        <span className="text-sm text-muted-foreground">
          {rawLanguage || 'Raw code'}
        </span>
        <div className="flex items-center gap-2">
          {canToggle ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() =>
                setView((current) =>
                  current === 'rendered' ? 'source' : 'rendered'
                )
              }
            >
              {view === 'rendered' ? 'Source' : 'Rendered'}
            </Button>
          ) : null}
          <CopyButton content={code} />
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {shouldShowRendered ? rendered : null}
        {shouldShowRendered ? null : (
          <>
            {highlightedCode}
            {nonHighlightedCode}
          </>
        )}
      </CardContent>
    </Card>
  );
}
