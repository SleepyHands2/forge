/**
 * Generic channel adapter contract. A channel is a message transport (web UI,
 * Telegram, later WhatsApp Cloud) that feeds the same ChatTurnService
 * pipeline. Adapters translate inbound transport messages into InboundMessage,
 * hand them to the handler, and deliver the returned reply text outbound.
 */

export interface InboundMessage {
  /** Channel constant ('telegram'); becomes messages.channel. */
  channel: string;
  /** Conversation id within the channel (e.g. Telegram chat id); becomes messages.channelName. */
  chatId: string;
  /** Display name of the sender; becomes messages.userName. */
  userName: string;
  /** Plain message text. */
  text: string;
  /** Optional model-facing override (e.g. attachment instructions); becomes TurnInput.llmContent. */
  llmText?: string;
  /** Optional attachment metadata for the debug prompt context; becomes TurnInput.attachmentsMeta. */
  attachmentsMeta?: Record<string, unknown>[];
}

export type InboundHandler = (message: InboundMessage) => Promise<string>;

export interface ChannelAdapter {
  readonly name: string;
  /** Begin receiving messages; resolves once the adapter is running. */
  start(): Promise<void>;
  /** Stop receiving and release resources. Safe to call more than once. */
  stop(): Promise<void>;
}
