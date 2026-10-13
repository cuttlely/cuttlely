import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRun, hermesBaseUrl, waitForRun } from './client.mjs'
import { profileDir } from './paths.mjs'
import { rosterSpecialistBody } from './specialist-run.mjs'

const harnessName = flag('--harness')
const roster = readRoster(harnessName)

// The profile directory run_specialist would launch for this specialist, or '' when it is not on that roster.
export function specialistLaunch(harnessArg, specialistName) {
    const found = readRoster(harnessArg)
    const specialist = (found?.specialists || []).find((item) => item.name === specialistName)
    return specialist?.profileName || ''
}

function flag(name) {
    const index = process.argv.indexOf(name)
    return index === -1 ? '' : process.argv[index + 1] || ''
}

function readRoster(name) {
    if (!name) return null
    const file = path.join(profileDir(name), 'harness-roster.json')
    if (!fs.existsSync(file)) return null
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
        return null
    }
}

const tools = [
    {
        name: 'run_specialist',
        description: 'Run one specialist on this harness. Pass the specialist name and the task.',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string' },
                task: { type: 'string' }
            },
            required: ['name', 'task']
        }
    }
]

let buffer = Buffer.alloc(0)
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain)
    process.stdin.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        while (true) {
            const headerEnd = buffer.indexOf('\r\n\r\n')
            if (headerEnd === -1) return
            const header = buffer.slice(0, headerEnd).toString('utf8')
            const match = header.match(/Content-Length:\s*(\d+)/i)
            if (!match) {
                buffer = buffer.slice(headerEnd + 4)
                continue
            }
            const length = Number(match[1])
            const start = headerEnd + 4
            if (buffer.length < start + length) return
            const body = buffer.slice(start, start + length).toString('utf8')
            buffer = buffer.slice(start + length)
            handle(body).catch((error) => {
                send(null, { content: [{ type: 'text', text: error.message }], isError: true })
            })
        }
    })

async function handle(body) {
    let message
    try {
        message = JSON.parse(body)
    } catch {
        return
    }
    if (!message.id && message.method) return
    if (message.method === 'initialize') {
        return send(message.id, {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: `cuttlely-${harnessName}-roster`, version: '1.0.0' }
        })
    }
    if (message.method === 'tools/list') return send(message.id, { tools })
    if (message.method === 'tools/call') {
        const params = message.params || {}
        if (params.name !== 'run_specialist') {
            return send(message.id, { content: [{ type: 'text', text: `Unknown tool ${params.name}` }], isError: true })
        }
        try {
            const text = await runSpecialist(params.arguments || {})
            return send(message.id, { content: [{ type: 'text', text }], isError: false })
        } catch (error) {
            return send(message.id, { content: [{ type: 'text', text: error.message }], isError: true })
        }
    }
    if (message.id) send(message.id, {})
}

async function runSpecialist(args) {
    const name = String(args.name || '').trim()
    const task = String(args.task || '').trim()
    if (!name || !task) throw new Error('run_specialist needs a specialist name and a task.')
    const specialist = (roster?.specialists || []).find((item) => item.name === name)
    if (!specialist?.profileName) throw new Error(`Specialist "${name}" is not on this roster.`)
    const body = rosterSpecialistBody(specialist, task)
    const created = await createRun({
        harnessName: specialist.profileName,
        body,
        baseUrl: hermesBaseUrl(),
        timeoutMs: 90000
    })
    const status =
        created.output || created.error
            ? created
            : await waitForRun({
                  harnessName: specialist.profileName,
                  runId: created.run_id,
                  timeoutMs: 90000
              })
    if (status.status === 'failed' || status.status === 'error') {
        throw new Error(status.error || status.message || `Specialist "${name}" failed.`)
    }
    const text = status.output || status.text || ''
    if (!text) throw new Error(`Specialist "${name}" returned an empty answer.`)
    return text
}

function send(id, result) {
    const payload = JSON.stringify({ jsonrpc: '2.0', id, result })
    const packet = `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`
    fs.writeSync(1, packet)
}
