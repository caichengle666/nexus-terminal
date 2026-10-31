import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCodeBlocks, getTerminalInsertText, renderAiMarkdown } from '../../src/utils/aiMarkdown';

test('first fenced code block is used for terminal insert, prompts stripped', () => {
  const reply = '先检查端口：\n\n```bash\n$ ss -ltnp | grep :80\n```\n\n然后：\n```\nsystemctl restart nginx\n```';
  assert.deepEqual(getTerminalInsertText(reply), { text: 'ss -ltnp | grep :80', fromCode: true });
  assert.deepEqual(extractCodeBlocks(reply), ['ss -ltnp | grep :80', 'systemctl restart nginx']);
});

test('reply without code block inserts the trimmed plain text', () => {
  assert.deepEqual(getTerminalInsertText('  just text\n'), { text: 'just text', fromCode: false });
  assert.deepEqual(getTerminalInsertText(''), { text: '', fromCode: false });
});

test('unclosed fence while streaming still counts as a code block', () => {
  assert.deepEqual(extractCodeBlocks('see:\n```sh\nls -la'), ['ls -la']);
});

test('html is escaped everywhere', () => {
  const { html } = renderAiMarkdown('<script>alert(1)</script> `<b>` **<i>x</i>**\n```\n<img src=x onerror=1>\n```');
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<b>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('renders headings, lists, tables, blockquotes and code with action buttons', () => {
  const md = [
    '# 标题',
    '',
    '- 一',
    '- 二',
    '  - 子项',
    '',
    '1. first',
    '2. second',
    '',
    '| a | b |',
    '|---|--:|',
    '| 1 | 2 |',
    '',
    '> 引用',
    '',
    '```bash',
    'echo hi',
    '```',
  ].join('\n');
  const { html, codeBlocks } = renderAiMarkdown(md, { labels: { copy: 'C', insert: 'I', code: 'code' } });
  assert.match(html, /<h1 class="ai-md-h">标题<\/h1>/);
  assert.match(html, /<ul><li>一<\/li><li>二<ul><li>子项<\/li><\/ul><\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /<div class="ai-md-table-wrap"><table>/);
  assert.match(html, /<td style="text-align:right">2<\/td>/);
  assert.match(html, /<blockquote><p>引用<\/p><\/blockquote>/);
  assert.match(html, /data-ai-code-action="copy" data-ai-code-index="0"/);
  assert.match(html, /data-ai-code-action="insert" data-ai-code-index="0"/);
  assert.deepEqual(codeBlocks, ['echo hi']);
});

test('only http(s) links become anchors', () => {
  const { html } = renderAiMarkdown('[ok](https://example.com/a) [bad](javascript:alert(1)) https://x.dev/path.');
  assert.match(html, /<a href="https:\/\/example.com\/a" target="_blank" rel="noopener noreferrer">ok<\/a>/);
  assert.ok(!html.includes('href="javascript'));
  assert.match(html, /<a href="https:\/\/x.dev\/path"[^>]*>https:\/\/x.dev\/path<\/a>\./);
});

test('inline code content is not formatted', () => {
  const { html } = renderAiMarkdown('run `a **b** c` now');
  assert.match(html, /<code class="ai-md-inline-code">a \*\*b\*\* c<\/code>/);
});

test('code badge callback receives the cleaned command', () => {
  const seen: string[] = [];
  const { html } = renderAiMarkdown('```\n$ rm -rf /tmp/x\n```', {
    codeBadge: (code) => { seen.push(code); return { label: 'danger', className: 'is-danger' }; },
  });
  assert.deepEqual(seen, ['rm -rf /tmp/x']);
  assert.match(html, /ai-md-code-badge is-danger">danger</);
});
