import { AsyncCaller } from '@langchain/core/utils/async_caller'
import { applyModelRetryBudget, MODEL_RETRY_BUDGET } from 'flowise-components'
import { toPredictionError } from './predictionErrors'

/** A provider that always answers 429, shaped like the OpenAI SDK's error (status, headers). */
function rateLimited(retryAfter?: string) {
    const headers = new Headers(retryAfter ? { 'retry-after': retryAfter } : {})
    return Object.assign(new Error('429 Rate limit reached for gpt-test on requests per min.'), { status: 429, headers })
}

/** Stands in for a chat model: LangChain models keep their retry logic in `caller`. */
const fakeModel = () => ({ caller: new AsyncCaller({}) })
const retriesOf = (caller: AsyncCaller) => (caller as unknown as { maxRetries: number }).maxRetries

describe('chat model retry budget', () => {
    it('LangChain retries six times by default, the budget makes it at most three tries', async () => {
        expect(retriesOf(new AsyncCaller({}))).toBe(6)
        expect(MODEL_RETRY_BUDGET).toEqual({ maxRetries: 2, totalMs: 20000 })
        const model = applyModelRetryBudget(fakeModel())
        expect(retriesOf(model.caller)).toBe(2)

        let tries = 0
        const started = Date.now()
        const failure = await model.caller
            .call(async () => {
                tries += 1
                throw rateLimited('12')
            })
            .catch((error: unknown) => error)

        expect(tries).toBe(3)
        // Backoff between the three tries stays in seconds, not the old ~95 seconds.
        expect(Date.now() - started).toBeLessThan(MODEL_RETRY_BUDGET.totalMs)
        const answer = toPredictionError(failure)
        expect(answer.statusCode).toBe(429)
        expect(answer.retryAfterSeconds).toBe(12)
    }, 30000)

    it('starts no new try once the time is up', async () => {
        const model = applyModelRetryBudget(fakeModel(), { maxRetries: 5, totalMs: 50 })
        let tries = 0
        await expect(
            model.caller.call(async () => {
                tries += 1
                await new Promise((resolve) => setTimeout(resolve, 60))
                throw rateLimited()
            })
        ).rejects.toThrow(/429/)
        expect(tries).toBe(1)
    })

    it('still recovers from a one-off 429', async () => {
        const model = applyModelRetryBudget(fakeModel())
        let tries = 0
        const answer = await model.caller.call(async () => {
            tries += 1
            if (tries === 1) throw rateLimited('1')
            return 'Two dozen croissants are ready.'
        })
        expect(answer).toBe('Two dozen croissants are ready.')
        expect(tries).toBe(2)
    }, 10000)

    it('keeps refusing at once what LangChain never retries (a bad key is not retried)', async () => {
        const model = applyModelRetryBudget(fakeModel())
        let tries = 0
        await expect(
            model.caller.call(async () => {
                tries += 1
                throw Object.assign(new Error('401 Incorrect API key provided'), { status: 401 })
            })
        ).rejects.toThrow(/401/)
        expect(tries).toBe(1)
    })

    it('is applied once, and leaves anything without a caller alone', () => {
        const model = applyModelRetryBudget(applyModelRetryBudget(fakeModel()))
        expect(retriesOf(model.caller)).toBe(2)
        expect(applyModelRetryBudget(undefined)).toBeUndefined()
        const plain = { text: 'not a model' }
        expect(applyModelRetryBudget(plain)).toBe(plain)
    })
})
