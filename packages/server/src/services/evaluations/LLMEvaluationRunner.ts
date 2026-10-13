import { convertSchemaToZod, ICommonObject } from '@cuttlely/components'
import { z } from 'zod/v3'
import { RunnableSequence } from '@langchain/core/runnables'
import { PromptTemplate } from '@langchain/core/prompts'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { databaseEntities } from '../../utils'

export class LLMEvaluationRunner {
    private llm: any

    async runLLMEvaluators(
        data: ICommonObject,
        actualOutputArray: string[],
        errorArray: string[],
        llmEvaluatorMap: any[],
        run?: { signal?: AbortSignal; addTokens?: (tokens: number) => void }
    ) {
        const evaluationResults: any[] = []
        if (this.llm === undefined) {
            this.llm = await this.createLLM(data)
        }

        for (let j = 0; j < actualOutputArray.length; j++) {
            const actualOutput = actualOutputArray[j]
            for (let i = 0; i < llmEvaluatorMap.length; i++) {
                if (errorArray[j] !== '') {
                    evaluationResults.push({
                        error: 'Not Graded!'
                    })
                    continue
                }
                try {
                    const llmEvaluator = llmEvaluatorMap[i]
                    let evaluator = llmEvaluator.evaluator
                    const schema = z.object(convertSchemaToZod(JSON.stringify(evaluator.outputSchema)))
                    const modelWithStructuredOutput = this.llm.withStructuredOutput(schema, {
                        method: 'functionCalling'
                    })
                    const llmExecutor = RunnableSequence.from([
                        PromptTemplate.fromTemplate(evaluator.prompt as string),
                        modelWithStructuredOutput
                    ])
                    const response = await llmExecutor.invoke(
                        {
                            question: data.input,
                            actualOutput: actualOutput,
                            expectedOutput: data.expectedOutput
                        },
                        {
                            signal: run?.signal,
                            callbacks: run?.addTokens
                                ? [
                                      {
                                          handleLLMEnd(output: unknown) {
                                              noteGraderTokens(output, run.addTokens!)
                                          }
                                      }
                                  ]
                                : undefined
                        }
                    )
                    evaluationResults.push(response)
                } catch (error) {
                    evaluationResults.push({
                        error: 'error'
                    })
                }
            }
        }
        return evaluationResults
    }

    async createLLM(data: ICommonObject): Promise<any> {
        try {
            const appServer = getRunningExpressApp()
            const nodeInstanceFilePath = appServer.nodesPool.componentNodes[data.llmConfig.llm].filePath as string
            const nodeModule = await import(nodeInstanceFilePath)
            const NodeClass = nodeModule.nodeClass || nodeModule.default?.nodeClass
            const newNodeInstance = new NodeClass()
            // The same spread an Agent step uses for its model config. `model` and `modelName` are both set,
            // because Bedrock, Perplexity, HuggingFace and Cloudflare read `model`, and other nodes read `modelName`.
            // Streaming stays off: a streaming Gemini call reports usage only as an estimate, or not at all.
            let nodeData = {
                inputs: graderNodeInputs(data.llmConfig),
                credential: data.llmConfig.credentialId,
                id: 'llm_0'
            }
            const workspaceId = data.workspaceId || data.llmConfig?.workspaceId
            const options: ICommonObject = {
                appDataSource: appServer.AppDataSource,
                databaseEntities: databaseEntities,
                // getCredentialData decrypts only a credential in this workspace when the id is set.
                ...(typeof workspaceId === 'string' && workspaceId.length > 0 ? { workspaceId } : {})
            }
            return await newNodeInstance.init(nodeData, undefined, options)
        } catch (error) {
            if (error instanceof Error && error.message === 'The grading model could not be started.') throw error
            throw new Error('The grading model could not be started.')
        }
    }
}

// The step config, then the resolved model under both names the catalog uses, with streaming forced off.
export function graderNodeInputs(llmConfig: { model?: unknown; inputs?: unknown } | null | undefined): Record<string, unknown> {
    const saved = llmConfig?.inputs && typeof llmConfig.inputs === 'object' ? { ...(llmConfig.inputs as Record<string, unknown>) } : {}
    const name = String(llmConfig?.model || saved.model || saved.modelName || '')
    return { ...saved, model: name, modelName: name, streaming: false }
}

function finiteTokens(value: unknown): number {
    const total = Number(value)
    return Number.isFinite(total) && total > 0 ? total : 0
}

// `tokenUsage` is what most nodes report. Gemini's streaming branch leaves that empty and sets
// `estimatedTokenUsage` instead. Some nodes put the count on the generation message as `usage_metadata`.
export function graderTokenTotal(output: unknown): number {
    if (!output || typeof output !== 'object') return 0
    const row = output as {
        llmOutput?: { tokenUsage?: { totalTokens?: unknown }; estimatedTokenUsage?: { totalTokens?: unknown } }
        generations?: unknown
    }
    const reported = finiteTokens(row.llmOutput?.tokenUsage?.totalTokens)
    if (reported) return reported
    const estimated = finiteTokens(row.llmOutput?.estimatedTokenUsage?.totalTokens)
    if (estimated) return estimated
    const generations = Array.isArray(row.generations) ? row.generations : []
    for (const item of generations) {
        const list = Array.isArray(item) ? item : [item]
        for (const generation of list) {
            const message = (generation as { message?: { usage_metadata?: Record<string, unknown> } } | null)?.message
            const meta = message?.usage_metadata
            if (!meta || typeof meta !== 'object') continue
            const total = finiteTokens(meta.total_tokens ?? meta.totalTokens)
            if (total) return total
            const input = Number(meta.input_tokens ?? meta.prompt_tokens ?? 0)
            const completion = Number(meta.output_tokens ?? meta.completion_tokens ?? 0)
            if (Number.isFinite(input) && Number.isFinite(completion) && input + completion > 0) return input + completion
        }
    }
    return 0
}

export function noteGraderTokens(output: unknown, addTokens: (tokens: number) => void) {
    const total = graderTokenTotal(output)
    if (total > 0) addTokens(total)
}
