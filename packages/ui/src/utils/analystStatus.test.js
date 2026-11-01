import {
    ANALYST_OFF_NOTE,
    MODE_TEXT,
    credentialOf,
    fetchAnalystMode,
    modeFrom,
    resetAnalystModeCache,
    serverAnalystMode
} from './analystStatus'
import { CREDENTIAL_INPUT } from './canvasSave'

jest.mock('@/store/constant', () => ({ baseURL: 'http://localhost' }))

const answer = (name) => jest.fn(async () => ({ data: [{ label: 'x', name }] }))

beforeEach(() => resetAnalystModeCache())

describe('analyst mode lookup', () => {
    it('reads one known word and treats anything else as unknown', () => {
        expect(modeFrom([{ name: 'sandbox' }])).toBe('sandbox')
        expect(modeFrom([{ name: 'readonly' }])).toBe('readonly')
        expect(modeFrom([{ name: 'unavailable' }])).toBe('unavailable')
        expect(modeFrom([{ name: 'error' }])).toBe('unknown')
        expect(modeFrom(undefined)).toBe('unknown')
    })

    it('asks the existing node-load-method route with the node and its credential', async () => {
        const post = answer('readonly')
        const node = { name: 'postgreSQLMCP', credential: 'zz-fake-cred', inputs: {} }
        expect(await fetchAnalystMode(node, post)).toBe('readonly')
        const [url, body] = post.mock.calls[0]
        expect(url).toBe('http://localhost/api/v1/node-load-method/postgreSQLMCP')
        expect(body).toMatchObject({ loadMethod: 'analystMode', credential: 'zz-fake-cred' })
        expect(node).toEqual({ name: 'postgreSQLMCP', credential: 'zz-fake-cred', inputs: {} })
    })

    it('a server that cannot answer, such as one without the lookup, is unknown and shows nothing', async () => {
        const post = jest.fn(async () => {
            throw new Error('500')
        })
        const mode = await fetchAnalystMode({ name: 'postgreSQLMCP' }, post)
        expect(mode).toBe('unknown')
        expect(MODE_TEXT[mode]).toBeUndefined()
    })

    it('a credential picked in this session wins over the saved one', () => {
        expect(credentialOf({ credential: 'saved', inputs: { [CREDENTIAL_INPUT]: 'picked' } })).toBe('picked')
        expect(credentialOf({ credential: 'saved', inputs: {} })).toBe('saved')
        expect(credentialOf({})).toBe('')
    })

    it('one server-wide lookup serves every card with no credential, and an unknown answer is asked again', async () => {
        const post = answer('sandbox')
        await serverAnalystMode({ name: 'postgreSQLMCP' }, post)
        await serverAnalystMode({ name: 'postgreSQLMCP' }, post)
        expect(post).toHaveBeenCalledTimes(1)
        resetAnalystModeCache()
        const failing = jest.fn(async () => ({ data: [] }))
        expect(await serverAnalystMode({}, failing)).toBe('unknown')
        expect(await serverAnalystMode({}, failing)).toBe('unknown')
        expect(failing).toHaveBeenCalledTimes(2)
    })

    it('the sandbox badge is the only analyst-storage text, and the note names the server', () => {
        expect(MODE_TEXT.sandbox.badge).toBe('Sandbox.')
        expect(MODE_TEXT.readonly.detail).not.toMatch(/analyst/i)
        expect(MODE_TEXT.unavailable.detail).not.toMatch(/analyst/i)
        expect(ANALYST_OFF_NOTE).toBe('Analyst is turned off on this server.')
    })
})
