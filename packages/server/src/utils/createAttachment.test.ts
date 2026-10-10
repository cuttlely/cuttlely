// Refusals are client errors: uploads turned off is 403, a file type the flow does not allow is 400 (API-9).
jest.mock('./getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({
        nodesPool: { componentNodes: { fileLoader: { filePath: 'cuttlely-test-file-loader' } } }
    })
}))
jest.mock('cuttlely-test-file-loader', () => ({ nodeClass: class {} }), { virtual: true })
jest.mock('./authorizeFlowAccess', () => ({
    getAuthorizedChatflow: (req: any) => req.testChatflow,
    hasFlowAccess: jest.fn(async () => true)
}))

import { createFileAttachment } from './createAttachment'
import attachmentsService from '../services/attachments'

const FLOW_ID = '5f2b8c1e-3a4d-4e6f-9a7b-1c2d3e4f5a6b'

const request = (chatbotConfig: object | undefined, files: any[] = []) =>
    ({
        params: { chatflowId: FLOW_ID, chatId: 'chat-1' },
        body: {},
        files,
        user: { activeOrganizationId: 'org-1', activeWorkspaceId: 'ws-1', activeOrganizationSubscriptionId: 'sub-1' },
        testChatflow: { id: FLOW_ID, workspaceId: 'ws-1', chatbotConfig: chatbotConfig ? JSON.stringify(chatbotConfig) : undefined }
    } as any)

const pdf = { originalname: 'report.pdf', mimetype: 'application/pdf', size: 10, path: '/tmp/none' }

describe('upload refusals', () => {
    test('uploads turned off is 403', async () => {
        await expect(createFileAttachment(request(undefined, [pdf]))).rejects.toMatchObject({ statusCode: 403 })
        await expect(createFileAttachment(request({ fullFileUpload: { status: false } }, [pdf]))).rejects.toMatchObject({
            statusCode: 403,
            message: 'File upload is not enabled for this chatflow'
        })
    })

    test('a file type the flow does not allow is 400', async () => {
        const config = { fullFileUpload: { status: true, allowedUploadFileTypes: 'text/plain' } }
        await expect(createFileAttachment(request(config, [pdf]))).rejects.toMatchObject({ statusCode: 400 })
    })

    test('the attachments service keeps those statuses', async () => {
        await expect(attachmentsService.createAttachment(request(undefined, [pdf]))).rejects.toMatchObject({ statusCode: 403 })
        const config = { fullFileUpload: { status: true, allowedUploadFileTypes: 'text/plain' } }
        await expect(attachmentsService.createAttachment(request(config, [pdf]))).rejects.toMatchObject({ statusCode: 400 })
    })
})
