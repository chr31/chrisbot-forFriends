const TELEGRAM_HTML_PARSE_MODE = 'HTML';
const DEFAULT_TELEGRAM_TEXT_LIMIT = 4000;
const BULLET = '\u2022';
const QUOTE_PREFIX = '\u203a';
const { renderMarkdownTableImages } = require('./telegramTableImage');

function normalizeTelegramParseMode(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return normalized === TELEGRAM_HTML_PARSE_MODE ? TELEGRAM_HTML_PARSE_MODE : '';
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtmlAttribute(value) {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

function collapseWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stashRenderedToken(tokens, rendered) {
  const placeholder = `\u0000TG${tokens.length}\u0000`;
  tokens.push(rendered);
  return placeholder;
}

function restoreRenderedTokens(source, tokens) {
  return source.replace(/\u0000TG(\d+)\u0000/g, (_, rawIndex) => {
    const index = Number(rawIndex);
    return Number.isInteger(index) && index >= 0 && index < tokens.length ? tokens[index] : '';
  });
}

function splitMarkdownTableRow(line) {
  const trimmed = String(line || '').trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let current = '';
  let escaped = false;

  for (const char of trimmed) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '|') {
      cells.push(collapseWhitespace(current));
      current = '';
      continue;
    }
    current += char;
  }

  cells.push(collapseWhitespace(current));
  return cells;
}

function isMarkdownTableDivider(line) {
  const cells = splitMarkdownTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isMarkdownTableStart(lines, index) {
  const line = String(lines[index] || '');
  const nextLine = String(lines[index + 1] || '');
  return line.includes('|') && nextLine.includes('|') && isMarkdownTableDivider(nextLine);
}

function stripInlineMarkdown(value) {
  return collapseWhitespace(value)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1');
}

function getTableCellLabel(headers, index) {
  return stripInlineMarkdown(headers[index] || '') || `Campo ${index + 1}`;
}

function isGenericTableHeader(value) {
  const normalized = stripInlineMarkdown(value).toLowerCase();
  return !normalized || [
    'id',
    'n',
    'no',
    'num',
    'numero',
    '#',
    'campo',
    'field',
    'chiave',
    'key',
  ].includes(normalized);
}

function buildTableRowTitle(headers, row) {
  const firstValue = stripInlineMarkdown(row[0] || '');
  if (!firstValue) return '';
  const firstHeader = stripInlineMarkdown(headers[0] || '');
  if (!firstHeader || isGenericTableHeader(firstHeader)) return firstValue;
  return firstValue;
}

function tableToRecordList(headers, rows) {
  const safeHeaders = headers.map(stripInlineMarkdown);
  return rows.map((row) => {
    const safeValues = row.map(stripInlineMarkdown);
    const nonEmptyValues = safeValues.filter(Boolean);
    if (nonEmptyValues.length === 0) return '';

    if (safeHeaders.length === 2) {
      const key = safeValues[0] || getTableCellLabel(safeHeaders, 0);
      const value = safeValues[1] || '';
      return value ? `${BULLET} ${key}: ${value}` : `${BULLET} ${key}`;
    }

    const title = buildTableRowTitle(safeHeaders, safeValues);
    const lines = [`${BULLET} ${title || nonEmptyValues[0]}`];
    const startIndex = title ? 1 : 0;
    for (let index = startIndex; index < safeHeaders.length; index += 1) {
      const value = safeValues[index] || '';
      if (!value) continue;
      const label = getTableCellLabel(safeHeaders, index);
      lines.push(`  ${label}: ${value}`);
    }
    return lines.join('\n');
  }).filter(Boolean).join('\n');
}

function tableToPreformattedText(headers, rows) {
  const data = [headers, ...rows].map((row) => row.map(stripInlineMarkdown));
  const columnCount = Math.max(...data.map((row) => row.length));
  const widths = Array.from({ length: columnCount }, (_, columnIndex) => (
    Math.max(...data.map((row) => String(row[columnIndex] || '').length), 3)
  ));
  const formatRow = (row) => widths
    .map((width, columnIndex) => String(row[columnIndex] || '').padEnd(width, ' '))
    .join('  ')
    .trimEnd();
  return [
    formatRow(data[0] || []),
    widths.map((width) => '-'.repeat(width)).join('  '),
    ...data.slice(1).map(formatRow),
  ].join('\n');
}

function shouldRenderTableAsImage(headers, rows) {
  const columnCount = Math.max(headers.length, ...rows.map((row) => row.length), 0);
  const longestCell = Math.max(
    ...headers.map((cell) => stripInlineMarkdown(cell).length),
    ...rows.flatMap((row) => row.map((cell) => stripInlineMarkdown(cell).length)),
    0
  );
  return columnCount > 4 || rows.length > 6 || longestCell > 42;
}

function normalizeMarkdownListLine(line) {
  return String(line || '')
    .replace(/^(\s*)>\s?/, `$1${QUOTE_PREFIX} `)
    .replace(/^(\s*)[-*+]\s+(\[[ xX]\]\s*)?/, (_, indent, taskMarker = '') => (
      `${indent.slice(0, 4)}${BULLET} ${taskMarker}`
    ))
    .replace(/^(\s*)-{3,}\s*$/, '$1---');
}

function pushTextSegment(segments, lines) {
  const text = lines
    .map(normalizeMarkdownListLine)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text) {
    segments.push({ type: 'text', text });
  }
}

