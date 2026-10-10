import { harnessEndingNodeStreams } from './streaming'

const node = (category: string, name: string) => ({ data: { category, name }, category, name })

describe('harness chatflows on the prediction SSE path', () => {
    it('streams a harness ending node that has no chat model on the chatflow', () => {
        expect(harnessEndingNodeStreams(node('Harness', 'harness'), [node('Harness', 'harness')])).toBe(true)
    })

    it('still refuses a harness chatflow that has an output parser', () => {
        expect(
            harnessEndingNodeStreams(node('Harness', 'harness'), [node('Harness', 'harness'), node('Output Parsers', 'csvOutputParser')])
        ).toBe(false)
    })

    it('leaves a tool agent and a chain to the existing streaming rules', () => {
        expect(harnessEndingNodeStreams(node('Agents', 'toolAgent'), [node('Chat Models', 'chatOpenAI')])).toBeNull()
        expect(harnessEndingNodeStreams(node('Chains', 'openApiChain'), [node('Chat Models', 'chatOpenAI')])).toBeNull()
        expect(harnessEndingNodeStreams(node('Harness', 'harnessChief'), [])).toBeNull()
    })
})
