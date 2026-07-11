import type BetterSqlite3 from 'better-sqlite3';
import type { ForgeConfig, SchedulerJobConfig } from '../../types.ts';
import type { ChatTurnService } from '../chat-turn.ts';
import { cronMatches, parseCron, type CronSpec } from './cron.ts';
import type { ReminderService } from './reminders.ts';

type Database = BetterSqlite3.Database;

const TICK_INTERVAL_MS = 15_000;
const DETAIL_PREVIEW_CHARS = 300;

export type JobDelivery = (chatId: string | undefined, text: string) => Promise<void>;

interface SchedulerLogger {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

export interface SchedulerServiceOptions {
  config: ForgeConfig;
  chatTurn: Pick<ChatTurnService, 'runTurn'>;
  /** Outbound delivery per channel name (e.g. { telegram: (chatId, text) => adapter.send(...) }). */
  deliveries?: Record<string, JobDelivery>;
  /** tools.db handle for the durable scheduler_runs log. */
  db?: Database;
  /** One-shot reminder store; when present, due reminders are delivered every tick. */
  reminders?: ReminderService;
  /** messages.db handle so delivered reminders appear in the web UI feed. */
  messagesDb?: Database;
  logger?: SchedulerLogger;
  now?: () => Date;
}

/**
 * Config-defined cron jobs that run unattended agent turns through the same
 * permission-gated ChatTurnService pipeline as every channel (identity,
 * memories, RAG, tool gates, audit logs). Output can be delivered to a
 * channel (Telegram) and always lands in messages.db under
 * channel='scheduler'.
 *
 * Single-GPU discipline: job executions are strictly serialized through one
 * queue — never parallel — and a job whose previous run is still executing
 * when its schedule fires again is skipped (and logged), so a slow job cannot
 * pile up an unbounded backlog.
 */
export class SchedulerService {
  private readonly config: ForgeConfig;
  private readonly chatTurn: Pick<ChatTurnService, 'runTurn'>;
  private readonly deliveries: Record<string, JobDelivery>;
  private readonly db?: Database;
  private readonly reminders?: ReminderService;
  private readonly messagesDb?: Database;
  private readonly logger: SchedulerLogger;
  private readonly now: () => Date;

  private specs = new Map<string, CronSpec>();
  private queueTail: Promise<void> = Promise.resolve();
  private activeOrQueued = new Set<string>();
  private lastFiredMinute = '';
  private timer: NodeJS.Timeout | null = null;

