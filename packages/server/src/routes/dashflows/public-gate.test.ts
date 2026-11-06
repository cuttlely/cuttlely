import express from 'express'
import request from 'supertest'
import { apiV1Auth } from '../../identity/apiGate'
import { WHITELIST_URLS, READ_ONLY_WHITELIST_URLS, API_KEY_BLACKLIST_URLS } from '../../utils/constants'
it('admits the dedicated public dashboard path without opening private dashboard or harness routes', async () => {
    const server = express()
        .use(
            apiV1Auth({
                whitelistURLs: WHITELIST_URLS,
                readOnlyWhitelistURLs: READ_ONLY_WHITELIST_URLS,
                apiKeyBlacklistURLs: API_KEY_BLACKLIST_URLS,
                licenseRequired: () => false,
                dataSource: {} as any,
                attachIdentitySession: async () => null,
                validateAPIKey: async () => ({ isValid: false })
            })
        )
        .use((_req, res) => res.json({ reached: true }))
    await request(server).get('/api/v1/public-dashflows/token').expect(200)
    await request(server).post('/api/v1/public-dashflows/token/accounts/account/report').expect(200)
    for (const path of [
        '/api/v1/dashflows',
        '/api/v1/dashflows/demo/publish',
        '/api/v1/harnesses/test/runs/async',
        '/api/v1/public-dashflows-extra/token'
    ])
        await request(server).post(path).expect(401)
})
