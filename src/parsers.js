// Turns a requirements file (md, docx, pdf, html) into plain Markdown-ish text.
import fs from 'node:fs/promises';
import path from 'node:path';

export const SUPPORTED = ['.md', '.markdown', '.txt', '.docx', '.pdf', '.html', '.htm'];

export async function parseFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED.includes(ext)) {
    throw new Error(`Unsupported file type "${ext}". Supported: ${SUPPORTED.join(', ')}`);
  }
  const buf = await fs.readFile(filePath);
  let text;
  switch (ext) {
    case '.md':
    case '.markdown':
    case '.txt':
      text = buf.toString('utf8');
      break;
    case '.docx':
      text = await parseDocx(buf);
      break;
    case '.pdf':
      text = await parsePdf(buf);
      break;
    case '.html':
    case '.htm':
      text = await parseHtml(buf.toString('utf8'));
      break;
  }
  text = normalize(text);
  if (!text.trim()) throw new Error(`No text could be extracted from ${filePath}. (Scanned PDFs need OCR first.)`);
  return { text, format: ext.replace('.', ''), chars: text.length };
}

async function parseDocx(buf) {
  // Convert via HTML so headings, lists and tables survive as Markdown structure.
  const mammoth = (await import('mammoth')).default;
  const { value: html } = await mammoth.convertToHtml({ buffer: buf });
  return parseHtml(html);
}

async function parsePdf(buf) {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

async function parseHtml(html) {
  const TurndownService = (await import('turndown')).default;
  const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' });
  td.remove(['head', 'title', 'script', 'style', 'noscript', 'iframe', 'svg']);
  // Keep simple tables readable: cells separated by " | ".
  td.addRule('tableCell', {
    filter: ['th', 'td'],
    replacement: (content) => ` ${content.trim().replace(/\n+/g, ' ')} |`,
  });
  td.addRule('tableRow', {
    filter: 'tr',
    replacement: (content) => `\n|${content}`,
  });
  return td.turndown(html);
}

function normalize(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
