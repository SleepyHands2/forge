import { PDFParse } from 'pdf-parse';

export type DocumentType = 'pdf' | 'md' | 'txt' | 'csv';

export function documentTypeFromName(name: string): DocumentType | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.md')) return 'md';
  if (lower.endsWith('.txt')) return 'txt';
  if (lower.endsWith('.csv')) return 'csv';
  return null;
}

/**
 * Extract plain text from an uploaded document. Text formats are decoded as
 * UTF-8; PDFs go through pdf-parse (pdfjs) locally. Never sends bytes anywhere.
 */
export async function extractText(type: DocumentType, data: Buffer): Promise<string> {
  if (type !== 'pdf') {
    return data.toString('utf-8');
  }

  const parser = new PDFParse({ data });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy().catch(() => {});
  }
}
