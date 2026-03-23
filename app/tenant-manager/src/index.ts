/**
 * Tenant Manager Service Entry Point
 */

import 'dotenv/config'
import { buildApp } from './app.js'
import { getEnv } from './config/index.js'
import { closeAllPools } from './db/connection.js'
import { closeAllInstancePools } from './db/instance-connection.js'
import { stopPeriodicCollection } from './modules/metrics/metrics.service.js'

async function main() {
  try {
    // Validate environment variables first
    const env = getEnv()

    // Build and start the application
    const app = await buildApp()

    await app.listen({
      port: env.PORT,
      host: '0.0.0.0',
    })

    app.log.info(`Tenant Manager Service running on port ${env.PORT}`)
    app.log.info(`API documentation available at http://localhost:${env.PORT}/docs`)

    // Graceful shutdown
    const signals = ['SIGINT', 'SIGTERM']
    for (const signal of signals) {
      process.on(signal, async () => {
        app.log.info(`Received ${signal}, closing server...`)
        stopPeriodicCollection()
        await app.close()
        await closeAllPools()
        await closeAllInstancePools()
        process.exit(0)
      })
    }
  } catch (error) {
    console.error('Failed to start server:', error)
    await closeAllPools()
    await closeAllInstancePools()
    process.exit(1)
  }
}

main()
