import { loadConfig } from './config.js';
import { initBridgeContext } from './context.js';
import { CoreClientImpl } from './core-client.js';
import { Logger } from './logger.js';
import { join } from 'node:path';
import { homedir } from 'node:os';

async function main() {
  const config = loadConfig();

  const logDir = join(homedir(), '.termlive', 'logs');
  const logger = new Logger(
    join(logDir, 'bridge.log'),
    [config.token, config.telegram.botToken, config.discord.botToken, config.feishu.appSecret].filter(Boolean)
  );

  logger.info('TermLive Bridge starting...');
  logger.info(`Core URL: ${config.coreUrl}`);
  logger.info(`Enabled channels: ${config.enabledChannels.join(', ') || 'none'}`);

  // Initialize Core Client
  const core = new CoreClientImpl(config.coreUrl, config.token);

  try {
    await core.connect();
    logger.info('Connected to Go Core');
  } catch (err) {
    logger.error(`Failed to connect to Go Core: ${err}`);
    logger.warn('Running in degraded mode (no Core connection)');
  }

  // Initialize context (LLM and permissions will be added in P2/P4)
  initBridgeContext({
    store: {} as any,       // P2: JsonFileStore
    llm: {} as any,         // P2: Claude SDK provider
    permissions: {} as any, // P4: Permission gateway
    core: core as any,
  });

  logger.info('Bridge initialized');

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    await core.disconnect();
    logger.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep process alive
  setInterval(() => {}, 60_000);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
