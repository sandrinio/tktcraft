/**
 * Markdown <-> Azure DevOps HTML converter & Multi-Field Board Splitter.
 *
 * Why this matters for Azure DevOps boards:
 * - Unlike Jira (which puts everything in `description`), Azure DevOps boards
 *   (Agile, Scrum, CMMI, Basic) split content across dedicated fields depending on the work item type:
 *   - User Story / Product Backlog Item / Requirement:
 *     - `System.Description`
 *     - `Microsoft.VSTS.Common.AcceptanceCriteria`
 *   - Bug:
 *     - `Microsoft.VSTS.TCM.ReproSteps` (many ADO Bug boards hide System.Description!)
 *     - `Microsoft.VSTS.TCM.SystemInfo`
 *     - `Microsoft.VSTS.Common.AcceptanceCriteria`
 *
 * This module converts Markdown to clean HTML for Azure DevOps AND automatically
 * extracts Acceptance Criteria / Repro Steps / System Info sections when needed.
 */

export interface AdoSplitFieldsResult {
  descriptionHtml: string;
  acceptanceCriteriaHtml?: string;
  reproStepsHtml?: string;
  systemInfoHtml?: string;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatInlineHtml(text: string): string {
  const escaped = escapeHtml(text);
  return escaped
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+?)`/g, '<code>$1</code>');
}

export function markdownToAdoHtml(md: string): string {
  if (!md || !md.trim()) return '';
  const lines = md.trim().split(/\r?\n/);
  const htmlParts: string[] = [];

  let inList: 'ul' | 'ol' | null = null;
  let inCodeBlock = false;
  let codeLines: string[] = [];
  let tableRows: string[][] = [];

  const flushList = () => {
    if (inList) {
      htmlParts.push(`</${inList}>`);
      inList = null;
    }
  };

  const flushTable = () => {
    if (tableRows.length > 0) {
      const headerCells = tableRows[0]
        .map((c) => `<th>${formatInlineHtml(c)}</th>`)
        .join('');
      const bodyRows = tableRows
        .slice(1)
        .map(
          (r) =>
            `<tr>${r.map((c) => `<td>${formatInlineHtml(c)}</td>`).join('')}</tr>`
        )
        .join('');
      htmlParts.push(
        `<table><thead><tr>${headerCells}</tr></thead><tbody>${bodyRows}</tbody></table>`
      );
      tableRows = [];
    }
  };

  for (const line of lines) {
    const stripped = line.trim();

    if (stripped.startsWith('```')) {
      flushList();
      flushTable();
      if (inCodeBlock) {
        htmlParts.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        inCodeBlock = false;
        codeLines = [];
      } else {
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    if (!stripped) {
      flushList();
      flushTable();
      continue;
    }

    if (stripped.startsWith('|') && stripped.endsWith('|') && stripped.length >= 2) {
      flushList();
      const cells = stripped
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim());
      const isDelimiter = cells.every((c) => !c || /^:?-+:?$/.test(c));
      if (!isDelimiter) {
        tableRows.push(cells);
      }
      continue;
    } else {
      flushTable();
    }

    const headingMatch = stripped.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      flushList();
      const level = Math.min(headingMatch[1].length, 6);
      htmlParts.push(`<h${level}>${formatInlineHtml(headingMatch[2])}</h${level}>`);
      continue;
    }

    if (stripped.startsWith('>')) {
      flushList();
      htmlParts.push(`<blockquote>${formatInlineHtml(stripped.slice(1).trim())}</blockquote>`);
      continue;
    }

    const bulletMatch = stripped.match(/^[*-]\s+(.*)$/);
    if (bulletMatch) {
      if (inList !== 'ul') {
        flushList();
        htmlParts.push('<ul>');
        inList = 'ul';
      }
      let item = bulletMatch[1];
      if (item.startsWith('[ ] ')) item = '☐ ' + item.slice(4);
      else if (/^\[[xX]\]\s+/.test(item)) item = '☑ ' + item.slice(4);
      htmlParts.push(`<li>${formatInlineHtml(item)}</li>`);
      continue;
    }

    const numMatch = stripped.match(/^\d+\.\s+(.*)$/);
    if (numMatch) {
      if (inList !== 'ol') {
        flushList();
        htmlParts.push('<ol>');
        inList = 'ol';
      }
      htmlParts.push(`<li>${formatInlineHtml(numMatch[1])}</li>`);
      continue;
    }

    flushList();
    htmlParts.push(`<p>${formatInlineHtml(stripped)}</p>`);
  }

  flushList();
  flushTable();

  return htmlParts.join('\n');
}

/**
 * Splits a unified Markdown document (or explicit options) into Azure DevOps
 * board-appropriate HTML fields (`System.Description`, `AcceptanceCriteria`, `ReproSteps`, `SystemInfo`).
 */
export function splitMarkdownForAdoBoard(input: {
  issueType: string;
  description?: string;
  acceptanceCriteria?: string;
  reproSteps?: string;
}): AdoSplitFieldsResult {
  const rawMd = input.description ?? '';
  let mainMd = rawMd;
  let extractedAc = input.acceptanceCriteria ?? '';
  let extractedRepro = input.reproSteps ?? '';
  let extractedSysInfo = '';

  // Extract ## Acceptance Criteria section if not explicitly passed
  if (!extractedAc && rawMd) {
    const acRegex =
      /(?:^|\n)#{1,3}\s*(?:Acceptance Criteria|Definition of Done)\s*\n([\s\S]*?)(?=\n#{1,2}\s+|$)/i;
    const match = mainMd.match(acRegex);
    if (match) {
      extractedAc = match[1].trim();
      mainMd = mainMd.replace(match[0], '\n').trim();
    }
  }

  // Extract ## Repro Steps / Steps to Reproduce section if not explicitly passed
  if (!extractedRepro && rawMd) {
    const reproRegex =
      /(?:^|\n)#{1,3}\s*(?:Repro(?:duction)? Steps|Steps to Reproduce)\s*\n([\s\S]*?)(?=\n#{1,2}\s+|$)/i;
    const match = mainMd.match(reproRegex);
    if (match) {
      extractedRepro = match[1].trim();
      mainMd = mainMd.replace(match[0], '\n').trim();
    }
  }

  // Extract ## System Info / Environment section
  if (rawMd) {
    const sysRegex =
      /(?:^|\n)#{1,3}\s*(?:System Info|Environment)\s*\n([\s\S]*?)(?=\n#{1,2}\s+|$)/i;
    const match = mainMd.match(sysRegex);
    if (match) {
      extractedSysInfo = match[1].trim();
      mainMd = mainMd.replace(match[0], '\n').trim();
    }
  }

  const isBug = /bug|defect/i.test(input.issueType);
  if (isBug && !extractedRepro && mainMd) {
    // On Azure DevOps Agile/Scrum/CMMI boards, Bug work items display ReproSteps as their primary body field
    extractedRepro = mainMd;
  }

  return {
    descriptionHtml: markdownToAdoHtml(mainMd || rawMd),
    acceptanceCriteriaHtml: extractedAc ? markdownToAdoHtml(extractedAc) : undefined,
    reproStepsHtml: extractedRepro ? markdownToAdoHtml(extractedRepro) : undefined,
    systemInfoHtml: extractedSysInfo ? markdownToAdoHtml(extractedSysInfo) : undefined,
  };
}

export function adoHtmlToText(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<li>/gi, '- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<t[dh][^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
