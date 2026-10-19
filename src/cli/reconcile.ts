// Queues a job for every record on both sides; the running service works them off.
import { loadConfig } from '../config.js'
import { createLogger } from '../logger.js'
import { createContext } from '../service.js'
import { enqueueAll } from '../sync/reconcile-all.js'

const config = loadConfig(process.env)
const log = createLogger(config.logLevel)
const ctx = createContext(config, log)
try {
  const counts = await enqueueAll(ctx)
  log.info(counts, 'jobs queued; the running service will work them off')
} catch (err) {
  log.fatal({ err }, 'initial reconciliation failed')
  process.exitCode = 1
} finally {
  await ctx.db.destroy()
}
