import { modelCallTimeoutMs } from './budget.mjs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages'
import { freshNodeInstance, resolveInputs } from './bridge.mjs'
import { HarnessError } from './errors.mjs'
import { stableStringify } from './flow-graph.mjs'
import { repoRoot } from './paths.mjs'
import { fallbackToolChoice, rejectsToolCalls } from './tool-fallback.mjs'

const BLOCKED_MESSAGE =
    'points at a private or loopback address. Cuttlely blocks those by default so a flow cannot reach your internal network. Use a public endpoint.'
const JSON_NOTE = 'Reply with JSON only. Do not add prose or code fences.'
const secretCache = new WeakMap()

let readCredentialData = null

function credentialReader() {
    if (readCredentialData) return readCredentialData
    try {
        const require = createRequire(path.join(repoRoot(), 'packages', 'components', 'package.json'))
        const loaded = require('./dist/src/utils.js')
        readCredentialData = loaded.getCredentialData
    } catch {
        readCredentialData = async () => ({})
    }
    return readCredentialData
}

function bindingKey(binding) {
    if (binding?.nodeId) return `id:${binding.nodeId}`
    return stableStringify({
        nodeName: binding?.nodeName,
        inputs: binding?.inputs || {},
        credential: binding?.credential || binding?.credentialId || '',
        upstream: binding?.upstream || {}
    })
}

function isBlocked(error) {
    return /denied|deny list|not allowed/i.test(String(error?.message || error || ''))
}

function blockedError(label) {
    return new HarnessError('model_blocked', `${label} ${BLOCKED_MESSAGE}`)
}

function collectSecrets(value, found) {
    if (typeof value === 'string') {
        if (value.length >= 4) found.push(value)
        return
    }
    if (Array.isArray(value)) {
        for (const item of value) collectSecrets(item, found)
        return
    }
    if (value && typeof value === 'object') {
        for (const item of Object.values(value)) collectSecrets(item, found)
    }
}

async function secretsFor(resolved) {
    if (!resolved) return []
    if (secretCache.has(resolved)) return secretCache.get(resolved)
    const id = resolved.credential
    const options = resolved.flowOptions
    let secrets = []
    if (id && options?.appDataSource) {
        try {
            const data = await credentialReader()(id, options)
            const found = []
            collectSecrets(data, found)
            secrets = [...new Set(found)].sort((a, b) => b.length - a.length)
        } catch {
            secrets = []
        }
    }
    secretCache.set(resolved, secrets)
    return secrets
}

async function maskText(text, resolved) {
    let masked = String(text ?? '')
    for (const secret of await secretsFor(resolved)) masked = masked.split(secret).join('[key]')
    return masked
}

async function failModel(resolved, error) {
    if (error?.harnessError) throw error
    const label = resolved?.label || 'chat model'
    const nodeName = resolved?.nodeName || 'chat model'
    if (isBlocked(error)) throw blockedError(label)
    const masked = await maskText(error?.message || String(error), resolved)
    throw new HarnessError('model_failed', `${label} (${nodeName}) failed: ${masked}`)
}

// A chat model whose node declares a required credential must find that credential in the store.
// Without this, LangChain classes fall back to provider keys in the process env (O3, D15).
async function assertCredential(binding, ctx, label) {
    const definition =
        ctx?.componentNodes?.[binding.nodeName]?.credential || ctx?.flowOptions?.componentNodes?.[binding.nodeName]?.credential
    if (!definition || definition.optional) return
    const id = binding.credential || binding.credentialId || ''
    if (!id) {
        throw new HarnessError(
            'missing_credential',
            `The ${label} chat model needs a credential. Select one on that node and save the harness.`
        )
    }
    const options = ctx?.flowOptions
    const entity = options?.databaseEntities?.Credential
    if (!options?.appDataSource || !entity) return
    const row = await options.appDataSource.getRepository(entity).findOneBy({ id })
    if (!row) {
        throw new HarnessError(
            'missing_credential',
            `The credential selected on the ${label} chat model no longer exists. Select one on that node and save the harness.`
        )
    }
}

