'use strict'

// Stand-in chat model for the docs capture. Answers are made up. No provider is called and no key is read.

const { AIMessage } = require('@langchain/core/messages')

function askedText(messages) {
    const parts = []
    const walk = (value, depth) => {
        if (value == null || depth > 6) return
        if (typeof value === 'string') return void parts.push(value)
        if (Array.isArray(value)) return void value.forEach((item) => walk(item, depth + 1))
        if (typeof value === 'object') {
            if ('content' in value) walk(value.content, depth + 1)
            if (typeof value.text === 'string') parts.push(value.text)
            if (value.kwargs) walk(value.kwargs.content, depth + 1)
        }
    }
    walk(messages, 0)
    return parts.join('\n')
}

function catalogPath() {
    return process.env.DOCS_SHOT_CATALOG || ''
}

function etlPlan() {
    const catalog = catalogPath()
    return {
        title: 'Outdoor Product Catalog ETL',
        nodes: [
            {
                id: 'splitter',
                name: 'recursiveCharacterTextSplitter',
                label: 'Recursive Character Text Splitter',
                inputs: { chunkSize: 1000, chunkOverlap: 200 }
            },
            {
                id: 'source',
                name: 'etlFileSource',
                label: 'Streaming Files',
                inputs: {
                    paths: catalog,
                    format: 'csv',
                    idColumn: 'sku',
                    textColumns: 'name, category, description',
                    metadataColumns: 'sku, category'
                }
            },
            {
                id: 'clean',
                name: 'etlTransform',
                label: 'Clean & Transform',
                inputs: { minChars: 1 }
            },
            {
                id: 'store',
                name: 'etlLocalVectorStore',
                label: 'Local Vector Store',
                inputs: { collection: 'outdoor-catalog' }
            },
            {
                id: 'embed',
                name: 'localHashEmbeddings',
                label: 'Local Hash Embeddings',
                inputs: { dimensions: 384 }
            }
        ],
        edges: [
            { from: 'splitter', to: 'source', input: 'textSplitter' },
            { from: 'source', to: 'clean', input: 'document' },
            { from: 'clean', to: 'store', input: 'document' },
            { from: 'embed', to: 'store', input: 'embeddings' }
        ],
        starterQuestions: [
            'What are the best products for hiking?',
            'Show me camping gear with good reviews.',
            'Which products are suitable for outdoor cooking?'
        ]
    }
}

function toolNameFrom(text) {
    const match = /Call the ([A-Za-z0-9_]+) tool/.exec(text)
    return match ? match[1] : 'search_outdoor_catalog'
}

function lastQuestion(text) {
    const lines = text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    return lines[lines.length - 1] || 'tent for alpine starts'
}

function bakeryReply(text) {
    const lines = text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    const question = lines[lines.length - 1] || ''
    const saturday = /saturday/i.test(question)
    const gluten = /gluten/i.test(question)
    const early = text.includes('7 AM')
    const daily = text.includes('every day')
    if (saturday) {
        return {
            text: early ? 'We open at 7 AM on Saturdays.' : 'We open at 8 AM on Saturdays.',
            prompt: early ? 40 : 41,
            completion: 28,
            wait: early ? 350 : 600
        }
    }
    if (gluten) {
        return {
            text: daily ? 'Yes, we bake gluten-free bread fresh every day.' : 'Yes, gluten-free bread is baked fresh on Tuesdays only.',
            prompt: daily ? 40 : 42,
            completion: 30,
            wait: daily ? 200 : 450
        }
    }
    return {
        text: 'The bakery counter can help with that.',
        prompt: 12,
        completion: 8,
        wait: 50
    }
}

function result(content, usage, toolCall) {
    const message = new AIMessage({
        content,
        usage_metadata: {
            input_tokens: usage.prompt,
            output_tokens: usage.completion,
            total_tokens: usage.prompt + usage.completion
        },
        response_metadata: { model_name: 'claude' },
        ...(toolCall
            ? {
                  tool_calls: [
                      {
                          id: 'call_docs_shot',
                          name: toolCall.name,
                          args: toolCall.args,
                          type: 'tool_call'
                      }
                  ]
              }
            : {})
    })
    return {
        generations: [{ text: content, message }],
        llmOutput: {
            model: 'claude',
            tokenUsage: {
                promptTokens: usage.prompt,
                completionTokens: usage.completion,
                totalTokens: usage.prompt + usage.completion
            }
        }
    }
}

async function replyFor(messages) {
    const text = askedText(messages)
    if (text.includes('You build a Cuttlely etl')) {
        return result(JSON.stringify(etlPlan()), { prompt: 20, completion: 40 })
    }
    if (text.includes('Call the') && text.includes('tool once')) {
        const name = toolNameFrom(text)
        const query = lastQuestion(text)
        return result('', { prompt: 24, completion: 8 }, { name, args: { input: query } })
    }
    const bakery = bakeryReply(text)
    if (bakery.wait) await new Promise((resolve) => setTimeout(resolve, bakery.wait))
    return result(bakery.text, bakery)
}

function patchChat(exported) {
    if (!exported || exported.__docsShot) return
    const ChatOpenAI = exported.ChatOpenAI || (exported.default && exported.default.ChatOpenAI)
    if (!ChatOpenAI || ChatOpenAI.prototype.__docsShot) return
    ChatOpenAI.prototype.__docsShot = true
    exported.__docsShot = true
    ChatOpenAI.prototype._generate = async function docsGenerate(messages) {
        return replyFor(messages)
    }
    ChatOpenAI.prototype._streamResponseChunks = async function* docsStream(messages) {
        const generated = await replyFor(messages)
        const message = generated.generations[0].message
        yield { text: generated.generations[0].text, message }
    }
}

const Module = require('module')
const originalLoad = Module._load
Module._load = function docsShotLoad(request, parent, isMain) {
    const exported = originalLoad.apply(this, arguments)
    if (typeof request === 'string' && request.includes('@langchain/openai')) patchChat(exported)
    return exported
}
