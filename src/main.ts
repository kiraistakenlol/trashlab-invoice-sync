// Entry point: runs the sync service until SIGINT or SIGTERM.
import { loadConfig } from './config.js'
import { createLogger } from './logger.js'
import { createService } from './service.js'

const config = loadConfig(process.env)
const log = createLogger(config.logLevel)
const service = createService(config, log)

let stopping = false
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return
  stopping = true
  log.info({ signal }, 'sync service stopping')
  try {
    await service.stop()
  } catch (err) {
    log.error({ err }, 'sync service stop failed')
    process.exitCode = 1
  }
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

try {
  await service.start()
} catch (err) {
  log.fatal({ err }, 'sync service failed to start')
  await service.stop().catch(() => undefined)
  process.exit(1)
}
