jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => {
        throw new Error('no app in this test')
    }
}))

import settingsService from './index'

const SECRET = 'fake-langsmith-key-b3'

describe('public settings payload', () => {
    it('does not include env-only status or a host secret', async () => {
        const previous = process.env.LANGSMITH_API_KEY
        process.env.LANGSMITH_API_KEY = SECRET
        try {
            const listed = await settingsService.getSettings()
            expect(JSON.stringify(listed)).not.toContain(SECRET)
            expect(listed).not.toHaveProperty('readOnly')
            expect(listed).not.toHaveProperty('LANGSMITH_API_KEY')
            expect(listed.PINNED_QUERIES).toBe(false)
        } finally {
            if (previous === undefined) delete process.env.LANGSMITH_API_KEY
            else process.env.LANGSMITH_API_KEY = previous
        }
    })

    it('enables pinned queries only for 1 and true', async () => {
        const previous = process.env.CUTTLELY_PINNED_QUERIES
        try {
            delete process.env.CUTTLELY_PINNED_QUERIES
            expect((await settingsService.getSettings()).PINNED_QUERIES).toBe(false)
            process.env.CUTTLELY_PINNED_QUERIES = 'TRUE'
            expect((await settingsService.getSettings()).PINNED_QUERIES).toBe(false)
            process.env.CUTTLELY_PINNED_QUERIES = 'yes'
            expect((await settingsService.getSettings()).PINNED_QUERIES).toBe(false)
            process.env.CUTTLELY_PINNED_QUERIES = '1'
            expect((await settingsService.getSettings()).PINNED_QUERIES).toBe(true)
            process.env.CUTTLELY_PINNED_QUERIES = 'true'
            expect((await settingsService.getSettings()).PINNED_QUERIES).toBe(true)
        } finally {
            if (previous === undefined) delete process.env.CUTTLELY_PINNED_QUERIES
            else process.env.CUTTLELY_PINNED_QUERIES = previous
        }
    })
})
