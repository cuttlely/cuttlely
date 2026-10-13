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
}

// Tests replace the grader so a check never calls a model. Production leaves this null and uses the runner.
export const scoreHooks: {
    gradeLlm:
        | null
        | ((
              data: { [key: string]: any },
              actual: string[],
              errors: string[],
              evaluators: Array<{ evaluatorId: string; evaluator: EvaluatorDTO }>
          ) => Promise<unknown[]>)
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

// The first chat model on the canvas, or the model an agentflow step is set to.
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
        if (data.name === 'llmAgentflow' || data.name === 'agentAgentflow') {
            const inputs = (data.inputs || {}) as Record<string, any>
            const config = (inputs.llmModelConfig || {}) as Record<string, any>
            const credentialId = config.FLOWISE_CREDENTIAL_ID || config.credential || ''
            const llm = inputs.llmModel || ''
            const model = config.modelName || config.model || ''
            if (llm && credentialId) return { llm: String(llm), model: String(model || ''), credentialId: String(credentialId) }
            continue
        }
        if (data.category === 'Chat Models' || data.category === 'LLMs') {
            const inputs = (data.inputs || {}) as Record<string, any>
            const credentialId = data.credential || ''
            const model = inputs.modelName || inputs.model || ''
            if (data.name && credentialId) return { llm: String(data.name), model: String(model), credentialId: String(credentialId) }
        }
    }
    return null
}

// The check records one token total and one wall-clock time. Numeric evaluators read those.
// Time measures share that one duration, because the check does not split it into model time and chain time.
// Prompt and completion tokens are not split, so a measure of those has nothing to read.
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
}

async function gradeWithLlm(input: ScoreInput, evaluators: EvaluatorDTO[]): Promise<Array<CheckScore['result']>> {
    // A failed answer is Error for every evaluator. The grader is not called.
    if (input.error) return evaluators.map(() => 'Error')
    const model = gradingModel(input.flowData)
    if (!model || !input.workspaceId) return evaluators.map(() => 'Error')
    const data: { [key: string]: any } = {
        input: input.question,
        expectedOutput: input.expected ?? '',
        workspaceId: input.workspaceId,
        llmConfig: { ...model, workspaceId: input.workspaceId }
    }
    const map = evaluators.map((evaluator) => ({ evaluatorId: evaluator.id, evaluator }))
    try {
        const responses = scoreHooks.gradeLlm
            ? await scoreHooks.gradeLlm(data, [input.text ?? ''], [''], map)
            : await new LLMEvaluationRunner().runLLMEvaluators(data, [input.text ?? ''], [''], map)
        return evaluators.map((_, index) => llmGradeResult(responses[index]))
    } catch {
        return evaluators.map(() => 'Error')
    }
}

export async function scoreAnswer(input: ScoreInput): Promise<CheckScore[]> {
    const evaluators = input.evaluators || []
    if (!evaluators.length) return []
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
    if (llm.length) {
        const graded = await gradeWithLlm(input, llm)
        llm.forEach((evaluator, index) => byId.set(evaluator.id, graded[index] || 'Error'))
    }
    return evaluators.map((evaluator) => ({
        id: evaluator.id,
        name: evaluator.name,
        result: byId.get(evaluator.id) || 'Error'
    }))
}
