import type BetterSqlite3 from 'better-sqlite3';
import type { ChatMessage, ForgeConfig } from '../types.ts';

type Database = BetterSqlite3.Database;
type ConversationMessage = Pick<ChatMessage, 'role' | 'content'>;

type MessageRow = {
  id: string;
  user: 'user' | 'assistant';
  text: string;
  receivedAt: string | number;
};

type Turn = {
  messages: ConversationMessage[];
  tokens: number;
  /** receivedAt of the oldest message in this turn (its user message). */
  oldestReceivedAt: number;
};

export interface BuildConversationInput {
  db: Database;
  config: ForgeConfig;
  currentMessageId: string;
  systemPrompt: string;
  currentUserMessage: ChatMessage;
  /** Message channel to load history from. Defaults to 'web'. */
  channel?: string;
  /** Optional conversation scope within the channel (e.g. a Telegram chat id). */
  channelName?: string;
}

export interface ConversationHistoryResult {
  messages: ChatMessage[];
  includedHistoryMessages: number;
  omittedHistoryMessages: number;
  estimatedPromptTokens: number;
  promptBudgetTokens: number;
  /** receivedAt of the oldest history message in the window; undefined when no history is included. */
  oldestIncludedReceivedAt?: number;
}

export class ChatContextTooLargeError extends Error {
  constructor() {
    super(
      'The current message, attachments, identity, and memory context exceed the configured Ollama context window. Shorten the message or attachments, reduce identity content, or increase llm.ollama.options.num_ctx.',
    );
    this.name = 'ChatContextTooLargeError';
  }
}

const MAX_QUERY_MESSAGES = 100;
const MAX_HISTORY_MESSAGES = 50;
const DEFAULT_NUM_CTX = 8192;
const DEFAULT_NUM_PREDICT = 1024;
const RESPONSE_BUFFER_TOKENS = 512;
const MESSAGE_OVERHEAD_TOKENS = 8;
const IMAGE_TOKEN_RESERVE = 1024;

/**
 * Tokens available for the prompt (system + messages) after reserving room
 * for the model's response. Exported so other context producers (identity
 * budgeting) size themselves against the same window arithmetic.
 */
export function computePromptBudgetTokens(config: ForgeConfig): number {
  const numCtx = readPositiveInteger(
    (config as { llm?: { ollama?: { options?: Record<string, unknown> } } })
      .llm?.ollama?.options?.num_ctx,
    DEFAULT_NUM_CTX,
  );
  const numPredict = readPositiveInteger(
    (config as { llm?: { ollama?: { options?: Record<string, unknown> } } })
      .llm?.ollama?.options?.num_predict,
    DEFAULT_NUM_PREDICT,
  );
  return Math.max(
    0,
    numCtx - Math.min(numPredict, Math.floor(numCtx / 2)) - RESPONSE_BUFFER_TOKENS,
  );
}

export function buildConversationMessages(
  input: BuildConversationInput,
): ConversationHistoryResult {
  const promptBudgetTokens = computePromptBudgetTokens(input.config);

  const currentMessageTokens = estimateMessageTokens(input.currentUserMessage);
  const systemPromptTokens = estimateTextTokens(input.systemPrompt);
  const currentImageTokens =
    (input.currentUserMessage.images?.length ?? 0) * IMAGE_TOKEN_RESERVE;
  const requiredCurrentTokens =
    systemPromptTokens + currentMessageTokens + currentImageTokens;

  if (requiredCurrentTokens > promptBudgetTokens) {
    throw new ChatContextTooLargeError();
  }

  const priorRows = loadPriorMessages(input.db, input.currentMessageId, input.channel ?? 'web', input.channelName);
  const historyTurns = groupTurns(priorRows.reverse());
  const selectedTurns = selectNewestTurns(
    historyTurns,
    promptBudgetTokens - requiredCurrentTokens,
  );
  const historyMessages = selectedTurns.flatMap((turn) => turn.messages);
  const historyTokens = selectedTurns.reduce((sum, turn) => sum + turn.tokens, 0);
  const availableHistoryMessages = historyTurns.reduce(
    (sum, turn) => sum + turn.messages.length,
    0,
  );

  return {
    messages: [...historyMessages, input.currentUserMessage],
    includedHistoryMessages: historyMessages.length,
    omittedHistoryMessages: availableHistoryMessages - historyMessages.length,
    estimatedPromptTokens: requiredCurrentTokens + historyTokens,
    promptBudgetTokens,
    ...(selectedTurns.length > 0 ? { oldestIncludedReceivedAt: selectedTurns[0].oldestReceivedAt } : {}),
  };
}

function loadPriorMessages(db: Database, currentMessageId: string, channel: string, channelName?: string): MessageRow[] {
  // The channel is an internal constant ('web', 'telegram'), never user input;
  // it is inlined so the default web query stays byte-identical to the
  // original single-channel SQL.
  if (!/^[a-z][a-z0-9_-]*$/.test(channel)) {
    throw new Error(`Invalid channel name: ${channel}`);
  }
  const channelNameFilter = channelName !== undefined ? '\n         AND channelName = ?' : '';
  const params: unknown[] = channelName !== undefined
    ? [channelName, currentMessageId, MAX_QUERY_MESSAGES]
    : [currentMessageId, MAX_QUERY_MESSAGES];
  return db
    .prepare(
      `SELECT id, user, text, receivedAt
       FROM messages
       WHERE channel = '${channel}'${channelNameFilter}
         AND id <> ?
         AND user IN ('user', 'assistant')
         AND trim(text) <> ''
       ORDER BY receivedAt DESC, rowid DESC
       LIMIT ?`,
    )
    .all(...params) as MessageRow[];
}

function groupTurns(rows: MessageRow[]): Turn[] {
  const turns: Turn[] = [];
  let currentTurn: ConversationMessage[] | null = null;
  let currentTurnOldestReceivedAt = 0;

  for (const row of rows) {
    if (row.user === 'user') {
      if (currentTurn) {
        turns.push(toTurn(currentTurn, currentTurnOldestReceivedAt));
      }
      currentTurn = [{ role: 'user', content: row.text } as ConversationMessage];
      currentTurnOldestReceivedAt = Number(row.receivedAt);
      continue;
    }

    if (currentTurn) {
      currentTurn.push({
        role: 'assistant',
        content: row.text,
      } as ConversationMessage);
    }
  }

  if (currentTurn) {
    turns.push(toTurn(currentTurn, currentTurnOldestReceivedAt));
  }

  return turns;
}

function selectNewestTurns(turns: Turn[], historyBudgetTokens: number): Turn[] {
  const selectedTurns: Turn[] = [];
  let selectedMessages = 0;
  let selectedTokens = 0;

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];

    if (selectedMessages + turn.messages.length > MAX_HISTORY_MESSAGES) {
      break;
    }

    if (selectedTokens + turn.tokens > historyBudgetTokens) {
      break;
    }

    selectedTurns.unshift(turn);
    selectedMessages += turn.messages.length;
    selectedTokens += turn.tokens;
  }

  return selectedTurns;
}

function toTurn(messages: ConversationMessage[], oldestReceivedAt: number): Turn {
  return {
    messages,
    tokens: messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0),
    oldestReceivedAt,
  };
}

function estimateMessageTokens(message: ConversationMessage): number {
  return estimateTextTokens(String(message.content ?? '')) + MESSAGE_OVERHEAD_TOKENS;
}

/** ~3 UTF-8 bytes per token; the single estimator every budget check shares. */
export function estimateTextTokens(text: string): number {
  if (!text) {
    return 0;
  }

  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
}

function readPositiveInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
}
