// A second gateway process has an independent PostgreSQL connection and queue transaction.
import { parentPort, workerData } from 'node:worker_threads'
import { configureHarnessPostgres } from '../../side-store-postgres.mjs'
import { closeQueueDb, database } from '../../lock.mjs'
import { updateBundledJournal } from '../../agent-run-context.mjs'

const { connection, chief, record, begin } = workerData
configureHarnessPostgres(connection)
database()
parentPort.postMessage('ready')
parentPort.once('message', () => {
    try {
        const { slot } = updateBundledJournal(chief, record, begin)
        updateBundledJournal(chief, record, {
            phase: 'end',
            name: begin.name,
            sessionId: begin.sessionId,
            slot,
            status: 'completed',
            prompt: 1,
            completion: 1
        })
        parentPort.postMessage(slot)
    } finally {
        closeQueueDb()
        configureHarnessPostgres(undefined)
    }
})
