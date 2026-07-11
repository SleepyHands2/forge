# Memory Eval Baselines

Phase one uses SQLite FTS5 memory search only. Cloud embeddings have been removed from this branch.

## LOCOMO

Benchmark: LoCoMo, 1986 questions, top-K=10.

### 2026-04-20 - FTS5 Only

- Hit rate: 95.6% (1898/1986)
- MRR@10: 0.7585
- Time: 0.7s (0.4ms/question)

| Category | Total | Hits | Rate | MRR |
|---|---:|---:|---:|---:|
| open-domain | 841 | 824 | 98.0% | 0.8055 |
| adversarial | 446 | 432 | 96.9% | 0.8123 |
| temporal | 321 | 307 | 95.6% | 0.7673 |
| single-hop | 282 | 263 | 93.3% | 0.6303 |
| multi-hop | 96 | 72 | 75.0% | 0.4448 |

Key takeaway: multi-hop failures need reasoning over relationships, not just retrieval.

## LongMemEval

Benchmark: LongMemEval oracle split, 500 entries, top-K=10.

### 2026-04-20 - FTS5 Only

- Hit rate: 99.0% (495/500)
- MRR@10: 0.9167
- Time: 6.4s (12.8ms/entry)

| Type | Total | Hits | Rate | MRR |
|---|---:|---:|---:|---:|
| single-session-assistant | 56 | 56 | 100.0% | 1.0000 |
| single-session-user | 70 | 70 | 100.0% | 0.9348 |
| knowledge-update | 78 | 78 | 100.0% | 0.9808 |
| multi-session | 133 | 132 | 99.2% | 0.9430 |
| temporal-reasoning | 133 | 131 | 98.5% | 0.8647 |
| single-session-preference | 30 | 28 | 93.3% | 0.6659 |

Key takeaway: remaining failures mostly require date math, counting, or implicit personal-history reasoning.

## Roadmap

Local embeddings may be added later through Ollama `/api/embed`, but they are not part of phase one.
