import { coerceMultipartPredictionBody } from './multipartPredictionBody'

describe('coerceMultipartPredictionBody', () => {
    it('parses JSON fields from a multipart body and leaves a question string', () => {
        const body: Record<string, unknown> = {
            question: 'What is in this file?',
            chatId: 'chat-1',
            uploads: JSON.stringify([{ name: 'pic.png', type: 'file', mime: 'image/png', data: 'data:image/png;base64,YQ==' }]),
            streaming: 'true'
        }
        coerceMultipartPredictionBody(body)
        expect(body.question).toBe('What is in this file?')
        expect(Array.isArray(body.uploads)).toBe(true)
        expect((body.uploads as { name: string }[])[0].name).toBe('pic.png')
        expect(body.streaming).toBe('true')
    })

    it('drops a field that looks like JSON but does not parse', () => {
        const body: Record<string, unknown> = { uploads: '[{' }
        coerceMultipartPredictionBody(body)
        expect(body.uploads).toBeUndefined()
    })

    it('leaves an object body from a JSON request unchanged', () => {
        const uploads = [{ name: 'a.txt', type: 'file' }]
        const body: Record<string, unknown> = { uploads, question: 'hi' }
        coerceMultipartPredictionBody(body)
        expect(body.uploads).toBe(uploads)
    })
})
