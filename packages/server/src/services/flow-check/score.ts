// Turns a saved dataset into the check's questions, and scores each answer with the evaluators
// the caller picked. Scoring calls the existing runners. It does not keep its own pass/fail rules.
import { StatusCodes } from 'http-status-codes'
import { Dataset } from '../../database/entities/Dataset'
import { DatasetRow } from '../../database/entities/DatasetRow'
import { Evaluator } from '../../database/entities/Evaluator'
import { AppError } from '../../errors/appError'
import { EvaluatorDTO } from '../../Interface.Evaluation'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'

export type CheckEvaluator = EvaluatorDTO
import { runAdditionalEvaluators } from '../evaluations/EvaluatorRunner'
import { LLMEvaluationRunner } from '../evaluations/LLMEvaluationRunner'
import { COMPARE_COUNT_MAX, CheckScore } from './compare'

export const MAX_QUESTION_CHARS = 2000
// The same cut the check uses for an answer, so a long expected answer does not sit in memory in full.
const MAX_EXPECTED_CHARS = 4000

export interface DatasetCase {
    question: string
    expected: string
}

export interface GradingModel {
    llm: string
    model: string
    credentialId: string
    // The step's model config, or the chat node's inputs. The grader spreads this onto the node.
    inputs: Record<string, unknown>
}

export interface GradeRun {
    signal: AbortSignal
    timeoutMs: number
    // Tokens a model evaluator already reported. The per-grade abort still counts these.
    addTokens?: (tokens: number) => void
}

export type GradeReturn = unknown[] | { grades: unknown[]; tokens?: number | null }

// Tests replace the grader so a check never calls a model. Production leaves this null and uses the runner.
export const scoreHooks: {
    gradeLlm:
        | null
        | ((
              data: { [key: string]: any },
              actual: string[],
              errors: string[],
              evaluators: Array<{ evaluatorId: string; evaluator: EvaluatorDTO }>,
              run: GradeRun
          ) => Promise<GradeReturn>)
} = { gradeLlm: null }

export function readDatasetId(body: { datasetId?: unknown } | null | undefined): string | null {
    if (!body || body.datasetId === undefined || body.datasetId === null) return null
    if (typeof body.datasetId !== 'string' || body.datasetId.trim().length === 0) {
        throw new AppError(StatusCodes.BAD_REQUEST, 'datasetId must be a dataset id.')
    }
    return body.datasetId.trim()
}

export function readEvaluatorIds(body: { evaluatorIds?: unknown } | null | undefined): string[] {
    if (!body || body.evaluatorIds === undefined || body.evaluatorIds === null) return []
    if (!Array.isArray(body.evaluatorIds)) {
        throw new AppError(StatusCodes.BAD_REQUEST, 'evaluatorIds must be a list of evaluator ids.')
    }
    const ids: string[] = []
    const seen = new Set<string>()
    for (const id of body.evaluatorIds) {
        if (typeof id !== 'string' || id.trim().length === 0) {
            throw new AppError(StatusCodes.BAD_REQUEST, 'evaluatorIds must be a list of evaluator ids.')
        }
        const trimmed = id.trim()
        if (seen.has(trimmed)) continue
        seen.add(trimmed)
        ids.push(trimmed)
    }
    return ids
}

function clipExpected(text: unknown): string {
    const value = String(text ?? '')
    return value.length > MAX_EXPECTED_CHARS ? `${value.slice(0, MAX_EXPECTED_CHARS)}…` : value
}

// Rows stay in sequence order. Blank questions and questions over the check's length limit are left out.
// The list stops at the check's maximum question count. Repeats are kept: two rows are two questions.
export function questionsFromDataset(rows: Array<{ input?: unknown; output?: unknown; sequenceNo?: unknown }>): DatasetCase[] {
    const sorted = [...rows].sort((a, b) => Number(a.sequenceNo) - Number(b.sequenceNo))
    const cases: DatasetCase[] = []
    for (const row of sorted) {
        const question = String(row.input ?? '').trim()
        if (!question || question.length > MAX_QUESTION_CHARS) continue
        cases.push({ question, expected: clipExpected(row.output) })
        if (cases.length >= COMPARE_COUNT_MAX) break
    }
    return cases
}

export async function casesFromDataset(datasetId: string, workspaceId: string): Promise<DatasetCase[]> {
    // A missing workspace matches nothing, the same as a dataset that belongs to another workspace.
    if (!workspaceId) throw new AppError(StatusCodes.NOT_FOUND, `Dataset ${datasetId} not found`)
    const app = getRunningExpressApp()
    const dataset = await app.AppDataSource.getRepository(Dataset).findOneBy({ id: datasetId, workspaceId })
    if (!dataset) throw new AppError(StatusCodes.NOT_FOUND, `Dataset ${datasetId} not found`)
    const rows = await app.AppDataSource.getRepository(DatasetRow).find({
        where: { datasetId: dataset.id },
        order: { sequenceNo: 'ASC' }
    })
    const cases = questionsFromDataset(rows)
    if (!cases.length) throw new AppError(StatusCodes.BAD_REQUEST, 'This dataset has no questions the check can ask.')
    return cases
}