async function resolveModelOnce(binding, ctx) {
    const label = binding?.label || binding?.nodeName || 'chat model'
    const nodeName = binding?.nodeName
    if (!nodeName) {
        throw new HarnessError('bad_model', `${label} did not return a chat model, so a harness cannot use it.`)
    }
    const resolved = {
        chat: null,
        label,
        nodeName,
        toolCalling: false,
        credential: binding.credential || binding.credentialId || '',
        flowOptions: ctx?.flowOptions || {}
    }
    await assertCredential(binding, ctx, label)
    try {
        const instance = await freshNodeInstance(nodeName, ctx)
        const nodeData = await resolveInputs(binding, ctx, ctx?.nodeCache)
        const chat = typeof instance.init === 'function' ? await instance.init(nodeData, '', resolved.flowOptions) : undefined
        if (!chat || typeof chat.invoke !== 'function') {
            throw new HarnessError('bad_model', `${label} did not return a chat model, so a harness cannot use it.`)
        }
        resolved.chat = chat
        resolved.modelId = chat.modelName || chat.model || chat.modelId || nodeData.inputs?.modelName || nodeData.inputs?.model || 'unknown'
        resolved.toolCalling = typeof chat.bindTools === 'function'
        return resolved
    } catch (error) {
        if (error?.harnessError) throw error
        throw await failModel(resolved, error)
    }
}

// One promise per binding for the run that owns ctx.modelCache. Nothing is cached on this module.
export function resolveModel(binding, ctx = {}) {
    const cache = ctx.modelCache instanceof Map ? ctx.modelCache : null
    const key = bindingKey(binding)
    if (cache?.has(key)) return cache.get(key)
    const pending = resolveModelOnce(binding, ctx)
    if (cache) cache.set(key, pending)
    return pending
}

function messageText(content) {
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
        return content.map((part) => (typeof part === 'string' ? part : part?.text || part?.content || '')).join('')
    }
    if (content == null) return ''
    return String(content)
}

function toLangChain(messages) {
    return (messages || []).map((message) => {
        if (
            message instanceof SystemMessage ||
            message instanceof HumanMessage ||
            message instanceof AIMessage ||
            message instanceof ToolMessage
        ) {
            return message
        }
        const role = message?.role
        const content = messageText(message?.content)
        if (role === 'system') return new SystemMessage(content)
        if (role === 'assistant' || role === 'ai') {
            const calls = rawToolCalls(message)
            if (!calls.length) return new AIMessage(content)
            const responseItems = calls.filter((call) => call.response_item_id).map((call) => [call.id, call.response_item_id])
            return new AIMessage({
                content,
                ...(responseItems.length && { additional_kwargs: { __openai_function_call_ids__: Object.fromEntries(responseItems) } }),
                tool_calls: calls.map((call, index) => {
                    const shaped = toolCallOf(call, index)
                    let args = {}
                    try {
                        args = JSON.parse(shaped.function.arguments || '{}')
                    } catch {
                        args = {}
                    }
                    return { id: shaped.id, name: shaped.function.name, args, type: 'tool_call' }
                })
            })
        }
        if (role === 'tool') {
            return new ToolMessage({ content, tool_call_id: message.tool_call_id || message.id || 'tool' })
        }
        return new HumanMessage(userContent(content, message?.images))
    })
}

// A user message with images becomes text and image parts, the shape OpenAI-style chat models take.
export function userContent(text, images) {
    const urls = (Array.isArray(images) ? images : []).filter((url) => typeof url === 'string' && url)
    if (!urls.length) return text
    return [{ type: 'text', text }, ...urls.map((url) => ({ type: 'image_url', image_url: { url } }))]
}

function withJsonInstruction(messages) {
    const copy = (messages || []).map((message) => ({ ...message }))
    const system = copy.find((message) => message.role === 'system')
    if (system) system.content = `${messageText(system.content)}\n${JSON_NOTE}`
    else copy.unshift({ role: 'system', content: JSON_NOTE })
    return copy
}

