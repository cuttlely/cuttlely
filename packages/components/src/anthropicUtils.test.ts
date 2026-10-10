import { supportsSamplingParams } from './anthropicUtils'
import { isReasoningModelOpenAI } from './utils'

describe('supportsSamplingParams', () => {
    it('keeps sampling parameters for Claude models before Opus 4.7', () => {
        for (const name of [
            'claude-opus-4-6',
            'claude-sonnet-4-6',
            'claude-haiku-4-5',
            'claude-haiku-4-5@20251001',
            'claude-sonnet-4-5@20250929',
            'claude-3-5-haiku-20241022',
            'anthropic.claude-opus-4-5-20251101-v1:0',
            undefined
        ]) {
            expect(supportsSamplingParams(name)).toBe(true)
        }
    })

    it('drops sampling parameters for Opus 4.7 and every 5.x model, on every provider naming', () => {
        for (const name of [
            'claude-opus-4-7',
            'us.anthropic.claude-opus-4-8',
            'claude-opus-5',
            'claude-opus-5-5',
            'claude-sonnet-5',
            'claude-sonnet-5-5',
            'claude-haiku-5-5',
            'anthropic.claude-haiku-5-5',
            'claude-fable-5-1',
            'anthropic.claude-mythos-5-1',
            'anthropic/claude-sonnet-5.5'
        ]) {
            expect(supportsSamplingParams(name)).toBe(false)
        }
    })
})

describe('isReasoningModelOpenAI', () => {
    it('treats gpt-5 and gpt-6 models as reasoning models, and not gpt-4o', () => {
        expect(isReasoningModelOpenAI('gpt-5.6-luna')).toBe(true)
        expect(isReasoningModelOpenAI('gpt-6-luna')).toBe(true)
        expect(isReasoningModelOpenAI('gpt-6.1-sol')).toBe(true)
        expect(isReasoningModelOpenAI('gpt-4o-mini')).toBe(false)
        expect(isReasoningModelOpenAI('gpt-4.1')).toBe(false)
    })
})
