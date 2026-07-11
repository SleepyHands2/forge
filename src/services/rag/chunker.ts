export interface ChunkOptions {
  chunkTokens: number;
  overlapTokens: number;
}

export interface TextChunk {
  content: string;
  tokenEstimate: number;
}

const DEFAULT_OPTIONS: ChunkOptions = { chunkTokens: 400, overlapTokens: 50 };

/** Same deliberately simple estimator as chat-history.ts: ~3 UTF-8 bytes per token. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
}

/**
 * Deterministic greedy chunker: split on paragraph boundaries (long paragraphs
 * fall back to sentence, then hard splits), pack pieces up to the target token
 * size, and carry a token-bounded tail of each chunk into the next as overlap
 * so facts straddling a boundary stay retrievable.
 */
export function chunkText(text: string, options: Partial<ChunkOptions> = {}): TextChunk[] {
  const { chunkTokens, overlapTokens } = { ...DEFAULT_OPTIONS, ...options };
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const pieces = splitIntoPieces(normalized, chunkTokens);
  const chunks: TextChunk[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    const content = current.join('\n\n').trim();
    if (content) chunks.push({ content, tokenEstimate: estimateTokens(content) });
    current = [];
    currentTokens = 0;
  };

  for (const piece of pieces) {
    const pieceTokens = estimateTokens(piece);
    if (currentTokens > 0 && currentTokens + pieceTokens > chunkTokens) {
      const overlap = overlapTail(current.join('\n\n'), overlapTokens);
      flush();
      if (overlap) {
        current = [overlap];
        currentTokens = estimateTokens(overlap);
      }
    }
    current.push(piece);
    currentTokens += pieceTokens;
  }
  flush();

  return chunks;
}

/**
 * CSV-aware chunking: rows are packed into chunks with the header row repeated
 * at the top of every chunk so each chunk stays independently interpretable.
 */
export function chunkCsv(text: string, options: Partial<ChunkOptions> = {}): TextChunk[] {
  const { chunkTokens } = { ...DEFAULT_OPTIONS, ...options };
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter(line => line.trim().length > 0);
  if (lines.length === 0) return [];
  if (lines.length === 1) {
    return [{ content: lines[0], tokenEstimate: estimateTokens(lines[0]) }];
  }

  const [header, ...rows] = lines;
  const headerTokens = estimateTokens(header);
  const chunks: TextChunk[] = [];
  let currentRows: string[] = [];
  let currentTokens = headerTokens;

  const flush = (): void => {
    if (currentRows.length === 0) return;
    const content = [header, ...currentRows].join('\n');
    chunks.push({ content, tokenEstimate: estimateTokens(content) });
    currentRows = [];
    currentTokens = headerTokens;
  };

  for (const row of rows) {
    const rowTokens = estimateTokens(row);
    if (currentRows.length > 0 && currentTokens + rowTokens > chunkTokens) flush();
    currentRows.push(row);
    currentTokens += rowTokens;
  }
  flush();

  return chunks;
}

function splitIntoPieces(text: string, chunkTokens: number): string[] {
  const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const pieces: string[] = [];
  for (const paragraph of paragraphs) {
    if (estimateTokens(paragraph) <= chunkTokens) {
      pieces.push(paragraph);
      continue;
    }
    // Oversized paragraph: split on sentence boundaries, hard-split any
    // sentence that is still too large on its own.
    for (const sentence of splitSentences(paragraph)) {
      if (estimateTokens(sentence) <= chunkTokens) {
        pieces.push(sentence);
      } else {
        pieces.push(...hardSplit(sentence, chunkTokens));
      }
    }
  }
  return pieces;
}

function splitSentences(paragraph: string): string[] {
  const matches = paragraph.match(/[^.!?\n]+[.!?]*\s*/g);
  if (!matches) return [paragraph];
  return matches.map(s => s.trim()).filter(Boolean);
}

function hardSplit(text: string, chunkTokens: number): string[] {
  // Token estimate is bytes/3; use a conservative character budget.
  const maxChars = Math.max(1, chunkTokens * 3);
  const parts: string[] = [];
  for (let index = 0; index < text.length; index += maxChars) {
    parts.push(text.slice(index, index + maxChars));
  }
  return parts;
}

function overlapTail(text: string, overlapTokens: number): string {
  if (overlapTokens <= 0) return '';
  const maxChars = overlapTokens * 3;
  if (text.length <= maxChars) return text;
  const tail = text.slice(-maxChars);
  // Start the overlap at a word boundary where possible.
  const firstSpace = tail.indexOf(' ');
  return (firstSpace > 0 && firstSpace < tail.length - 1 ? tail.slice(firstSpace + 1) : tail).trim();
}
