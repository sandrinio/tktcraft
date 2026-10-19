/**
 * Markdown <-> Atlassian Document Format (ADF v1) converter for Jira Cloud.
 * Supports:
 * - Headings (# through ######)
 * - Markdown Tables (| Header | ... |) with inline formatting
 * - Bullet lists (*, -) and Checkboxes (* [ ], * [x])
 * - Ordered lists (1., 2.)
 * - Fenced code blocks (```lang ... ```)
 * - Blockquotes (> ...)
 * - Inline marks: **bold**, *italic*, `code`, [link](url)
 */

export interface AdfNode {
  type: string;
  version?: number;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
}

export function parseInlineMarks(text: string): AdfNode[] {
  const pattern = /(\[[^\]]+\]\([^)]+\)|\*\*.*?\*\*|\*[^*]+?\*|`[^`]+?`)/g;
  const tokens = text.split(pattern);
  const nodes: AdfNode[] = [];

  for (const token of tokens) {
    if (!token) continue;
    const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkMatch) {
      nodes.push({
        type: 'text',
        text: linkMatch[1],
        marks: [{ type: 'link', attrs: { href: linkMatch[2] } }],
      });
    } else if (token.startsWith('**') && token.endsWith('**') && token.length >= 4) {
      nodes.push({
        type: 'text',
        text: token.slice(2, -2),
        marks: [{ type: 'strong' }],
      });
    } else if (token.startsWith('*') && token.endsWith('*') && token.length >= 2) {
      nodes.push({
        type: 'text',
        text: token.slice(1, -1),
        marks: [{ type: 'em' }],
      });
    } else if (token.startsWith('`') && token.endsWith('`') && token.length >= 2) {
      nodes.push({
        type: 'text',
        text: token.slice(1, -1),
        marks: [{ type: 'code' }],
      });
    } else {
      nodes.push({ type: 'text', text: token });
    }
  }

  return nodes.length > 0 ? nodes : [{ type: 'text', text }];
}

export function markdownToAdf(md: string): AdfNode {
  const lines = md.trim().split(/\r?\n/);
  const content: AdfNode[] = [];

  let currentList: AdfNode | null = null;
  let currentListType: 'bulletList' | 'orderedList' | null = null;

  let currentTableRows: AdfNode[] = [];
  let hasSeenTableHeader = false;

  let inCodeBlock = false;
  let codeBlockLines: string[] = [];
  let codeBlockLang: string | null = null;

  const flushList = () => {
    if (currentList) {
      content.push(currentList);
      currentList = null;
      currentListType = null;
    }
  };

  const flushTable = () => {
    if (currentTableRows.length > 0) {
      content.push({
        type: 'table',
        attrs: {
          isNumberColumnEnabled: false,
          layout: 'default',
        },
        content: currentTableRows,
      });
      currentTableRows = [];
      hasSeenTableHeader = false;
    }
  };

  for (const line of lines) {
    const stripped = line.trim();

    if (stripped.startsWith('```')) {
      flushList();
      flushTable();
      if (inCodeBlock) {
        content.push({
          type: 'codeBlock',
          attrs: { language: codeBlockLang || 'text' },
          content: [{ type: 'text', text: codeBlockLines.join('\n') }],
        });
        inCodeBlock = false;
        codeBlockLines = [];
        codeBlockLang = null;
      } else {
        inCodeBlock = true;
        codeBlockLang = stripped.slice(3).trim() || null;
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockLines.push(line);
      continue;
    }

    if (!stripped) {
      flushList();
      flushTable();
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(stripped)) {
      flushList();
      flushTable();
      content.push({ type: 'rule' });
      continue;
    }

    // Markdown Table row (| cell | cell |)
    if (stripped.startsWith('|') && stripped.endsWith('|') && stripped.length >= 2) {
      flushList();
      const rawCells = stripped
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim());
      const isDelimiter =
        rawCells.length > 0 &&
        rawCells.every((c) => !c || /^:?-+:?$/.test(c));
      if (isDelimiter) {
        hasSeenTableHeader = true;
        continue;
      }

      const cellType =
        !hasSeenTableHeader && currentTableRows.length === 0
          ? 'tableHeader'
          : 'tableCell';
      const rowContent: AdfNode[] = rawCells.map((cellText) => {
        const parsedCell = cellText ? parseInlineMarks(cellText) : [{ type: 'text', text: '' }];
        return {
          type: cellType,
          content: [{ type: 'paragraph', content: parsedCell }],
        };
      });

      currentTableRows.push({
        type: 'tableRow',
        content: rowContent,
      });
      continue;
    } else {
      flushTable();
    }

    // Headings (# Heading)
    const headingMatch = stripped.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      flushList();
      flushTable();
      const level = Math.min(headingMatch[1].length, 6);
      content.push({
        type: 'heading',
        attrs: { level },
        content: parseInlineMarks(headingMatch[2]),
      });
      continue;
    }

    // Blockquote (> quote)
    if (stripped.startsWith('>')) {
      flushList();
      flushTable();
      const qText = stripped.slice(1).trim();
      content.push({
        type: 'blockquote',
        content: [
          {
            type: 'paragraph',
            content: parseInlineMarks(qText),
          },
        ],
      });
      continue;
    }

    // Bullet List item (* or -)
    const bulletMatch = stripped.match(/^[*-]\s+(.*)$/);
    if (bulletMatch) {
      flushTable();
      let itemText = bulletMatch[1];
      if (itemText.startsWith('[ ] ')) {
        itemText = '☐ ' + itemText.slice(4);
      } else if (/^\[[xX]\]\s+/.test(itemText)) {
        itemText = '☑ ' + itemText.slice(4);
      }

      if (currentListType !== 'bulletList' || !currentList) {
        flushList();
        currentList = { type: 'bulletList', content: [] };
        currentListType = 'bulletList';
      }

      currentList.content!.push({
        type: 'listItem',
        content: [
          {
            type: 'paragraph',
            content: parseInlineMarks(itemText),
          },
        ],
      });
      continue;
    }

    // Ordered List item (1. item)
    const numMatch = stripped.match(/^\d+\.\s+(.*)$/);
    if (numMatch) {
      flushTable();
      const itemText = numMatch[1];
      if (currentListType !== 'orderedList' || !currentList) {
        flushList();
        currentList = { type: 'orderedList', content: [] };
        currentListType = 'orderedList';
      }

      currentList.content!.push({
        type: 'listItem',
        content: [
          {
            type: 'paragraph',
            content: parseInlineMarks(itemText),
          },
        ],
      });
      continue;
    }

    // Regular Paragraph
    flushList();
    flushTable();
    content.push({
      type: 'paragraph',
      content: parseInlineMarks(stripped),
    });
  }

  flushList();
  flushTable();

  if (content.length === 0) {
    content.push({
      type: 'paragraph',
      content: [{ type: 'text', text: md }],
    });
  }

  return {
    version: 1,
    type: 'doc',
    content,
  };
}

