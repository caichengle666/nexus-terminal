// Small, dependency-free Markdown renderer for AI replies.
// Everything is HTML-escaped first; only a fixed set of tags is produced, so the
// output is safe for v-html. Supports: fenced code (also unclosed while streaming),
// headings, lists (nested by indent), blockquotes, GFM pipe tables, horizontal
// rules, paragraphs, and inline code / bold / italic / strike / http(s) links.

export type AiCodeBadge = { label: string; className: string } | null;

export type AiMarkdownOptions = {
  /** Labels for the per-code-block buttons (icon-only, used as title/aria-label). */
  labels?: { copy: string; insert: string; code: string };
  /** Optional badge (e.g. command risk) shown in a code block header. */
  codeBadge?: (code: string, lang: string) => AiCodeBadge;
};

export type AiMarkdownResult = {
  html: string;
  /** Code blocks in order, with shell prompts (`$ `) stripped, for copy / insert actions. */
  codeBlocks: string[];
};

export const escapeHtml = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/** Removes a leading shell prompt (`$ `) from each line of a command block. */
export const cleanCommandBlock = (code: string) => code
  .split('\n')
  .map(line => line.replace(/^\$\s?/, ''))
  .join('\n')
  .trim();

/** All fenced code blocks of a reply (prompts stripped, empty blocks skipped). */
export const extractCodeBlocks = (content?: string | null) => (content
  ? renderAiMarkdown(content).codeBlocks.filter(Boolean)
  : []);

/**
 * Text that "insert into terminal" types for a reply: the first fenced code block
 * when there is one, otherwise the plain reply text. Never includes a trailing newline.
 */
export const getTerminalInsertText = (content?: string | null): { text: string; fromCode: boolean } => {
  const first = extractCodeBlocks(content)[0];
  if (first) return { text: first.replace(/\n+$/, ''), fromCode: true };
  return { text: (content || '').trim(), fromCode: false };
};

