// The real harnessLimits.ts loader, run in a child process: it finds packages/harness from its own directory,
// loads the ESM module, and maps a refusal to a 400 AppError.
import { harnessLimitsInChild } from './harnessLimitsInChild'

const LIMIT = 2000

function canvas(...cards: Array<[string, string]>) {
    return JSON.stringify({
        nodes: [
            { id: 'spec_0', data: { name: 'harnessSpecialist', category: 'Harness', inputs: { specialistName: 'bakery' } } },
            ...cards.map(([label, analystRules], index) => ({
                id: `pg_${index}`,
                data: { name: 'postgreSQLMCP', label, category: 'Tools (MCP)', inputs: { analystRules } }
            }))
        ],
        edges: cards.map((_card, index) => ({ id: `e${index}`, source: `pg_${index}`, target: 'spec_0' }))
    })
}

describe('harness draft limits through the real loader', () => {
    test('rules at the cap pass', () => {
        expect(harnessLimitsInChild('bakery-accounts', canvas(['Bakery DB', 'r'.repeat(LIMIT)]))).toBeNull()
    })

    test('a save over the cap is a 400 AppError that says to shorten and save', () => {
        expect(harnessLimitsInChild('bakery-accounts', canvas(['Bakery DB', 'r'.repeat(LIMIT + 1)]))).toEqual({
            status: 400,
            errorClass: 'AppError',
            message: `Rules on Bakery DB for specialist "bakery" on harness "bakery-accounts" are ${
                LIMIT + 1
            } characters. The limit is ${LIMIT}. Shorten them and save again.`
        })
    })

    test('a restore over the cap is a 400 that says the version cannot be restored and what to do instead', () => {
        expect(harnessLimitsInChild('bakery-accounts', canvas(['Bakery DB', 'r'.repeat(LIMIT + 1)]), 'restore')).toEqual({
            status: 400,
            errorClass: 'AppError',
            message: `This version cannot be restored. Rules on Bakery DB for specialist "bakery" on harness "bakery-accounts" are ${
                LIMIT + 1
            } characters. The limit is ${LIMIT}. Restore another version, or shorten those rules on the canvas and save.`
        })
    })

    test('two cards with the same label are numbered in the joined refusal', () => {
        const refusal = harnessLimitsInChild(
            'bakery-accounts',
            canvas(['PostgreSQL MCP', 'a'.repeat(1200)], ['PostgreSQL MCP', 'b'.repeat(1200)])
        )
        expect(refusal?.status).toBe(400)
        expect(refusal?.message).toBe(
            `Rules on PostgreSQL MCP (1), PostgreSQL MCP (2) for specialist "bakery" on harness "bakery-accounts" are 2402 characters together. The analyst gets them as one section, and the limit is ${LIMIT}. Shorten them and save again.`
        )
    })
})
