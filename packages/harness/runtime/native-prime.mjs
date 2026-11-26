import { HarnessError } from '../errors.mjs'
import { estimateTokens } from '../context.mjs'
import { needsAgentLoop, specialistSummary } from '../profile.mjs'

// An operator selects saved teams by exact name. Keep this decision on the admitted turn.
export function useNativePrime(roster, mode) {
    if (mode !== 'agent' || !process.env.CUTTLELY_NATIVE_PRIME_TEAMS?.split(',').some((name) => name.trim() === roster.name)) return false
    for (const specialist of roster.specialists) {
        if (
            needsAgentLoop(specialist) ||
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
    const transcript = [...messages]
    let remaining = 8
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
            throw new HarnessError('context_limit', 'Native Prime exhausted its turn context.')
        const reply = await complete(transcript, tools)
        signal?.throwIfAborted()
        if (!reply.toolCalls.length) return reply.content
        if (reply.toolCalls.length > remaining) throw new HarnessError('delegation_limit', 'Native Prime reached its delegation limit.')
        remaining -= reply.toolCalls.length
        transcript.push({ role: 'assistant', content: reply.content, tool_calls: reply.toolCalls })
        for (const call of reply.toolCalls) {
            signal?.throwIfAborted()
            if (call.function.name !== 'run_specialist')
                throw new HarnessError('forbidden', 'The requested tool is not available to Prime.')
            let args
            try {
                args = JSON.parse(call.function.arguments)
            } catch {
                throw new HarnessError('bad_task', 'Invalid delegation arguments.')
            }
            const specialist = roster.specialists.find((s) => s.name === args?.name)
            if (!specialist) throw new HarnessError('forbidden', 'The requested specialist is not on this team.')
            if (typeof args.task !== 'string' || !args.task.trim()) throw new HarnessError('bad_task', 'A specialist task is required.')
            const content = await delegate(specialist, args.task)
            transcript.push({ role: 'tool', tool_call_id: call.id, content })
        }
    }
}
