import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { HarnessError } from './errors.mjs'

let pathOverride = null

export function setFlowiseCredentialPaths(paths) {
    pathOverride = paths || null
}

function appHome() {
    return process.env.SECRETKEY_PATH || path.join(os.homedir(), '.cuttlely')
}

function databasePath() {
    if (pathOverride?.database) return pathOverride.database
    if (process.env.CUTTLELY_FLOWISE_DB) return process.env.CUTTLELY_FLOWISE_DB
    return path.join(appHome(), 'database.sqlite')
}

export function readCredentialRow(credentialId) {
    const file = databasePath()
    if (!fs.existsSync(file)) {
        throw new HarnessError('bad_credential', 'Credential store was not found.')
    }
    const db = new DatabaseSync(file, { readOnly: true })
    try {
        return db.prepare('SELECT id, credentialName, encryptedData FROM credential WHERE id = ?').get(credentialId) || null
    } finally {
        db.close()
    }
}

export function credentialStamp(credentialIds) {
    const ids = [...new Set((credentialIds || []).map((id) => String(id || '').trim()).filter(Boolean))].sort()
    if (!ids.length) return ''
    const file = databasePath()
    if (!fs.existsSync(file)) return ''
    const db = new DatabaseSync(file, { readOnly: true })
    try {
        const rows = db.prepare(`SELECT id, updatedDate FROM credential WHERE id IN (${ids.map(() => '?').join(', ')})`).all(...ids)
        return ids.map((id) => `${id}@${rows.find((row) => row.id === id)?.updatedDate ?? 'missing'}`).join(',')
    } finally {
        db.close()
    }
}

export { flowiseNodeOptions } from './offline-options.mjs'