export async function loadEvaluators(ids: string[], workspaceId: string): Promise<EvaluatorDTO[]> {
    if (!ids.length) return []
    if (!workspaceId) throw new AppError(StatusCodes.NOT_FOUND, `Evaluator ${ids[0]} not found`)
    const repo = getRunningExpressApp().AppDataSource.getRepository(Evaluator)
    const loaded: EvaluatorDTO[] = []
    for (const id of ids) {
        const row = await repo.findOneBy({ id, workspaceId })
        // Missing and another workspace are the same answer, and nothing is started.
        if (!row) throw new AppError(StatusCodes.NOT_FOUND, `Evaluator ${id} not found`)
        try {
            loaded.push(EvaluatorDTO.fromEntity(row))
        } catch {
            throw new AppError(StatusCodes.NOT_FOUND, `Evaluator ${id} not found`)
        }
    }
    return loaded
}

// Each agentflow step stores its model under its own input names. The config is read the same way the step reads it:
// the credential field, then `model`, then `modelName`.
const AGENTFLOW_MODELS: Array<{ name: string; modelKey: string; configKey: string }> = [
    { name: 'llmAgentflow', modelKey: 'llmModel', configKey: 'llmModelConfig' },
    { name: 'agentAgentflow', modelKey: 'agentModel', configKey: 'agentModelConfig' },
    { name: 'conditionAgentAgentflow', modelKey: 'conditionAgentModel', configKey: 'conditionAgentModelConfig' }
]

function readStepModel(config: Record<string, any> | undefined): { model: string; credentialId: string } {
    const row = config || {}
    const credentialId = row.FLOWISE_CREDENTIAL_ID ?? row.credential ?? ''
    const model = row.model ?? row.modelName ?? ''
    return { model: String(model || ''), credentialId: String(credentialId || '') }
}

// The first chat model on the canvas, or the first agentflow step that has a model.
// The credential id is the one saved on that node. The caller passes the flow's workspace with it.
export function gradingModel(flowData: string): GradingModel | null {
    let nodes: unknown
    try {
        nodes = JSON.parse(flowData)?.nodes
    } catch {
        return null
    }
    if (!Array.isArray(nodes)) return null
    for (const node of nodes) {
        const data = (node as { data?: Record<string, any> })?.data
        if (!data) continue
        const step = AGENTFLOW_MODELS.find((item) => item.name === data.name)
        if (step) {
            const inputs = (data.inputs || {}) as Record<string, any>
            const llm = String(inputs[step.modelKey] || '')
            if (!llm) continue
            const config = (inputs[step.configKey] || {}) as Record<string, unknown>
            const picked = readStepModel(config)
            return { llm, model: picked.model, credentialId: picked.credentialId, inputs: { ...config } }
        }
        if (data.category === 'Chat Models' || data.category === 'LLMs') {
            const inputs = (data.inputs || {}) as Record<string, any>
            const credentialId = String(data.credential || '')
            const model = String(inputs.model ?? inputs.modelName ?? '')
            if (data.name && credentialId) return { llm: String(data.name), model, credentialId, inputs: { ...inputs } }
        }
    }
    return null
}

// The check records one token total and one wall-clock time. Numeric evaluators read those.
// Time measures share that one duration, because the check does not split it into model time and chain time.
// Prompt and completion tokens are not recorded separately. A measure of those, or of a missing total, scores Error.
export function checkMetrics(tokens: number | null, ms: number): Record<string, number> {
    const metric: Record<string, number> = {}
    if (typeof ms === 'number' && Number.isFinite(ms)) {
        metric.apiLatency = ms
        metric.llm = ms
        metric.chain = ms
    }
    if (typeof tokens === 'number' && Number.isFinite(tokens)) metric.totalTokens = tokens
    return metric
}

// A number on its own is not Pass or Fail. The cutoff that would turn a score into one is a later change.
export function llmGradeResult(response: unknown): CheckScore['result'] {
    if (!response || typeof response !== 'object') return 'Error'
    const row = response as Record<string, unknown>
    if (row.error) return 'Error'
    if (row.result === 'Pass' || row.result === 'Fail' || row.result === 'Error') return row.result
    for (const key of ['pass', 'passed', 'correct']) {
        if (typeof row[key] === 'boolean') return row[key] ? 'Pass' : 'Fail'
    }
    const booleans = Object.values(row).filter((value): value is boolean => typeof value === 'boolean')
    if (booleans.length === 1) return booleans[0] ? 'Pass' : 'Fail'
    return 'Error'
}