function collectMarkdownTable(lines, startIndex) {
  const tableLines = [lines[startIndex], lines[startIndex + 1]];
  let index = startIndex + 2;
  while (index < lines.length && String(lines[index] || '').includes('|') && String(lines[index] || '').trim()) {
    tableLines.push(lines[index]);
    index += 1;
  }

  const headers = splitMarkdownTableRow(tableLines[0]);
  const rows = tableLines.slice(2).map(splitMarkdownTableRow).filter((row) => row.some(Boolean));
  return { headers, rows, nextIndex: index };
}

function pushTableSegment(segments, headers, rows) {
  if (!headers.length || !rows.length) return;
  if (!shouldRenderTableAsImage(headers, rows)) {
    segments.push({ type: 'text', text: tableToRecordList(headers, rows) });
    return;
  }
  segments.push({
    type: 'table',
    headers,
    rows,
    fallbackText: tableToPreformattedText(headers, rows),
  });
}

function markdownToTelegramSegments(input) {
  const lines = String(input || '').replace(/\r\n?/g, '\n').split('\n');
  const segments = [];
  const textLines = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = String(line || '').match(/^```[a-zA-Z0-9_+-]*\s*$/);

    if (fenceMatch) {
      pushTextSegment(segments, textLines.splice(0));
      const codeLines = [];
      index += 1;
      while (index < lines.length && !String(lines[index] || '').match(/^```\s*$/)) {
        codeLines.push(lines[index]);
        index += 1;
      }
      segments.push({ type: 'pre', text: codeLines.join('\n') });
      continue;
    }

    if (isMarkdownTableStart(lines, index)) {
      pushTextSegment(segments, textLines.splice(0));
      const table = collectMarkdownTable(lines, index);
      pushTableSegment(segments, table.headers, table.rows);
      index = table.nextIndex - 1;
      continue;
    }

    textLines.push(line);
  }

  pushTextSegment(segments, textLines);
  return segments.length ? segments : [{ type: 'text', text: 'Risposta vuota.' }];
}

