const MAX_IMAGE_WIDTH = 2000;
const MAX_IMAGE_HEIGHT = 2600;
const MIN_IMAGE_WIDTH = 760;
const OUTER_PADDING = 36;
const CELL_PADDING_X = 18;
const CELL_PADDING_Y = 14;
const BODY_FONT_SIZE = 24;
const HEADER_FONT_SIZE = 25;
const LINE_HEIGHT = 32;
const HEADER_LINE_HEIGHT = 34;
const MAX_CELL_LINES = 8;
const FONT_FAMILY = 'DejaVu Sans, Noto Sans, Arial, Helvetica, sans-serif';
let sharpModule = null;

function getSharp() {
  if (!sharpModule) {
    sharpModule = require('sharp');
  }
  return sharpModule;
}

function collapseWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripInlineMarkdown(value) {
  return collapseWhitespace(value)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1');
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function normalizeTable(headers, rows) {
  const safeHeaders = (headers || []).map(stripInlineMarkdown);
  const safeRows = (rows || []).map((row) => (row || []).map(stripInlineMarkdown));
  const columnCount = Math.max(
    safeHeaders.length,
    ...safeRows.map((row) => row.length),
    1
  );

  return {
    headers: Array.from({ length: columnCount }, (_, index) => safeHeaders[index] || `Colonna ${index + 1}`),
    rows: safeRows.map((row) => Array.from({ length: columnCount }, (_, index) => row[index] || '')),
    columnCount,
  };
}

function splitLongWord(word, maxChars) {
  if (word.length <= maxChars) return [word];
  const parts = [];
  for (let index = 0; index < word.length; index += maxChars) {
    parts.push(word.slice(index, index + maxChars));
  }
  return parts;
}

function wrapText(value, width, fontSize, maxLines = MAX_CELL_LINES) {
  const text = collapseWhitespace(value);
  if (!text) return [''];

  const maxChars = Math.max(5, Math.floor((width - CELL_PADDING_X * 2) / (fontSize * 0.52)));
  const words = text.split(/\s+/).flatMap((word) => splitLongWord(word, maxChars));
  const lines = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }

    if (lines.length >= maxLines) break;
  }

  if (current && lines.length < maxLines) {
    lines.push(current);
  }

  const wasTruncated = words.join(' ').length > lines.join(' ').length;
  if (wasTruncated && lines.length > 0) {
    const lastIndex = lines.length - 1;
    lines[lastIndex] = `${lines[lastIndex].slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
  }

  return lines.length ? lines : [''];
}

function measureRow(cells, columnWidth, fontSize, lineHeight, maxLines = MAX_CELL_LINES) {
  const wrappedCells = cells.map((cell) => wrapText(cell, columnWidth, fontSize, maxLines));
  const lineCount = Math.max(...wrappedCells.map((lines) => lines.length), 1);
  return {
    wrappedCells,
    height: Math.max(58, CELL_PADDING_Y * 2 + lineCount * lineHeight),
  };
}

function buildLayout(table) {
  const imageWidth = Math.min(
    MAX_IMAGE_WIDTH,
    Math.max(MIN_IMAGE_WIDTH, OUTER_PADDING * 2 + table.columnCount * 250)
  );
  const gridWidth = imageWidth - OUTER_PADDING * 2;
  const columnWidth = Math.floor(gridWidth / table.columnCount);
  const widths = Array.from({ length: table.columnCount }, (_, index) => {
    if (index === table.columnCount - 1) {
      return gridWidth - columnWidth * (table.columnCount - 1);
    }
    return columnWidth;
  });
  return { imageWidth, gridWidth, widths };
}

function paginateRows(table, layout) {
  const columnWidth = Math.min(...layout.widths);
  const header = measureRow(table.headers, columnWidth, HEADER_FONT_SIZE, HEADER_LINE_HEIGHT, 3);
  const measuredRows = table.rows.map((row) => measureRow(row, columnWidth, BODY_FONT_SIZE, LINE_HEIGHT));
  const maxRowsHeight = MAX_IMAGE_HEIGHT - OUTER_PADDING * 2 - header.height;
  const pages = [];
  let currentRows = [];
  let currentHeight = 0;

  measuredRows.forEach((row, rowIndex) => {
    if (currentRows.length > 0 && currentHeight + row.height > maxRowsHeight) {
      pages.push(currentRows);
      currentRows = [];
      currentHeight = 0;
    }
    currentRows.push({ ...row, rowIndex });
    currentHeight += row.height;
  });

  if (currentRows.length > 0 || pages.length === 0) {
    pages.push(currentRows);
  }

  return { header, pages };
}

function renderCellText(lines, x, y, width, options = {}) {
  const fontSize = options.fontSize || BODY_FONT_SIZE;
  const lineHeight = options.lineHeight || LINE_HEIGHT;
  const weight = options.weight || 400;
  const fill = options.fill || '#111827';
  const textY = y + CELL_PADDING_Y + fontSize;

  return lines.map((line, index) => (
    `<text x="${x + CELL_PADDING_X}" y="${textY + index * lineHeight}" font-family="${FONT_FAMILY}" font-size="${fontSize}" font-weight="${weight}" fill="${fill}">${escapeXml(line)}</text>`
  )).join('');
}

function renderRow(row, x, y, widths, options = {}) {
  const fill = options.fill || '#ffffff';
  const stroke = options.stroke || '#d1d5db';
  const textOptions = options.textOptions || {};
  let currentX = x;
  const cells = row.wrappedCells.map((lines, index) => {
    const width = widths[index];
    const cell = [
      `<rect x="${currentX}" y="${y}" width="${width}" height="${row.height}" fill="${fill}" stroke="${stroke}" stroke-width="1"/>`,
      renderCellText(lines, currentX, y, width, textOptions),
    ].join('');
    currentX += width;
    return cell;
  });
  return cells.join('');
}

function buildSvg(table, layout, pagination, pageRows, pageIndex, totalPages) {
  const headerY = OUTER_PADDING;
  const rowsHeight = pageRows.reduce((sum, row) => sum + row.height, 0);
  const imageHeight = Math.min(MAX_IMAGE_HEIGHT, OUTER_PADDING * 2 + pagination.header.height + rowsHeight);
  let y = headerY;

  const headerSvg = renderRow(pagination.header, OUTER_PADDING, y, layout.widths, {
    fill: '#eef2f7',
    stroke: '#cbd5e1',
    textOptions: {
      fontSize: HEADER_FONT_SIZE,
      lineHeight: HEADER_LINE_HEIGHT,
      weight: 700,
      fill: '#0f172a',
    },
  });
  y += pagination.header.height;

  const rowsSvg = pageRows.map((row, index) => {
    const rendered = renderRow(row, OUTER_PADDING, y, layout.widths, {
      fill: index % 2 === 0 ? '#ffffff' : '#f8fafc',
      stroke: '#e2e8f0',
      textOptions: {
        fontSize: BODY_FONT_SIZE,
        lineHeight: LINE_HEIGHT,
        weight: 400,
        fill: '#111827',
      },
    });
    y += row.height;
    return rendered;
  }).join('');

  const pageLabel = totalPages > 1
    ? `<text x="${layout.imageWidth - OUTER_PADDING}" y="${imageHeight - 12}" font-size="18" text-anchor="end" fill="#64748b">Pagina ${pageIndex + 1}/${totalPages}</text>`
    : '';

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.imageWidth}" height="${imageHeight}" viewBox="0 0 ${layout.imageWidth} ${imageHeight}">`,
    '<rect width="100%" height="100%" fill="#ffffff"/>',
    '<g>',
    headerSvg,
    rowsSvg,
    pageLabel,
    '</g>',
    '</svg>',
  ].join('');
}

async function renderMarkdownTableImages(headers, rows) {
  const table = normalizeTable(headers, rows);
  if (!table.rows.length) return [];

  const layout = buildLayout(table);
  const pagination = paginateRows(table, layout);
  const totalPages = pagination.pages.length;

  const images = [];
  for (let index = 0; index < pagination.pages.length; index += 1) {
    const pageRows = pagination.pages[index];
    const svg = buildSvg(table, layout, pagination, pageRows, index, totalPages);
    const buffer = await getSharp()(Buffer.from(svg)).png().toBuffer();
    images.push({
      buffer,
      filename: `telegram-table-${index + 1}.png`,
      contentType: 'image/png',
      rowStart: pageRows[0]?.rowIndex || 0,
      rowEnd: pageRows[pageRows.length - 1]?.rowIndex || 0,
    });
  }

  return images;
}

module.exports = {
  renderMarkdownTableImages,
};