export interface ScoreInput {
    evaluators: EvaluatorDTO[]
    question: string
    expected: string | null
    text: string | null
    error: string | null
    tokens: number | null
    ms: number
    workspaceId: string
    flowData: string
    signal?: AbortSignal
    timeoutMs?: number
}

function asGrades(returned: GradeReturn): { grades: unknown[]; tokens: number | null } {
    if (Array.isArray(returned)) return { grades: returned, tokens: null }
    const tokens = returned?.tokens
    return { grades: returned?.grades || [], tokens: typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : null }
}

// Reject when the check aborts the grader, so a hung model call cannot hold the check's slot.
function untilAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return work
    if (signal.aborted) return Promise.reject(new Error('aborted'))
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(new Error('aborted'))
        signal.addEventListener('abort', onAbort, { once: true })
        work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
    })
}

function gradingFailureMessage(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error || '')
    if (/aborted/i.test(text)) return 'The grading model did not finish.'
    return 'The grading model could not be started.'
}

async function gradeWithLlm(
    input: ScoreInput,
    evaluators: EvaluatorDTO[]
): Promise<{ results: Array<CheckScore['result']>; tokens: number | null; message?: string }> {
    const errored = () => ({ results: evaluators.map(() => 'Error' as const), tokens: null })
    const failed = (message: string) => ({ ...errored(), message })
    // A failed answer is Error for every evaluator. The grader is not called.
    if (input.error || input.signal?.aborted) return errored()
    const model = gradingModel(input.flowData)
    if (!model || !input.workspaceId) return failed('The grading model could not be started.')
    const data: { [key: string]: any } = {
        input: input.question,
        expectedOutput: input.expected ?? '',
        workspaceId: input.workspaceId,
        llmConfig: { ...model, workspaceId: input.workspaceId }
    }
    const map = evaluators.map((evaluator) => ({ evaluatorId: evaluator.id, evaluator }))
    let graderTokens = 0
    const run: GradeRun = {
        signal: input.signal || new AbortController().signal,
        timeoutMs: input.timeoutMs ?? 0,
        addTokens: (tokens) => {
            graderTokens += tokens
        }
    }
    const counted = () => (graderTokens > 0 ? graderTokens : null)
    const work = scoreHooks.gradeLlm
        ? scoreHooks.gradeLlm(data, [input.text ?? ''], [''], map, run)
        : new LLMEvaluationRunner().runLLMEvaluators(data, [input.text ?? ''], [''], map, {
              signal: run.signal,
              addTokens: run.addTokens
          })
    try {
        const returned = asGrades(await untilAbort(Promise.resolve(work), input.signal))
        return {
            results: evaluators.map((_, index) => llmGradeResult(returned.grades[index])),
            tokens: returned.tokens ?? counted()
        }
    } catch (error) {
        // Text, JSON and numeric scores are already stored. Only these model scores become Error.
        // A per-grade abort rejects this wait, but tokens the finished evaluators already reported still count.
        return { ...failed(gradingFailureMessage(error)), tokens: counted() }
    }
}

export async function scoreAnswer(input: ScoreInput): Promise<{ scores: CheckScore[]; tokens: number | null }> {
    const evaluators = input.evaluators || []
    if (!evaluators.length) return { scores: [], tokens: null }
    const byId = new Map<string, CheckScore['result']>()
    const simple = evaluators.filter((evaluator) => evaluator.type === 'numeric' || evaluator.type === 'json' || evaluator.type === 'text')
    const llm = evaluators.filter((evaluator) => evaluator.type === 'llm')
    if (simple.length) {
        try {
            const { results } = await runAdditionalEvaluators(
                [checkMetrics(input.tokens, input.ms)],
                [input.text ?? ''],
                [input.error ?? ''],
                simple.map((evaluator) => evaluator.id),
                input.workspaceId
            )
            const row = (results && results[0]) || []
            simple.forEach((evaluator, index) => {
                const result = row[index]?.result
                byId.set(evaluator.id, result === 'Pass' || result === 'Fail' || result === 'Error' ? result : 'Error')
            })
        } catch {
            for (const evaluator of simple) byId.set(evaluator.id, 'Error')
        }
    }
    let tokens: number | null = null
    let llmMessage: string | undefined
    if (llm.length) {
        const graded = await gradeWithLlm(input, llm)
        tokens = graded.tokens
        llmMessage = graded.message
        llm.forEach((evaluator, index) => byId.set(evaluator.id, graded.results[index] || 'Error'))
    }
    return {
        scores: evaluators.map((evaluator) => ({
            id: evaluator.id,
            name: evaluator.name,
            result: byId.get(evaluator.id) || 'Error',
            ...(evaluator.type === 'llm' && llmMessage ? { message: llmMessage } : {})
        })),
        tokens
    }
}
