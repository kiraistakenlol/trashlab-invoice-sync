// Starts Postgres in a container and builds the template database every test database clones.
import { readFileSync } from 'node:fs'
import { PostgreSqlContainer } from '@testcontainers/postgresql'
import pg from 'pg'
import type { TestProject } from 'vitest/node'
import { TEMPLATE_DB } from './provided.js'

const baseline = readFileSync(new URL('../../db/baseline.sql', import.meta.url), 'utf8')

export default async function setup(project: TestProject) {
  const container = await new PostgreSqlContainer('postgres:17-alpine').start()
  const adminUrl = container.getConnectionUri()

  const admin = new pg.Client({ connectionString: adminUrl })
  await admin.connect()
  await admin.query(`CREATE DATABASE ${TEMPLATE_DB}`)
  await admin.end()

  const templateUrl = new URL(adminUrl)
  templateUrl.pathname = `/${TEMPLATE_DB}`
  const template = new pg.Client({ connectionString: templateUrl.toString() })
  await template.connect()
  await template.query(baseline)
  // Cloning fails while any connection to the template is open.
  await template.end()

  project.provide('pgAdminUrl', adminUrl)
  return async () => {
    await container.stop()
  }
}
