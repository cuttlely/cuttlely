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
        } finally {
            if (previous === undefined) delete process.env.LANGSMITH_API_KEY
            else process.env.LANGSMITH_API_KEY = previous
        }
    })
})