export function adfToMarkdown(node: AdfNode | string | null | undefined): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (typeof node !== 'object') return '';

  const nodeType = node.type;
  if (nodeType === 'text') {
    let txt = node.text ?? '';
    for (const mark of node.marks ?? []) {
      if (mark.type === 'strong') txt = `**${txt}**`;
      else if (mark.type === 'em') txt = `*${txt}*`;
      else if (mark.type === 'code') txt = `\`${txt}\``;
      else if (mark.type === 'link' && mark.attrs?.href) {
        txt = `[${txt}](${mark.attrs.href})`;
      }
    }
    return txt;
  }

  if (nodeType === 'hardBreak') return '\n';
  if (nodeType === 'rule') return '\n---\n\n';

  const children = (node.content ?? []).map((c) => adfToMarkdown(c));

  switch (nodeType) {
    case 'doc':
      return children.join('').trim();
    case 'paragraph':
      return children.join('') + '\n\n';
    case 'heading': {
      const level = Number(node.attrs?.level ?? 2);
      return `${'#'.repeat(level)} ${children.join('')}\n\n`;
    }
    case 'bulletList':
      return (
        (node.content ?? [])
          .map((item) => `- ${adfToMarkdown(item).trim()}`)
          .join('\n') + '\n\n'
      );
    case 'orderedList':
      return (
        (node.content ?? [])
          .map((item, idx) => `${idx + 1}. ${adfToMarkdown(item).trim()}`)
          .join('\n') + '\n\n'
      );
    case 'listItem':
      return children.join('').trim();
    case 'codeBlock': {
      const lang = (node.attrs?.language as string) || '';
      return `\`\`\`${lang}\n${children.join('')}\n\`\`\`\n\n`;
    }
    case 'blockquote':
      return (
        children
          .join('')
          .trim()
          .split('\n')
          .map((l) => `> ${l}`)
          .join('\n') + '\n\n'
      );
    case 'table': {
      const rows = (node.content ?? []).map((row) =>
        (row.content ?? []).map((cell) => adfToMarkdown(cell).trim().replace(/\n+/g, ' '))
      );
      if (rows.length === 0) return '';
      const header = `| ${rows[0].join(' | ')} |`;
      const divider = `| ${rows[0].map(() => '---').join(' | ')} |`;
      const body = rows
        .slice(1)
        .map((r) => `| ${r.join(' | ')} |`)
        .join('\n');
      return [header, divider, body].filter(Boolean).join('\n') + '\n\n';
    }
    default:
      return children.join('');
  }
}
