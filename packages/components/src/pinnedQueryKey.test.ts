import { createHmac } from 'crypto'
import { getPinnedQueryKey, pinnedQueriesEnabled } from './utils'

const PURPOSE = 'cuttlely-pinned-query-v1'
const OVERWRITE = 'CUTTLELY_SECRETKEY_OVERWRITE'

describe('pinned query purpose key', () => {
    const previous = process.env[OVERWRITE]

    afterEach(async () => {
        if (previous === undefined) delete process.env[OVERWRITE]
        else process.env[OVERWRITE] = previous
        try {
            await getPinnedQueryKey()
        } catch {
            // The restored key file may be absent in this process. The cache still follows the restored secret.
        }
    })

    it('derives the purpose key from the encryption key', async () => {
        process.env[OVERWRITE] = 'ZZ-TEST-pinned-key'
        const key = await getPinnedQueryKey()
        const expected = createHmac('sha256', 'ZZ-TEST-pinned-key').update(PURPOSE).digest()
        expect(Buffer.isBuffer(key)).toBe(true)
        expect(key.equals(expected)).toBe(true)
        expect(await getPinnedQueryKey()).toBe(key)

        process.env[OVERWRITE] = 'ZZ-TEST-pinned-key-other'
        const other = await getPinnedQueryKey()
        expect(other.equals(key)).toBe(false)
        expect(other.equals(createHmac('sha256', 'ZZ-TEST-pinned-key-other').update(PURPOSE).digest())).toBe(true)
    })

    it('enables pinned queries only for 1 and true', () => {
        expect(pinnedQueriesEnabled({ CUTTLELY_PINNED_QUERIES: '1' })).toBe(true)
        expect(pinnedQueriesEnabled({ CUTTLELY_PINNED_QUERIES: 'true' })).toBe(true)
        for (const value of ['', 'false', '0', 'yes', 'on', 'TRUE', 'True', undefined]) {
            expect(pinnedQueriesEnabled({ CUTTLELY_PINNED_QUERIES: value })).toBe(false)
        }
        expect(pinnedQueriesEnabled({})).toBe(false)
    })
})
