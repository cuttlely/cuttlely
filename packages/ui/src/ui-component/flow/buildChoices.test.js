import { BUILD_CHOICES, GLOSSARY, HARNESS_LABEL, chooserIsOpen } from './buildChoices'

describe('build choices', () => {
    it('maps each beginner outcome to the existing canvas', () => {
        expect(BUILD_CHOICES.map((choice) => [choice.outcome, choice.product, choice.createPath])).toEqual([
            ['Agent team', 'Harness', '/harnesscanvas'],
            ['Chat / simple AI app', 'Chatflow', '/canvas'],
            ['Workflow / automation', 'Agentflow', '/v2/agentcanvas'],
            ['Knowledge / data pipeline', 'ETL', '/etlcanvas']
        ])
    })

    it('keeps the harness gloss on the harness choice', () => {
        expect(BUILD_CHOICES.find((choice) => choice.id === 'harness').label).toBe(HARNESS_LABEL)
        expect(HARNESS_LABEL).toBe('Harness · Agent Team')
    })

    it('keeps import and credentials in the names panel', () => {
        const names = GLOSSARY.map(([name]) => name)
        expect(names).toEqual(['Harnesses', 'Chatflows', 'Agentflows', 'Import', 'Credentials'])
        const importLine = GLOSSARY.find(([name]) => name === 'Import')[1]
        expect(importLine).toMatch(/Flowise JSON/)
        expect(importLine).toMatch(/Langflow/)
        expect(importLine).toMatch(/not supported yet/)
    })

    it('stays open on an empty list after hide, and stays hidden once a list has items', () => {
        expect(chooserIsOpen({ dismissed: false, pinned: false })).toBe(true)
        expect(chooserIsOpen({ dismissed: true, pinned: false })).toBe(false)
        expect(chooserIsOpen({ dismissed: true, pinned: true })).toBe(true)
    })
})
