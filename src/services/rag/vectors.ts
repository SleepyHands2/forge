/**
 * Vector helpers mirroring the memory.db embedding storage approach
 * (float32 little-endian BLOBs + cosine similarity). Kept local to the RAG
 * module so memory.ts internals stay private.
 */

export function packVector(vector: readonly number[]): Buffer {
  validateVector(vector);
  const packed = Buffer.allocUnsafe(vector.length * 4);
  for (let index = 0; index < vector.length; index += 1) {
    packed.writeFloatLE(vector[index], index * 4);
  }
  return packed;
}

export function unpackVector(value: unknown, dimensions: number): number[] | null {
  if (!Number.isInteger(dimensions) || dimensions < 1 || !Buffer.isBuffer(value) || value.length !== dimensions * 4) {
    return null;
  }
  const vector: number[] = [];
  for (let index = 0; index < dimensions; index += 1) {
    vector.push(value.readFloatLE(index * 4));
  }
  try {
    validateVector(vector);
    return vector;
  } catch {
    return null;
  }
}

export function validateVector(vector: readonly number[]): void {
  if (vector.length === 0 || !vector.every(value => Number.isFinite(value)) || vectorNorm(vector) === 0) {
    throw new Error('Embedding vector must contain finite values with a nonzero norm.');
  }
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number | undefined {
  if (left.length !== right.length) return undefined;
  const leftNorm = vectorNorm(left);
  const rightNorm = vectorNorm(right);
  if (leftNorm === 0 || rightNorm === 0) return undefined;

  let score = 0;
  for (let index = 0; index < left.length; index += 1) {
    score += (left[index] / leftNorm) * (right[index] / rightNorm);
  }
  return Number.isFinite(score) ? score : undefined;
}

function vectorNorm(vector: readonly number[]): number {
  let scale = 0;
  let sum = 1;
  for (const value of vector) {
    const absolute = Math.abs(value);
    if (absolute === 0) continue;
    if (scale < absolute) {
      sum = 1 + sum * (scale / absolute) ** 2;
      scale = absolute;
    } else {
      sum += (absolute / scale) ** 2;
    }
  }
  return scale === 0 ? 0 : scale * Math.sqrt(sum);
}