const renderInline = (raw: string) => {
  // Code spans first, replaced by placeholders so their content is not formatted.
  const codes: string[] = [];
  let text = raw.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    codes.push(`<code class="ai-md-inline-code">${escapeHtml(code)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  const links: string[] = [];
  text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) => {
    links.push(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`);
    return `\u0001${links.length - 1}\u0001`;
  });
  text = text.replace(/https?:\/\/[^\s<>"'`)\]]+[^\s<>"'`)\].,;:!?。，；：！？]/g, (url) => {
    links.push(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`);
    return `\u0001${links.length - 1}\u0001`;
  });
  text = escapeHtml(text)
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+?)__/g, '<strong>$1</strong>')
    .replace(/~~([^~\n]+?)~~/g, '<del>$1</del>')
    .replace(/(^|[^*\w])\*([^*\s](?:[^*\n]*?[^*\s])?)\*(?!\*)/g, '$1<em>$2</em>');
  return text
    .replace(/\u0001(\d+)\u0001/g, (_m, index: string) => links[Number(index)] || '')
    .replace(/\u0000(\d+)\u0000/g, (_m, index: string) => codes[Number(index)] || '');
};

const splitTableRow = (line: string) => {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
};

const indentOf = (line: string) => {
  const match = /^(\s*)/.exec(line);
  return (match?.[1] || '').replace(/\t/g, '    ').length;
};

type RenderState = { codeBlocks: string[]; options: AiMarkdownOptions };

const renderCodeBlock = (code: string, lang: string, state: RenderState) => {
  const index = state.codeBlocks.length;
  state.codeBlocks.push(cleanCommandBlock(code));
  const labels = state.options.labels || { copy: 'Copy', insert: 'Insert into terminal', code: 'code' };
  const badge = state.options.codeBadge?.(cleanCommandBlock(code), lang) || null;
  const langLabel = lang ? escapeHtml(lang) : escapeHtml(labels.code);
  return [
    `<div class="ai-md-code" data-ai-code-index="${index}">`,
    '<div class="ai-md-code-head">',
    `<span class="ai-md-code-lang">${langLabel}</span>`,
    badge ? `<span class="ai-md-code-badge ${escapeHtml(badge.className)}">${escapeHtml(badge.label)}</span>` : '',
    '<span class="ai-md-code-actions">',
    `<button type="button" class="ai-md-code-btn" data-ai-code-action="copy" data-ai-code-index="${index}" title="${escapeHtml(labels.copy)}" aria-label="${escapeHtml(labels.copy)}"><i class="fas fa-copy" aria-hidden="true"></i></button>`,
    `<button type="button" class="ai-md-code-btn" data-ai-code-action="insert" data-ai-code-index="${index}" title="${escapeHtml(labels.insert)}" aria-label="${escapeHtml(labels.insert)}"><i class="fas fa-terminal" aria-hidden="true"></i></button>`,
    '</span></div>',
    `<pre class="ai-md-pre"><code>${escapeHtml(code.replace(/\n+$/, ''))}</code></pre>`,
    '</div>',
  ].join('');
};

const renderList = (lines: string[], state: RenderState): string => {
  // lines: a contiguous list block. Items start at the smallest indent.
  const baseIndent = Math.min(...lines.filter(l => LIST_RE.test(l)).map(indentOf));
  const firstMatch = LIST_RE.exec(lines.find(l => LIST_RE.test(l) && indentOf(l) === baseIndent) || '');
  const ordered = !!firstMatch && /\d/.test(firstMatch[2]);
  const start = ordered && firstMatch ? Number.parseInt(firstMatch[2], 10) : 1;
  const items: string[][] = [];
  for (const line of lines) {
    const match = LIST_RE.exec(line);
    if (match && indentOf(line) <= baseIndent + 1) {
      items.push([match[3]]);
    } else if (items.length > 0) {
      items[items.length - 1].push(line);
    }
  }
  const body = items.map((itemLines) => {
    const [first, ...rest] = itemLines;
    const task = /^\[( |x|X)\]\s+(.*)$/.exec(first);
    const head = task
      ? `<span class="ai-md-task" aria-hidden="true">${task[1] === ' ' ? '☐' : '☑'}</span> ${renderInline(task[2])}`
      : renderInline(first);
    const nested = rest.filter(l => l.trim() !== '');
    const inner = nested.length > 0 ? renderBlocks(dedent(nested), state) : '';
    return `<li>${head}${inner}</li>`;
  }).join('');
  return ordered
    ? `<ol${start !== 1 ? ` start="${start}"` : ''}>${body}</ol>`
    : `<ul>${body}</ul>`;
};

const dedent = (lines: string[]) => {
  const min = Math.min(...lines.filter(l => l.trim()).map(indentOf));
  return lines.map(l => l.replace(/\t/g, '    ').slice(Math.min(min, indentOf(l))));
};

const renderBlocks = (lines: string[], state: RenderState): string => {
  const out: string[] = [];
  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    out.push(`<p>${paragraph.map(renderInline).join('<br>')}</p>`);
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') {
      flushParagraph();
      continue;
    }
    const fence = FENCE_RE.exec(line);
    if (fence) {
      flushParagraph();
      const marker = fence[1];
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const trimmed = lines[j].trim();
        if (trimmed.length >= marker.length && /^(`+|~+)$/.test(trimmed) && trimmed[0] === marker[0]) break;
        body.push(lines[j]);
      }
      out.push(renderCodeBlock(body.join('\n'), fence[2] || '', state));
      i = j;
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushParagraph();
      const level = Math.min(6, heading[1].length);
      out.push(`<h${level} class="ai-md-h">${renderInline(heading[2])}</h${level}>`);
      continue;
    }
    if (HR_RE.test(line)) {
      flushParagraph();
      out.push('<hr>');
      continue;
    }
    if (QUOTE_RE.test(line)) {
      flushParagraph();
      const quoted: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        quoted.push(QUOTE_RE.exec(lines[i])![1]);
        i += 1;
      }
      i -= 1;
      out.push(`<blockquote>${renderBlocks(quoted, state)}</blockquote>`);
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      flushParagraph();
      const header = splitTableRow(line);
      const aligns = splitTableRow(lines[i + 1]).map((cell) => {
        const left = cell.startsWith(':');
        const right = cell.endsWith(':');
        return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
      });
      const rows: string[][] = [];
      let j = i + 2;
      for (; j < lines.length && lines[j].includes('|') && lines[j].trim() !== ''; j += 1) rows.push(splitTableRow(lines[j]));
      const cell = (tag: 'th' | 'td', value: string, index: number) => `<${tag}${aligns[index] ? ` style="text-align:${aligns[index]}"` : ''}>${renderInline(value)}</${tag}>`;
      out.push([
        '<div class="ai-md-table-wrap"><table>',
        `<thead><tr>${header.map((value, index) => cell('th', value, index)).join('')}</tr></thead>`,
        rows.length ? `<tbody>${rows.map(row => `<tr>${header.map((_h, index) => cell('td', row[index] || '', index)).join('')}</tr>`).join('')}</tbody>` : '',
        '</table></div>',
      ].join(''));
      i = j - 1;
      continue;
    }
    if (LIST_RE.test(line)) {
      flushParagraph();
      const block: string[] = [];
      const baseIndent = indentOf(line);
      const isOrdered = (value: string) => /\d/.test(LIST_RE.exec(value)?.[2] || '');
      const ordered = isOrdered(line);
      // A sibling item of the other list type starts a new list.
      const otherType = (value: string) => LIST_RE.test(value) && indentOf(value) <= baseIndent + 1 && isOrdered(value) !== ordered;
      let j = i;
      for (; j < lines.length; j += 1) {
        const current = lines[j];
        if (current.trim() === '') {
          // A blank line continues the list only when the next non-blank line is a list item or indented.
          const next = lines.slice(j + 1).find(l => l.trim() !== '');
          if (next !== undefined && !otherType(next) && (LIST_RE.test(next) || indentOf(next) > baseIndent)) {
            block.push(current);
            continue;
          }
          break;
        }
        if (j > i && !LIST_RE.test(current) && indentOf(current) <= baseIndent) {
          // Lazy continuation of the previous item's text.
          if (FENCE_RE.test(current) || HEADING_RE.test(current) || QUOTE_RE.test(current)) break;
        }
        if (j > i && ((indentOf(current) < baseIndent && LIST_RE.test(current)) || otherType(current))) break;
        block.push(current);
      }
      out.push(renderList(block, state));
      i = j - 1;
      continue;
    }
    paragraph.push(line.trim());
  }
  flushParagraph();
  return out.join('');
};

export const renderAiMarkdown = (content?: string | null, options: AiMarkdownOptions = {}): AiMarkdownResult => {
  const state: RenderState = { codeBlocks: [], options };
  const lines = (content || '').replace(/\r\n?/g, '\n').split('\n');
  return { html: renderBlocks(lines, state), codeBlocks: state.codeBlocks };
};
