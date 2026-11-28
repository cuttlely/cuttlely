import { configureHarnessPostgres } from '../side-store-postgres.mjs'
import { appendTurn, closeSessions } from '../session.mjs'
import { closeQueueDb } from '../lock.mjs'

process.once('message', ({ connection, name, chat, receipt, question, answer }) => {
    configureHarnessPostgres(connection)
    process.once('message', () => {
        try {
            appendTurn(name, chat, question, answer, [], undefined, { recall: receipt })
        } finally {
            closeSessions()
            closeQueueDb()
            configureHarnessPostgres(null)
            process.disconnect()
        }
    })
    process.send('ready')
})
