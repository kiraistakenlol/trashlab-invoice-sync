// Drops and recreates the database named by DATABASE_URL and applies db/baseline.sql.
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { createLogger } from '../logger.js'

const log = createLogger('info')
const url = process.env.DATABASE_URL
if (!url) {
  log.fatal('DATABASE_URL is required')
  process.exit(1)
}

const target = new URL(url)
const name = decodeURIComponent(target.pathname.slice(1))
const quoted = `"${name.replaceAll('"', '""')}"`
const maintenance = new URL(url)
maintenance.pathname = '/postgres'

const admin = new pg.Client({ connectionString: maintenance.toString() })
await admin.connect()
try {
  await admin.query(`DROP DATABASE IF EXISTS ${quoted} WITH (FORCE)`)
  await admin.query(`CREATE DATABASE ${quoted}`)
} finally {
  await admin.end()
}

const db = new pg.Client({ connectionString: url })
await db.connect()
try {
  await db.query(readFileSync(new URL('../../db/baseline.sql', import.meta.url), 'utf8'))
} finally {
  await db.end()
}
log.info({ database: name }, 'database reset')
