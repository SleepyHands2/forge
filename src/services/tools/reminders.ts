import { z } from 'zod';
import type { ForgeConfig, ToolDef } from '../../types.ts';
import type { ReminderService } from '../scheduler/reminders.ts';

const MAX_IN_MINUTES = 40_320; // 28 days

export interface ReminderToolDeps {
  config: ForgeConfig;
  reminders: ReminderService;
}

/**
 * One-shot reminder tools. set_reminder and cancel_reminder are 'sensitive'
 * (they schedule/unschedule future unattended output); list_reminders is a
 * read-only 'safe' view. The scheduler tick delivers due reminders into the
 * chat feed and, when the Telegram bridge is configured, to the first
 * allowlisted chat.
 *
 * Cross-field validation (exactly one of at/in_minutes) happens in the
 * handler: the model-facing schema converter supports only flat optional
 * fields, not object-level refinements.
 */
export function createReminderTools(deps: ReminderToolDeps): ToolDef[] {
  return [
    createSetReminderTool(deps),
    createListRemindersTool(deps),
    createCancelReminderTool(deps),
  ];
}

function createSetReminderTool(deps: ReminderToolDeps): ToolDef {
  return {
    name: 'set_reminder',
    description: 'Set a one-shot reminder delivered at a future time. Provide exactly one of `at` (ISO 8601 date-time, local time acceptable) or `in_minutes`.',
    permission: 'sensitive',
    params: z.object({
      message: z.string().min(1).describe('The reminder text to deliver'),
      at: z.string().optional().describe('When to deliver, as an ISO 8601 date-time (local time acceptable, e.g. 2026-07-08T09:00)'),
      in_minutes: z.number().int().min(1).max(MAX_IN_MINUTES).optional().describe('Deliver this many minutes from now'),
    }),
    handler: async (args) => {
      const hasAt = typeof args.at === 'string' && args.at.trim() !== '';
      const hasInMinutes = args.in_minutes !== undefined && args.in_minutes !== null;
      if (hasAt === hasInMinutes) {
        throw new Error("Provide exactly one of 'at' (ISO 8601 date-time) or 'in_minutes'.");
      }

      let dueAtMs: number;
      if (hasAt) {
        const at = String(args.at).trim();
        dueAtMs = new Date(at).getTime();
        if (Number.isNaN(dueAtMs)) {
          throw new Error(`'${at}' is not a valid ISO 8601 date-time.`);
        }
        if (dueAtMs <= Date.now()) {
          throw new Error(`'${at}' parsed to ${new Date(dueAtMs).toString()}, which is in the past.`);
        }
      } else {
        dueAtMs = Date.now() + Number(args.in_minutes) * 60_000;
      }

      const created = deps.reminders.create({ message: String(args.message), dueAtMs });
      return {
        id: created.id,
        message: created.message,
        due_at: new Date(created.dueAtMs).toString(),
        delivery: telegramConfigured(deps.config) ? 'telegram + web feed' : 'web feed',
      };
    },
  };
}

function createListRemindersTool(deps: ReminderToolDeps): ToolDef {
  return {
    name: 'list_reminders',
    description: 'List all pending reminders with their delivery times.',
    permission: 'safe',
    params: z.object({}),
    handler: async () => ({
      reminders: deps.reminders.listPending().map(reminder => ({
        id: reminder.id,
        message: reminder.message,
        due_at: new Date(reminder.dueAtMs).toString(),
        status: 'pending' as const,
      })),
    }),
  };
}

function createCancelReminderTool(deps: ReminderToolDeps): ToolDef {
  return {
    name: 'cancel_reminder',
    description: 'Cancel a pending reminder by its id (see list_reminders).',
    permission: 'sensitive',
    params: z.object({
      id: z.string().min(1).describe('The reminder id to cancel'),
    }),
    handler: async (args) => {
      const id = String(args.id);
      if (!deps.reminders.cancel(id)) {
        throw new Error('No pending reminder with that id.');
      }
      return { id, cancelled: true };
    },
  };
}

function telegramConfigured(config: ForgeConfig): boolean {
  const telegram = config.channels?.telegram;
  return telegram?.enabled === true && (telegram.allowed_chat_ids ?? []).length > 0;
}
