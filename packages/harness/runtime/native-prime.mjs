import { HarnessError } from '../errors.mjs'
import { estimateTokens } from '../context.mjs'
import { needsAgentLoop, specialistSummary } from '../profile.mjs'

// Only the queue can supply a recorded selection. API and canvas JSON cannot set a symbol.
export const admittedAgentEngine = Symbol('admittedAgentEngine')

export function selectAgentEngine(name) {
    return process.env.CUTTLELY_NATIVE_PRIME_TEAMS?.split(',').some((entry) => entry.trim() && entry.trim() === name) ? 'native' : 'hermes'
}

export function useNativePrime(roster, mode, engine = selectAgentEngine(roster.name)) {
    if (mode !== 'agent' || engine === 'hermes') return false
    if (engine !== 'native') throw new HarnessError('bad_engine', 'The admitted agent engine is unavailable.')
    for (const specialist of roster.specialists) {
        if (
            needsAgentLoop({ ...specialist, playbooks: [] }) ||
            specialist.modules?.some(
                (binding) =>
                    binding.nodeName !== 'calculator' ||
                    Object.keys(binding.upstream || {}).length ||
                    Object.keys(binding.inputs || {}).length
            ) ||
            specialist.trustedOutputs?.length
        ) {
            throw new HarnessError('native_unsupported', `Native Prime cannot yet run the capabilities of specialist "${specialist.name}".`)
        }
    }
    return true
}

export function nativePrimeInstructions(roster) {
    return [
        `You are Harness Prime for "${roster.name}". Delegate with run_specialist when needed. Use the specialist's returned evidence.`,
        roster.chief.instructions,
        ...roster.specialists.map((s) => `${s.name}: ${specialistSummary(s)}`)
    ]
        .filter(Boolean)
        .join('\n')
}

export async function runNativePrime({ messages, roster, complete, delegate, signal, budget }) {
    const tools = [
        {
            type: 'function',
            function: {
                name: 'run_specialist',
                description: 'Ask one specialist on this team to perform a task and return its result.',
                parameters: {
                    type: 'object',
                    properties: { name: { type: 'string', enum: roster.specialists.map((s) => s.name) }, task: { type: 'string' } },
                    required: ['name', 'task'],
                    additionalProperties: false
                }
            }
        }
    ]
    return runNativeToolLoop({
        messages,
        tools,
        complete,
        signal,
        budget,
        maxCalls: 8,
        limitCode: 'delegation_limit',
        execute: (_name, args) => {
            const specialist = roster.specialists.find((s) => s.name === args?.name)
            if (!specialist) throw new HarnessError('forbidden', 'The requested specialist is not on this team.')
            if (typeof args.task !== 'string' || !args.task.trim()) throw new HarnessError('bad_task', 'A specialist task is required.')
            return delegate(specialist, args.task)
        }
    })
}

export async function runNativeToolLoop({ messages, tools, complete, execute, signal, budget, maxCalls, limitCode }) {
    const transcript = [...messages]
    const allowed = new Set(tools.map((tool) => tool.function.name))
    let remaining = maxCalls
    for (;;) {
        signal?.throwIfAborted()
        if (
            budget &&
            transcript.reduce(
                (total, message) =>
                    total + estimateTokens(message.content) + (message.tool_calls ? estimateTokens(JSON.stringify(message.tool_calls)) : 0),
                0
            ) > budget
        )
            throw new HarnessError('context_limit', 'The native agent exhausted its turn context.')
        const reply = await complete(transcript, tools)
        signal?.throwIfAborted()
        if (!reply.toolCalls.length) return reply.content
        if (reply.toolCalls.length > remaining) throw new HarnessError(limitCode, 'The native agent reached its tool call limit.')
        remaining -= reply.toolCalls.length
        const calls = reply.toolCalls.map((call) => {
            if (!allowed.has(call.function?.name)) throw new HarnessError('forbidden', 'The requested tool is unavailable to this agent.')
            let args
            try {
                args = JSON.parse(call.function.arguments)
            } catch {
                throw new HarnessError('bad_task', 'Invalid tool arguments.')
            }
            if (!args || typeof args !== 'object' || Array.isArray(args))
                throw new HarnessError('bad_task', 'Expected tool arguments as an object.')
            return { name: call.function.name, id: call.id, args }
        })
        transcript.push({ role: 'assistant', content: reply.content, tool_calls: reply.toolCalls })
        for (const call of calls) {
            signal?.throwIfAborted()
            const content = await execute(call.name, call.args)
            transcript.push({ role: 'tool', tool_call_id: call.id, content })
        }
    }
}