function renderTextSegmentToTelegramHtml(text) {
  const tokens = [];
  let rendered = String(text || '');

  rendered = rendered.replace(/`([^`\n]+)`/g, (_, code) => (
    stashRenderedToken(tokens, `<code>${escapeHtml(code)}</code>`)
  ));
  rendered = rendered.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, href) => (
    stashRenderedToken(tokens, `<a href="${escapeHtmlAttribute(href)}">${escapeHtml(label)}</a>`)
  ));

  rendered = escapeHtml(rendered);
  rendered = rendered.replace(/^ {0,3}#{1,6}\s+(.+)$/gm, (_, heading) => `<b>${heading.trim()}</b>`);
  rendered = rendered.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  rendered = rendered.replace(/__([^_\n]+)__/g, '<b>$1</b>');
  rendered = rendered.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  return restoreRenderedTokens(rendered, tokens);
}

function renderSegmentToTelegramHtml(segment) {
  if (segment.type === 'pre') {
    return `<pre><code>${escapeHtml(segment.text)}</code></pre>`;
  }
  if (segment.type === 'table') {
    return `<pre><code>${escapeHtml(segment.fallbackText || tableToPreformattedText(segment.headers, segment.rows))}</code></pre>`;
  }
  return renderTextSegmentToTelegramHtml(segment.text);
}

function wrapPreformattedHtml(escapedContent) {
  return `<pre><code>${escapedContent}</code></pre>`;
}

function splitRawLineToEscapedChunks(line, maxLength) {
  const chunks = [];
  let current = '';
  for (const char of String(line || '')) {
    const escaped = escapeHtml(char);
    if (current && current.length + escaped.length > maxLength) {
      chunks.push(current);
      current = '';
    }
    current += escaped;
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [''];
}

function renderPreSegmentToTelegramHtmlChunks(text, maxLength) {
  const wrapperLength = wrapPreformattedHtml('').length;
  const maxContentLength = Math.max(100, maxLength - wrapperLength);
  const chunks = [];
  let current = '';

  for (const line of String(text || '').split('\n')) {
    const escapedLine = escapeHtml(line);
    const addition = current ? `\n${escapedLine}` : escapedLine;
    if (current && current.length + addition.length > maxContentLength) {
      chunks.push(wrapPreformattedHtml(current));
      current = '';
    }

    if (escapedLine.length > maxContentLength) {
      for (const escapedPart of splitRawLineToEscapedChunks(line, maxContentLength)) {
        if (current) {
          chunks.push(wrapPreformattedHtml(current));
          current = '';
        }
        chunks.push(wrapPreformattedHtml(escapedPart));
      }
      continue;
    }

    current = current ? `${current}\n${escapedLine}` : escapedLine;
  }

  if (current || chunks.length === 0) {
    chunks.push(wrapPreformattedHtml(current));
  }
  return chunks;
}

function splitLongRenderedSegment(rendered, maxLength) {
  if (rendered.length <= maxLength) return [rendered];
  const chunks = [];
  let current = rendered;
  while (current.length > maxLength) {
    const preferredBreak = Math.max(
      current.lastIndexOf('\n\n', maxLength),
      current.lastIndexOf('\n', maxLength)
    );
    const splitAt = preferredBreak > Math.floor(maxLength * 0.5) ? preferredBreak : maxLength;
    chunks.push(current.slice(0, splitAt).trim());
    current = current.slice(splitAt).trim();
  }
  if (current) chunks.push(current);
  return chunks;
}

function appendRenderedChunk(chunks, rendered, maxLength) {
  const trimmed = String(rendered || '').trim();
  if (!trimmed) return;

  for (const part of splitLongRenderedSegment(trimmed, maxLength)) {
    const lastIndex = chunks.length - 1;
    const separator = chunks[lastIndex] ? '\n\n' : '';
    if (lastIndex >= 0 && `${chunks[lastIndex]}${separator}${part}`.length <= maxLength) {
      chunks[lastIndex] = `${chunks[lastIndex]}${separator}${part}`;
    } else {
      chunks.push(part);
    }
  }
}

function renderMarkdownToTelegramHtmlChunks(text, maxLength = DEFAULT_TELEGRAM_TEXT_LIMIT) {
  const chunks = [];
  const limit = Math.max(1000, Number(maxLength) || DEFAULT_TELEGRAM_TEXT_LIMIT);
  for (const segment of markdownToTelegramSegments(text)) {
    if (segment.type === 'pre') {
      for (const renderedPreChunk of renderPreSegmentToTelegramHtmlChunks(segment.text, limit)) {
        appendRenderedChunk(chunks, renderedPreChunk, limit);
      }
      continue;
    }
    if (segment.type === 'table') {
      const fallbackText = segment.fallbackText || tableToPreformattedText(segment.headers, segment.rows);
      for (const renderedPreChunk of renderPreSegmentToTelegramHtmlChunks(fallbackText, limit)) {
        appendRenderedChunk(chunks, renderedPreChunk, limit);
      }
      continue;
    }
    appendRenderedChunk(chunks, renderSegmentToTelegramHtml(segment), limit);
  }
  return chunks.length ? chunks : ['Risposta vuota.'];
}

function chunkPlainTelegramText(text, maxLength = DEFAULT_TELEGRAM_TEXT_LIMIT) {
  const limit = Math.max(1000, Number(maxLength) || DEFAULT_TELEGRAM_TEXT_LIMIT);
  const chunks = [];
  appendRenderedChunk(chunks, String(text || '').trim() || 'Risposta vuota.', limit);
  return chunks;
}

function buildTelegramSendMessagePayloads({ chatId, text, replyMarkup, parseMode, maxLength }) {
  const normalizedParseMode = normalizeTelegramParseMode(parseMode);
  const chunks = normalizedParseMode === TELEGRAM_HTML_PARSE_MODE
    ? renderMarkdownToTelegramHtmlChunks(text, maxLength)
    : chunkPlainTelegramText(text, maxLength);

  return chunks.map((chunk, index) => ({
    chat_id: String(chatId),
    text: chunk,
    parse_mode: normalizedParseMode || undefined,
    reply_markup: index === chunks.length - 1 ? replyMarkup : undefined,
  }));
}

function appendTextDeliveries(deliveries, chatId, chunks, parseMode) {
  for (const chunk of chunks) {
    deliveries.push({
      method: 'sendMessage',
      payload: {
        chat_id: String(chatId),
        text: chunk,
        parse_mode: parseMode || undefined,
      },
    });
  }
}

function applyReplyMarkupToLastDelivery(deliveries, replyMarkup) {
  if (!replyMarkup || deliveries.length === 0) return;
  const last = deliveries[deliveries.length - 1];
  last.payload = {
    ...(last.payload || {}),
    reply_markup: replyMarkup,
  };
}

function buildFallbackPayloads(chatId, text, parseMode, maxLength) {
  const chunks = parseMode === TELEGRAM_HTML_PARSE_MODE
    ? renderPreSegmentToTelegramHtmlChunks(text, maxLength)
    : chunkPlainTelegramText(text, maxLength);
  return chunks.map((chunk) => ({
    chat_id: String(chatId),
    text: chunk,
    parse_mode: parseMode || undefined,
  }));
}

async function buildTelegramSendDeliveries({ chatId, text, replyMarkup, parseMode, maxLength, tableImages = true }) {
  const normalizedParseMode = normalizeTelegramParseMode(parseMode);
  const limit = Math.max(1000, Number(maxLength) || DEFAULT_TELEGRAM_TEXT_LIMIT);

  if (!tableImages) {
    return buildTelegramSendMessagePayloads({ chatId, text, replyMarkup, parseMode, maxLength })
      .map((payload) => ({ method: 'sendMessage', payload }));
  }

  const deliveries = [];
  const pendingChunks = [];
  const flushPendingChunks = () => {
    appendTextDeliveries(deliveries, chatId, pendingChunks.splice(0), normalizedParseMode);
  };

  for (const segment of markdownToTelegramSegments(text)) {
    if (segment.type === 'pre') {
      const chunks = normalizedParseMode === TELEGRAM_HTML_PARSE_MODE
        ? renderPreSegmentToTelegramHtmlChunks(segment.text, limit)
        : chunkPlainTelegramText(segment.text, limit);
      for (const renderedPreChunk of chunks) {
        appendRenderedChunk(pendingChunks, renderedPreChunk, limit);
      }
      continue;
    }

    if (segment.type !== 'table') {
      const rendered = normalizedParseMode === TELEGRAM_HTML_PARSE_MODE
        ? renderSegmentToTelegramHtml(segment)
        : segment.text;
      appendRenderedChunk(pendingChunks, rendered, limit);
      continue;
    }

    flushPendingChunks();
    const fallbackText = segment.fallbackText || tableToPreformattedText(segment.headers, segment.rows);
    try {
      const images = await renderMarkdownTableImages(segment.headers, segment.rows);
      if (!images.length) {
        const chunks = normalizedParseMode === TELEGRAM_HTML_PARSE_MODE
          ? renderPreSegmentToTelegramHtmlChunks(fallbackText, limit)
          : chunkPlainTelegramText(fallbackText, limit);
        for (const renderedPreChunk of chunks) {
          appendRenderedChunk(pendingChunks, renderedPreChunk, limit);
        }
        continue;
      }

      images.forEach((image) => {
        const pageRows = segment.rows.slice(image.rowStart, image.rowEnd + 1);
        const pageFallbackText = tableToPreformattedText(segment.headers, pageRows.length ? pageRows : segment.rows);
        deliveries.push({
          method: 'sendPhoto',
          payload: {
            chat_id: String(chatId),
            photo: {
              buffer: image.buffer,
              filename: image.filename,
              contentType: image.contentType,
            },
            caption: image.caption,
            parse_mode: image.caption ? normalizedParseMode || undefined : undefined,
          },
          fallbackPayloads: buildFallbackPayloads(chatId, pageFallbackText, normalizedParseMode, limit),
        });
      });
    } catch (error) {
      console.error('Errore generazione immagine tabella Telegram:', error?.message || error);
      const chunks = normalizedParseMode === TELEGRAM_HTML_PARSE_MODE
        ? renderPreSegmentToTelegramHtmlChunks(fallbackText, limit)
        : chunkPlainTelegramText(fallbackText, limit);
      for (const renderedPreChunk of chunks) {
        appendRenderedChunk(pendingChunks, renderedPreChunk, limit);
      }
    }
  }

  flushPendingChunks();
  if (deliveries.length === 0) {
    appendTextDeliveries(deliveries, chatId, ['Risposta vuota.'], normalizedParseMode);
  }
  applyReplyMarkupToLastDelivery(deliveries, replyMarkup);
  return deliveries;
}

function buildTelegramSendMessagePayload(input = {}) {
  return buildTelegramSendMessagePayloads(input)[0];
}

module.exports = {
  TELEGRAM_HTML_PARSE_MODE,
  normalizeTelegramParseMode,
  markdownToTelegramSegments,
  renderMarkdownToTelegramHtmlChunks,
  buildTelegramSendMessagePayload,
  buildTelegramSendMessagePayloads,
  buildTelegramSendDeliveries,
};
