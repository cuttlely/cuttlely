const post = jest.fn()

jest.mock('axios', () => ({ __esModule: true, default: { post: (...args: unknown[]) => post(...args) } }))

import { EvaluationRunner } from '../evaluation/EvaluationRunner'

const data = { evaluationId: 'eval-1', dataset: { rows: [{ input: 'hi', output: 'hello', sequenceNo: 1 }] } }

describe('EvaluationRunner chatflow id', () => {
    beforeEach(() => post.mockReset())

    it.each(['../../admin', 'flow-1', '00000000-0000-0000-0000-00000000000/', ''])('refuses %j before posting', async (chatflowId) => {
        await expect(new EvaluationRunner('http://127.0.0.1:3000').evaluateChatflow(chatflowId, '', data, { rows: [{}] })).rejects.toThrow(
            'Invalid chatflow id'
        )
        expect(post).not.toHaveBeenCalled()
    })

    it('posts to the prediction route for a uuid', async () => {
        post.mockResolvedValue({ data: { text: 'hello' } })
        const chatflowId = '3f2a1c9e-8b7d-4e6f-9a0b-1c2d3e4f5a6b'
        await new EvaluationRunner('http://127.0.0.1:3000').evaluateChatflow(chatflowId, '', data, { rows: [{ evaluations: [] }] })
        expect(post).toHaveBeenCalledTimes(1)
        expect(post.mock.calls[0][0]).toBe(`http://127.0.0.1:3000/api/v1/prediction/${chatflowId}`)
    })
})