function firstObject(text) {
    const start = text.indexOf('{')
    if (start === -1) return null
    let depth = 0
    let inString = false
    let escape = false
    for (let i = start; i < text.length; i += 1) {
        const ch = text[i]
        if (inString) {
            if (escape) escape = false
            else if (ch === '\\') escape = true
            else if (ch === '"') inString = false
            continue
        }
        if (ch === '"') inString = true
        else if (ch === '{') depth += 1
        else if (ch === '}') {
            depth -= 1
            if (depth === 0) return text.slice(start, i + 1)
        }
    }
    return null
}

function lenientJson(content) {
    const text = String(content ?? '')
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
    const slice = firstObject(text)
    if (!slice) return String(content ?? '')
    try {
        JSON.parse(slice)
        return slice
    } catch {
        return String(content ?? '')
    }
}

function rawToolCalls(result) {
    if (!result || typeof result !== 'object') return []
    if (Array.isArray(result.tool_calls) && result.tool_calls.length) return result.tool_calls
    const extra = result.additional_kwargs?.tool_calls
    return Array.isArray(extra) ? extra : []
}

function toolCallOf(call, index) {
    const id = call?.id || `call_${index}`
    if (call?.function?.name) {
        const args = call.function.arguments
        return {
            id,
            function: { name: String(call.function.name), arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) }
        }
    }
    const args = call?.args ?? call?.arguments
    return {
        id,
        function: { name: String(call?.name || ''), arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) }
    }
}

// Normalize a fresh provider batch before any call is dispatched. The assistant history and
// the tool results must use the same pairing IDs, including when the provider reuses one.
function providerToolCalls(result) {
    const calls = rawToolCalls(result)
    if (!calls.length) return []
    const seen = new Set()
    const nextSuffix = new Map()
    const itemIds = result.additional_kwargs?.__openai_function_call_ids__
    const mappedCalls = new Map()
    const batch = calls.map((call, index) => {
        const shaped = toolCallOf(call, index)
        const raw = typeof call?.id === 'string' ? call.id.trim() : ''
        const [wireId, item] = raw.split('|')
        const explicit = typeof call?.call_id === 'string' ? call.call_id.trim() : ''
        const fn = shaped.function
        const original =
            explicit ||
            wireId.trim() ||
            `call_${createHash('sha256').update(`${fn.name}:${fn.arguments}:${index}`).digest('hex').slice(0, 12)}`
        let id = original
        if (seen.has(id)) {
            let n = nextSuffix.get(original) || 2
            do {
                id = `${original}_d${n++}`
            } while (seen.has(id))
            nextSuffix.set(original, n)
        }
        seen.add(id)
        shaped.id = id
        const explicitItem = call?.response_item_id || item?.trim() || (explicit && raw.startsWith('fc_') && raw !== explicit && raw)
        if (typeof explicitItem === 'string' && explicitItem) shaped.response_item_id = explicitItem
        if (itemIds && Object.hasOwn(itemIds, original) && typeof itemIds[original] === 'string') {
            mappedCalls.set(original, mappedCalls.has(original) ? null : shaped)
        }
        return shaped
    })
    if (mappedCalls.size) {
        // LangChain indexes response items by the incoming call ID. A reused ID makes
        // that map ambiguous; only an explicit per-call item ID can disambiguate it.
        for (const [original, call] of mappedCalls) {
            if (call && !call.response_item_id) call.response_item_id = itemIds[original]
        }
    }
    return batch
}

// Prompt tokens the provider served from its prompt cache. They are part of the prompt count and cost less.
// OpenAI sends prompt_tokens_details.cached_tokens, LangChain input_token_details.cache_read, Hermes cache_read_tokens.
export function cachedPromptTokens(usage) {
    if (!usage || typeof usage !== 'object') return null
    const value =
        usage.prompt_tokens_details?.cached_tokens ??
        usage.input_token_details?.cache_read ??
        usage.input_tokens_details?.cached_tokens ??
        usage.cache_read_tokens ??
        usage.cache_read_input_tokens
    if (value == null) return null
    const count = Number(value)
    return Number.isFinite(count) && count >= 0 ? count : null
}

