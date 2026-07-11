import http from 'node:http';
import { Platform } from './platform.ts';
import { resolveWebAuthToken } from './config.ts';
import { createWebServer } from './web/server.ts';
import { TelegramAdapter } from './channels/telegram.ts';
import type { ChannelAdapter } from './channels/types.ts';
import { SchedulerService, type JobDelivery } from './services/scheduler/scheduler.ts';

async function main(): Promise<void> {
  const platform = await Platform.boot();
  let webServer: http.Server | null = null;
  const channelAdapters: ChannelAdapter[] = [];

  try {
    const auth = resolveWebAuthToken(platform.config, platform.resolved);
    if (auth.source === 'generated') {
      console.log(`\n[auth] Generated web auth token and saved it to ${auth.path}`);
      console.log(`[auth] Token: ${auth.token}\n`);
    } else if (auth.source === 'file') {
      console.log(`[auth] Loaded web auth token from ${auth.path}`);
    } else {
      console.log(`[auth] Loaded web auth token from ${auth.source}`);
    }

    const app = createWebServer({
      config: platform.config,
      dbManager: platform.dbManager,
      memory: platform.memory,
      llm: platform.llm,
      authToken: auth.token,
      identity: platform.identity,
      identityDir: platform.resolved.identity,
      identityFiles: platform.identityFiles,
      identityReflection: platform.identityReflection,
      agent: platform.agent,
      memoryCapture: platform.memoryCapture,
      conversationSummary: platform.conversationSummary,
      rag: platform.rag,
      voice: { stt: platform.stt, tts: platform.tts },
      readIdentity: () => platform.readIdentity(),
      resolved: platform.resolved,
    });

    const { host, port } = platform.config.services.web;
    webServer = await listen(app, host, port);

    const deliveries: Record<string, JobDelivery> = {};
    if (platform.config.channels?.telegram?.enabled === true) {
      const telegram = new TelegramAdapter({
        config: platform.config,
        handler: async (msg) => {
          const outcome = await platform.chatTurn.runTurn({
            channel: msg.channel,
            channelName: msg.chatId,
            userName: msg.userName,
            content: msg.text,
            llmContent: msg.llmText,
            attachmentsMeta: msg.attachmentsMeta,
            interfaceLabel: 'Telegram',
            scopeHistoryToChannelName: true,
          });
          return outcome.reply;
        },
      });
      await telegram.start();
      channelAdapters.push(telegram);
      deliveries.telegram = async (chatId, text) => {
        if (!chatId) throw new Error('Telegram delivery requires a chat_id.');
        await telegram.sendMessage(chatId, text);
      };
    }

    const scheduler = new SchedulerService({
      config: platform.config,
      chatTurn: platform.chatTurn,
      deliveries,
      db: platform.dbManager.get('tools'),
      reminders: platform.reminders,
      messagesDb: platform.dbManager.get('messages'),
    });
    scheduler.start();
    platform.maintenance.start();

    const shutdown = () => {
      platform.maintenance.stop();
      scheduler.stop();
      for (const adapter of channelAdapters) void adapter.stop();
      webServer?.close();
      platform.shutdown();
      process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    console.log('\n[forge] Ready');
  } catch (err) {
    platform.maintenance.stop();
    for (const adapter of channelAdapters) void adapter.stop();
    webServer?.close();
    platform.shutdown();
    throw err;
  }
}

function listen(app: http.RequestListener, host: string, port: number): Promise<http.Server> {
  const server = http.createServer(app);

  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      reject(new Error(formatListenError(err, host, port)));
    };
    const onListening = () => {
      server.off('error', onError);
      server.on('error', err => {
        console.error('[web] Server error:', err);
      });
      console.log(`[web] Server listening on http://${host}:${port}`);
      resolve(server);
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function formatListenError(err: NodeJS.ErrnoException, host: string, port: number): string {
  if (err.code === 'EADDRINUSE') {
    return `[web] ${host}:${port} is already in use. Set services.web.port in forge.config.yaml or stop the other process.`;
  }
  if (err.code === 'EACCES') {
    return `[web] Permission denied while binding ${host}:${port}. Choose a different services.web.port.`;
  }
  return `[web] Failed to listen on ${host}:${port}: ${err.message}`;
}

main().catch(err => {
  console.error('[forge] Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
