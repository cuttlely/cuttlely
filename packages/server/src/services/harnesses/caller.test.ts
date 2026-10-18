import harnessesService from './index'

// Every harness route and the publish check name a caller. These refusals come before the harness is read.
describe('harness run caller', () => {
    const body = { question: 'How many loaves?' }

    it('refuses a run request with no caller, or with a keyless flow as the caller', async () => {
        await expect(harnessesService.assertRunRequest('bakery', body, 'team-a', undefined)).rejects.toMatchObject({ statusCode: 403 })
        await expect(harnessesService.assertRunRequest('bakery', body, 'team-a', { via: 'flow' })).rejects.toMatchObject({
            statusCode: 403
        })
    })

    it('refuses an API key whose list does not name the harness, or that has no id', async () => {
        await expect(
            harnessesService.assertRunRequest('payroll', body, 'team-a', { via: 'api_key', apiKeyId: 'key-1', harnesses: ['bakery'] })
        ).rejects.toMatchObject({ statusCode: 403, message: 'This API key may not run harness "payroll".' })
        await expect(
            harnessesService.assertRunRequest('bakery', body, 'team-a', { via: 'api_key', apiKeyId: '', harnesses: ['bakery'] })
        ).rejects.toMatchObject({ statusCode: 403 })
    })

    it('refuses a publish-check replay of a harness the key does not list, before the canvas is read', async () => {
        const chatflow = { id: 'flow-1', name: 'payroll', flowData: '{"nodes":[],"edges":[]}', workspaceId: 'team-a' }
        await expect(
            harnessesService.replayCheck(chatflow, chatflow.flowData, body, {
                caller: { via: 'api_key', apiKeyId: 'key-1', harnesses: ['bakery'] }
            })
        ).rejects.toMatchObject({ statusCode: 403 })
        await expect(harnessesService.replayCheck(chatflow, chatflow.flowData, body, { caller: undefined })).rejects.toMatchObject({
            statusCode: 403
        })
    })
})