// The gateway and native runs share the released provider usage formats. Missing usage stays unknown.
export function openAiUsage(usage) {
    if (!usage || typeof usage !== 'object') return null
    const prompt = usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokens
    const completion = usage.completion_tokens ?? usage.output_tokens ?? usage.completionTokens
    if (prompt == null && completion == null) return null
    const prompt_tokens = Number(prompt) || 0
    const completion_tokens = Number(completion) || 0
    const cached = cachedPromptTokens(usage)
    return {
        prompt_tokens,
        completion_tokens,
        total_tokens: Number(usage.total_tokens ?? usage.totalTokens) || prompt_tokens + completion_tokens,
        ...(cached != null ? { prompt_tokens_details: { cached_tokens: cached } } : {})
    }
}

export function reportedUsage(result) {
    if (!result || typeof result !== 'object') return null
    const meta = result.usage_metadata
    if (meta && (meta.input_tokens != null || meta.output_tokens != null || meta.total_tokens != null)) {
        const prompt = meta.input_tokens ?? 0
        const completion = meta.output_tokens ?? 0
        const cached = cachedPromptTokens(meta)
        return {
            prompt_tokens: prompt,
            completion_tokens: completion,
            total_tokens: meta.total_tokens ?? prompt + completion,
            ...(cached != null ? { prompt_tokens_details: { cached_tokens: cached } } : {})
        }
    }
    const usage = result.response_metadata?.usage || result.usage
    if (usage && typeof usage === 'object' && !Array.isArray(usage)) return usage
    return null
}

function completionReason(result) {
    for (const metadata of [result?.response_metadata, result?.additional_kwargs, result?.generationInfo]) {
        const reason = metadata?.finish_reason ?? metadata?.stop_reason ?? metadata?.finishReason
        if (reason) return { finishReason: ['length', 'max_tokens', 'MAX_TOKENS'].includes(reason) ? 'length' : reason }
    }
    return {}
}

function chatResult(result, json) {
    if (typeof result === 'string') return { content: json ? lenientJson(result) : result, toolCalls: [], usage: null }
    const content = messageText(result?.content)
    return {
        content: json ? lenientJson(content) : content,
        toolCalls: providerToolCalls(result),
        usage: reportedUsage(result),
        ...completionReason(result)
    }
}

function callSignal(signal, limit) {
    const timeoutSignal = AbortSignal.timeout(limit)
    if (signal) return AbortSignal.any([signal, timeoutSignal])
    return timeoutSignal
}

function deliverText(onDelta, text) {
    if (typeof onDelta === 'function' && text) onDelta(text)
}

// Token deltas go out as the provider sends them. A chat model with no stream() still returns one reply.
async function streamChat(chat, messages, options, json, onDelta) {
    let iterable = chat.stream(toLangChain(messages), options)
    if (iterable && typeof iterable.then === 'function') iterable = await iterable
    let content = ''
    let combined = null
    for await (const chunk of iterable) {
        if (combined && typeof combined.concat === 'function') combined = combined.concat(chunk)
        else combined = chunk
        const piece = messageText(chunk?.content)
        if (!piece) continue
        content += piece
        onDelta(piece)
    }
    if (combined && typeof combined.concat === 'function') return chatResult(combined, json)
    return {
        content: json ? lenientJson(content) : content,
        toolCalls: providerToolCalls(combined),
        usage: reportedUsage(combined),
        ...completionReason(combined)
    }
}

async function bindTools(chat, tools, toolChoice) {
    const choice = toolChoice == null ? 'required' : toolChoice
    if (choice === 'none') return chat
    if (choice === 'auto') return chat.bindTools(tools)
    try {
        return await chat.bindTools(tools, { tool_choice: choice })
    } catch {
        return chat.bindTools(tools)
    }
}

