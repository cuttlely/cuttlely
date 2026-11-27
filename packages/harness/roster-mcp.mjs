import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { hermesBaseUrl, hermesRunFailed } from './client.mjs'
import { executeAgentRun } from './runtime/agent-run.mjs'
import { profileDir } from './paths.mjs'
import { createMcpStdio } from './mcp-stdio.mjs'
import { rosterSpecialistBody } from './specialist-run.mjs'
import { agentRunTimeoutMs } from './budget.mjs'
import { specialistCapacityWaitSeconds } from './capacity-wait.mjs'
import { readProfileEnv } from './profile.mjs'
import { publicTask, redactSecrets } from './trace.mjs'
import { journalSession, journalTeam } from './roster-journal.mjs'
import { agentTurn, recordAgentStep } from './agent-run-context.mjs'

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

const stdio = createMcpStdio(
    (body) => {
        handle(body).catch((error) => {
            send(null, { content: [{ type: 'text', text: error.message }], isError: true })
        })
    },
    (packet) => fs.writeSync(1, packet)
)
const activeRequests = new Map()
let shuttingDown = false
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
    process.stdin.on('end', () => void shutdown())
    process.stdin.on('close', () => void shutdown())
    process.on('SIGTERM', () => void shutdown())
    process.on('SIGINT', () => void shutdown())
    process.stdin.on('data', (chunk) => {
        if (shuttingDown) return
        stdio.receive(chunk)
    })
}

async function shutdown() {
    if (shuttingDown) return
    shuttingDown = true
    const active = [...activeRequests.values()]
    for (const request of active) request.controller.abort()
    // stopRun has its own two-second HTTP deadline. Never keep a stopped parent waiting on cleanup.
    const timer = setTimeout(() => process.exit(0), 2500)
    await Promise.allSettled(active.map((request) => request.done))
    clearTimeout(timer)
    process.exit(0)
}

async function handle(body) {
    let message
    try {
        message = JSON.parse(body)
    } catch {
        return
    }
    if (message.method === 'notifications/cancelled') {
        activeRequests.get(message.params?.requestId)?.controller.abort()
        return
    }
    if (message.id === undefined || message.id === null || shuttingDown) return
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
        let finish
        const request = { controller: new AbortController(), done: new Promise((resolve) => (finish = resolve)) }
        activeRequests.set(message.id, request)
        try {
            const text = await runSpecialist(params.arguments || {}, request.controller.signal)
            return send(message.id, { content: [{ type: 'text', text }], isError: false })
        } catch (error) {
            return send(message.id, { content: [{ type: 'text', text: error.message }], isError: true })
        } finally {
            activeRequests.delete(message.id)
            finish()
        }
    }
    send(message.id, {})
}

async function journal(body, signal) {
    const env = readProfileEnv(harnessName)
    const target = new URL(env.OPENAI_BASE_URL)
    if (
        target.protocol !== 'http:' ||
        target.hostname !== '127.0.0.1' ||
        target.pathname !== '/v1' ||
        target.username ||
        target.password ||
        target.search ||
        target.hash ||
        !env.OPENAI_API_KEY ||
        !journalTeam(roster)
    )
        throw new Error('The agent turn is no longer active.')
    const response = await fetch(new URL('/harness/roster/journal', target), {
        method: 'POST',
        redirect: 'error',
        headers: { authorization: 'Bearer ' + env.OPENAI_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000)
    })
    if (!response.ok) throw new Error('The agent turn is no longer active.')
    return response.json()
}

async function runSpecialist(args, signal) {
    const name = String(args.name || '').trim()
    const task = String(args.task || '').trim()
    if (!name || !task) throw new Error('run_specialist needs a specialist name and a task.')
    const specialist = (roster?.specialists || []).find((item) => item.name === name)
    if (!specialist?.profileName) throw new Error(`Specialist "${name}" is not on this roster.`)
    // The runtime replaces this hidden argument with its own session id, even if the model supplied one.
    const sessionId = args._cuttlelyScope
    const remote = journalSession(sessionId)
    const turn = remote
        ? await journal({ phase: 'begin', name, task: publicTask(redactSecrets(task)), sessionId }, signal)
        : agentTurn(harnessName, sessionId)
    if (sessionId && !turn) throw new Error('The agent turn is no longer active.')
    const body = rosterSpecialistBody(specialist, task, turn?.turnId, roster?.chief, turn?.chatId)
    const step = { name, task, startedAt: Date.now(), status: 'running' }
    const slot = remote ? turn.slot : turn ? recordAgentStep(harnessName, sessionId, step) : undefined
    const timeoutMs = agentRunTimeoutMs()
    const capacityWaitSeconds = specialistCapacityWaitSeconds(specialist.capacityWaitSeconds)
    const startedAt = capacityWaitSeconds ? Date.now() : 0
    const baseUrl = hermesBaseUrl()
    try {
        const status = await executeAgentRun({
            request: { harnessName: specialist.profileName, baseUrl, timeoutMs, signal },
            body,
            capacityWaitSeconds,
            deadlineAt: capacityWaitSeconds && timeoutMs > 0 ? startedAt + timeoutMs : undefined,
            onCapacityWait: ({ attempt, delayMs }) =>
                console.error(`[harness] ${harnessName} ${name} waits for runtime capacity: admission retry ${attempt} in ${delayMs}ms`),
            onUnconfirmedStop: () => console.error(`[harness] Runtime stop was not confirmed for ${specialist.profileName}.`)
        })
        step.usage = status.usage
        if (hermesRunFailed(status.status)) {
            step.status = ['cancelled', 'interrupted'].includes(status.status) ? 'cancelled' : 'failed'
            throw new Error(status.error || status.message || `Specialist "${name}" failed.`)
        }
        const text = status.output || status.text || ''
        if (!text) throw new Error(`Specialist "${name}" returned an empty answer.`)
        step.status = 'completed'
        return text
    } catch (error) {
        step.error = error.message
        step.status = signal.aborted || error.name === 'AbortError' || step.status === 'cancelled' ? 'cancelled' : 'failed'
        throw error
    } finally {
        if (remote) {
            const usage = step.usage || {}
            await journal({
                phase: 'end',
                sessionId,
                name,
                slot,
                status: step.status,
                prompt: Number(usage.prompt_tokens ?? usage.input_tokens) || 0,
                completion: Number(usage.completion_tokens ?? usage.output_tokens) || 0
            })
        } else if (slot !== undefined) recordAgentStep(harnessName, sessionId, step, slot)
    }
}

function send(id, result) {
    if (shuttingDown) return
    try {
        stdio.send({ jsonrpc: '2.0', id, result })
    } catch (error) {
        if (error.code === 'EPIPE' || error.code === 'EBADF') void shutdown()
        else throw error
    }
}