  constructor(options: SchedulerServiceOptions) {
    this.config = options.config;
    this.chatTurn = options.chatTurn;
    this.deliveries = options.deliveries ?? {};
    this.db = options.db;
    this.reminders = options.reminders;
    this.messagesDb = options.messagesDb;
    this.logger = options.logger ?? console;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Validates all job definitions and begins ticking. Throws on bad config.
   * Cron jobs require scheduler.enabled; reminders only need a ReminderService,
   * so the tick timer also starts when reminders are wired but cron is off.
   */
  start(): void {
    const scheduler = this.config.scheduler;
    this.specs = new Map();

    if (scheduler?.enabled === true) {
      const jobs = scheduler.jobs ?? [];
      if (jobs.length === 0) {
        this.logger.log('[scheduler] Enabled, but no jobs are defined.');
      }
      for (const job of jobs) {
        if (this.specs.has(job.name)) {
          throw new Error(`Duplicate scheduler job name: '${job.name}'`);
        }
        try {
          this.specs.set(job.name, parseCron(job.cron));
        } catch (err) {
          throw new Error(`Scheduler job '${job.name}': ${err instanceof Error ? err.message : String(err)}`);
        }
        if (job.channel !== 'none' && !this.deliveries[job.channel]) {
          this.logger.warn(`[scheduler] Job '${job.name}' targets channel '${job.channel}', which is not available; its runs will fail until the channel is enabled.`);
        }
      }
    }

    if (this.specs.size === 0 && !this.reminders) return;

    this.timer = setInterval(() => {
      void this.tick(this.now());
    }, TICK_INTERVAL_MS);
    this.timer.unref?.();
    if (this.specs.size > 0) {
      this.logger.log(`[scheduler] Started with ${this.specs.size} job(s).`);
    }
    if (this.reminders) {
      this.logger.log('[scheduler] Reminder delivery active.');
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Deliver due reminders, then fire all jobs whose cron matches the given
   * date's minute. Reminders are checked on every tick (they are lightweight
   * and run no LLM turn); cron jobs fire at most once per matching minute
   * regardless of tick frequency. Returns a promise that resolves when every
   * job enqueued by this tick has finished.
   */
  async tick(date: Date): Promise<void> {
    await this.processDueReminders(date.getTime());

    const minuteKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}T${date.getHours()}:${date.getMinutes()}`;
    if (minuteKey === this.lastFiredMinute) return;
    this.lastFiredMinute = minuteKey;

    const jobs = this.config.scheduler?.jobs ?? [];
    const enqueued: Promise<void>[] = [];
    for (const job of jobs) {
      const spec = this.specs.get(job.name);
      if (!spec || !cronMatches(spec, date)) continue;

      if (this.activeOrQueued.has(job.name)) {
        this.logger.warn(`[scheduler] Skipping '${job.name}': previous run is still in progress.`);
        this.logRun(job.name, 'skipped', 'Previous run still in progress.', 0, false);
        continue;
      }

      this.activeOrQueued.add(job.name);
      // Strict serialization: every execution chains onto one queue tail.
      const run = this.queueTail.then(() => this.executeJob(job)).finally(() => {
        this.activeOrQueued.delete(job.name);
      });
      this.queueTail = run.catch(() => {});
      enqueued.push(run);
    }
    await Promise.all(enqueued);
  }

  /**
   * Delivers every due reminder: always into the messages feed (web UI), plus
   * the first allowlisted Telegram chat when the bridge is available. Each
   * reminder ends up 'sent' or 'error' — failures never escape the tick.
   */
  private async processDueReminders(nowMs: number): Promise<void> {
    const reminders = this.reminders;
    if (!reminders) return;

    let due: ReturnType<ReminderService['duePending']>;
    try {
      due = reminders.duePending(nowMs);
    } catch (err) {
      this.logger.warn('[scheduler] Failed to read due reminders:', err instanceof Error ? err.message : String(err));
      return;
    }

    for (const reminder of due) {
      const text = `⏰ Reminder: ${reminder.message}`;
      try {
        let delivered = false;
        this.insertReminderMessage(reminder.id, text);

        const deliver = this.deliveries['telegram'];
        const allowedChatIds = this.config.channels?.telegram?.allowed_chat_ids ?? [];
        if (deliver && allowedChatIds.length > 0) {
          await deliver(String(allowedChatIds[0]), text);
          delivered = true;
        }

        reminders.markSent(reminder.id);
        this.logRun('reminder', 'ok', preview(reminder.message), 0, delivered);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`[scheduler] Reminder '${reminder.id}' failed:`, msg);
        try {
          reminders.markError(reminder.id, msg);
        } catch (markErr) {
          this.logger.warn('[scheduler] Failed to mark reminder as errored:', markErr instanceof Error ? markErr.message : String(markErr));
        }
        this.logRun('reminder', 'error', msg, 0, false);
      }
    }
  }

  private insertReminderMessage(reminderId: string, text: string): void {
    if (!this.messagesDb) return;
    const nowMs = Date.now();
    this.messagesDb.prepare(`
      INSERT INTO messages (id, channel, channelName, user, userName, text, ts, receivedAt)
      VALUES (?, 'scheduler', 'reminders', 'assistant', ?, ?, ?, ?)
    `).run(`scheduler:reminder:${reminderId}`, this.config.forge.name, text, nowMs.toString(), nowMs);
  }

  private async executeJob(job: SchedulerJobConfig): Promise<void> {
    const started = Date.now();
    this.logger.log(`[scheduler] Running job '${job.name}'.`);
    try {
      const outcome = await this.chatTurn.runTurn({
        channel: 'scheduler',
        channelName: job.name,
        userName: 'scheduler',
        content: job.prompt,
        interfaceLabel: `Scheduled Job (${job.name})`,
        scopeHistoryToChannelName: true,
      });

      let delivered = false;
      if (job.channel !== 'none') {
        const deliver = this.deliveries[job.channel];
        if (!deliver) {
          throw new Error(`No delivery available for channel '${job.channel}' (is the bridge enabled?).`);
        }
        await deliver(job.chat_id, outcome.reply);
        delivered = true;
      }

      this.logRun(job.name, 'ok', preview(outcome.reply), Date.now() - started, delivered);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[scheduler] Job '${job.name}' failed:`, msg);
      this.logRun(job.name, 'error', msg, Date.now() - started, false);
    }
  }

  private logRun(jobName: string, status: 'ok' | 'error' | 'skipped', detail: string, durationMs: number, delivered: boolean): void {
    if (!this.db) return;
    try {
      this.db.prepare(`
        INSERT INTO scheduler_runs (job_name, status, detail, duration_ms, delivered)
        VALUES (?, ?, ?, ?, ?)
      `).run(jobName, status, detail, durationMs, delivered ? 1 : 0);
    } catch (err) {
      this.logger.warn('[scheduler] Failed to write run log:', err instanceof Error ? err.message : String(err));
    }
  }
}

function preview(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > DETAIL_PREVIEW_CHARS ? `${collapsed.slice(0, DETAIL_PREVIEW_CHARS)}…` : collapsed;
}
