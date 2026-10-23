jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({
        AppDataSource: {
            getRepository: (entity: { name: string }) => ({
                findOneBy: async ({ id }: { id: string }) =>
                    entity.name === 'ChatFlow' ? { id, workspaceId: 'ws-1' } : { id, organizationId: 'org-1' }
            })
        }
    })
}))
jest.mock('@cuttlely/components', () => ({
    ...jest.requireActual('@cuttlely/components'),
    streamStorageFile: jest.fn(async () => Buffer.from('bytes'))
}))

import controller, { inlineImageType } from './index'

const FLOW = '33333333-3333-4333-8333-333333333333'

async function headersFor(query: Record<string, string>) {
    const headers: Record<string, string> = {}
    const res: any = {
        setHeader: (k: string, v: string) => (headers[k.toLowerCase()] = v),
        send: jest.fn(),
        status: () => res
    }
    const next = jest.fn()
    await controller.streamUploadedFile({ query: { chatflowId: FLOW, chatId: 'chat-1', ...query } } as any, res, next)
    expect(next).not.toHaveBeenCalled()
    return headers
}

describe('get-upload-file disposition', () => {
    it('serves only raster images inline', () => {
        expect(inlineImageType('chart.png')).toBe('image/png')
        expect(inlineImageType('a.JPG')).toBe('image/jpeg')
        expect(inlineImageType('a.webp')).toBe('image/webp')
        expect(inlineImageType('a.gif')).toBe('image/gif')
        for (const name of ['a.svg', 'a.html', 'a.pdf', 'png', 'a.png.html', 'noext']) expect(inlineImageType(name)).toBeUndefined()
    })

    it('shows an image in place without download=true, and keeps everything else an attachment', async () => {
        const image = await headersFor({ fileName: 'chart.png' })
        expect(image['content-disposition']).toMatch(/^inline/)
        expect(image['content-type']).toBe('image/png')
        expect(image['x-content-type-options']).toBe('nosniff')
        expect((await headersFor({ fileName: 'chart.png', download: 'true' }))['content-disposition']).toMatch(/^attachment/)
        expect((await headersFor({ fileName: 'deck.pdf' }))['content-disposition']).toMatch(/^attachment/)
        expect((await headersFor({ fileName: 'a.svg' }))['content-disposition']).toMatch(/^attachment/)
    })
})
