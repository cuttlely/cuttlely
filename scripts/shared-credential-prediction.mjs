// Boots the built server and runs one chatflow prediction whose model credential
// is owned by another team and shared into this one. The chat model is the
// in-process stand-in from smoke-fake-model.cjs. No provider key and no network.
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { freePort, request, setupCodeFromLogs, smokeFlow, startServer, waitForPing } from './smoke-server.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = path.join(ROOT, 'packages', 'server')
const { AES } = createRequire(path.join(ROOT, 'packages', 'components', 'package.json'))('crypto-js')

const EMAIL = 'shared-cred@example.com'
const PASSWORD = 'SharedCred1!'

function insertSharedCredential(dataDir) {
    const key = fs.readFileSync(path.join(dataDir, 'encryption.key'), 'utf8')
    const encrypted = AES.encrypt(JSON.stringify({ openAIApiKey: 'shared-local-placeholder' }), key).toString()
    const db = new DatabaseSync(path.join(dataDir, 'database.sqlite'), { timeout: 15000 })
    try {
        const home = db.prepare('SELECT id, "organizationId" AS organizationId, "createdBy" AS createdBy FROM workspace LIMIT 1').get()
        if (!home) throw new Error('the server has no workspace yet')
        const workspaceB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
        const credentialId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
        const shareId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
        db.prepare(
            `INSERT INTO workspace (id, name, "organizationId", "createdBy", "updatedBy", "createdDate", "updatedDate") VALUES (?, 'Other team', ?, ?, ?, datetime('now'), datetime('now'))`
        ).run(workspaceB, home.organizationId, home.createdBy, home.createdBy)
        db.prepare(
            `INSERT INTO credential (id, name, "credentialName", "encryptedData", "workspaceId", "createdDate", "updatedDate") VALUES (?, 'Shared key', 'openAIApi', ?, ?, datetime('now'), datetime('now'))`
        ).run(credentialId, encrypted, workspaceB)
        db.prepare(
            `INSERT INTO workspace_shared (id, "workspaceId", "sharedItemId", "itemType", "createdDate", "updatedDate") VALUES (?, ?, ?, 'credential', datetime('now'), datetime('now'))`
        ).run(shareId, home.id, credentialId)
        return credentialId
    } finally {
        db.close()
    }
}

async function main() {
    if (!fs.existsSync(path.join(SERVER, 'dist', 'commands'))) {
        throw new Error('packages/server/dist is missing. Build the server before this check.')
    }
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-shared-cred-'))
    const port = await freePort()
    const base = `http://127.0.0.1:${port}`
    const { child, logs, stop } = startServer(dataDir, port, { CUTTLELY_LOCAL_ADMIN: 'true' })
    try {
        console.log(`shared-credential server ${base}`)
        await waitForPing(base, child, logs)
        const setupCode = setupCodeFromLogs(logs)
        if (!setupCode) throw new Error('the server log had no setup code')
        const registered = await request(`${base}/api/v1/account/register`, {
            method: 'POST',
            body: { user: { name: 'Shared', email: EMAIL, credential: PASSWORD }, setupCode }
        })
        if (registered.status !== 200) throw new Error(`register ${registered.status}: ${registered.text.slice(0, 400)}`)
        const loggedIn = await request(`${base}/api/v1/auth/login`, {
            method: 'POST',
            body: { email: EMAIL, password: PASSWORD }
        })
        if (loggedIn.status !== 200 || !loggedIn.cookie) {
            throw new Error(`login ${loggedIn.status}: ${loggedIn.text.slice(0, 400)}`)
        }
        const credentialId = insertSharedCredential(dataDir)
        const chatflow = await request(`${base}/api/v1/chatflows`, {
            method: 'POST',
            cookie: loggedIn.cookie,
            body: {
                name: 'shared-key',
                type: 'CHATFLOW',
                deployed: false,
                isPublic: false,
                flowData: JSON.stringify(smokeFlow(credentialId))
            }
        })
        if (chatflow.status !== 200 && chatflow.status !== 201) {
            throw new Error(`chatflow ${chatflow.status}: ${chatflow.text.slice(0, 500)}`)
        }
        const chatflowId = JSON.parse(chatflow.text).id
        const prediction = await request(`${base}/api/v1/prediction/${chatflowId}`, {
            method: 'POST',
            cookie: loggedIn.cookie,
            timeoutMs: 180000,
            body: { question: 'Say smoke-ok', streaming: false }
        })
        if (prediction.status !== 200 || !prediction.text.includes('smoke-ok')) {
            throw new Error(`prediction ${prediction.status}: ${prediction.text.slice(0, 800)}`)
        }
        console.log(`shared credential prediction ok ${chatflowId}`)
    } finally {
        stop()
        fs.rmSync(dataDir, { recursive: true, force: true })
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
})