// Providers using JSON choices may reject tool-role messages even when the request has no tools.
// Keep the original transcript for native providers. Encode only its call/result pairs for the text provider.
function textToolHistory(messages) {
    const history = []
    let results = []
    const flush = () => {
        if (!results.length) return
        history.push({ role: 'user', content: JSON.stringify({ tool_results: results }) })
        results = []
    }
    for (const message of messages) {
        if (message.role === 'tool') {
            results.push({ id: message.tool_call_id, result: message.content })
            continue
        }
        flush()
        const calls = message.role === 'assistant' && rawToolCalls(message)
        if (calls?.length) {
            const choices = calls.map((call, index) => {
                const { id, function: fn } = toolCallOf(call, index)
                return { id, tool: fn.name, arguments: fn.arguments }
            })
            history.push({ role: 'assistant', content: JSON.stringify({ text: message.content, tool_choices: choices }) })
        } else history.push(message)
    }
    flush()
    return history
}

function combineRetryUsage(first, next) {
    if (!first || !next) return first || next
    const prompt = Number(first.prompt_tokens ?? first.input_tokens ?? 0) + Number(next.prompt_tokens ?? next.input_tokens ?? 0)
    const completion =
        Number(first.completion_tokens ?? first.output_tokens ?? 0) + Number(next.completion_tokens ?? next.output_tokens ?? 0)
    const cached = [cachedPromptTokens(first), cachedPromptTokens(next)].filter((value) => value != null)
    return {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: prompt + completion,
        ...(cached.length && { prompt_tokens_details: { cached_tokens: cached.reduce((sum, n) => sum + n, 0) } })
    }
}

export async function invokeChat(
    resolved,
    { messages, tools, toolChoice, temperature, maxTokens, stop, json, signal, timeoutMs, onDelta, callbacks } = {}
) {
    const limit = Math.min(timeoutMs == null ? modelCallTimeoutMs() : timeoutMs, modelCallTimeoutMs())
    const prepared = json ? withJsonInstruction(messages) : messages || []
    try {
        const chat = resolved?.chat
        if (!chat || typeof chat.invoke !== 'function') {
            throw new HarnessError(
                'bad_model',
                `${resolved?.label || 'chat model'} did not return a chat model, so a harness cannot use it.`
            )
        }
        // A parent chat agent keeps its token counter on the async-local config. These calls are
        // route, specialist, and handoff. The tool records that payload once, so the counter must not
        // see them too. Only the tracer callbacks the Harness tool passes in (no token counter) are attached.
        const options = { signal: callSignal(signal, limit), timeout: limit, callbacks: callbacks ?? [] }
        if (temperature != null) options.temperature = temperature
        if (maxTokens != null) options.maxTokens = maxTokens
        if (stop != null) options.stop = stop
        const useFallback = async (retries) => {
            let usage = null
            const choice = await fallbackToolChoice(
                async (nextMessages) => {
                    const parsed = chatResult(await chat.invoke(toLangChain(nextMessages), options), false)
                    usage = combineRetryUsage(usage, openAiUsage(parsed.usage))
                    return parsed
                },
                textToolHistory(prepared),
                tools,
                { retries }
            )
            if (!choice.toolCalls.length) deliverText(onDelta, choice.content)
            return { ...choice, usage }
        }
        if (tools?.length && toolChoice !== 'none') {
            if (!resolved.toolCalling) return await useFallback(1)
            let bound = chat
            try {
                bound = await bindTools(chat, tools, toolChoice)
            } catch {
                return await useFallback(1)
            }
            try {
                const result = await bound.invoke(toLangChain(prepared), options)
                const parsed = chatResult(result, json)
                deliverText(onDelta, parsed.content)
                return parsed
            } catch (error) {
                if (!rejectsToolCalls(error)) throw error
                console.info(`[harness] ${resolved.label || 'chat model'} rejected tool calls; using JSON tool choice`)
                // The provider rejection is the one retry. Its reply is the answer when it is not a tool choice.
                return await useFallback(0)
            }
        }
        if (typeof onDelta === 'function' && typeof chat.stream === 'function') {
            return streamChat(chat, prepared, options, json, onDelta)
        }
        const result = await chat.invoke(toLangChain(prepared), options)
        const parsed = chatResult(result, json)
        deliverText(onDelta, parsed.content)
        return parsed
    } catch (error) {
        // The caller's abort (client disconnect or the turn budget) must stay an abort.
        if (signal?.aborted) throw error
        throw await failModel(resolved, error)
    }
}
