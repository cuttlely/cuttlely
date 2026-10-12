const removeSpecificFileFromUpload = jest.fn().mockResolvedValue(undefined)

jest.mock('@cuttlely/components', () => ({
    ...jest.requireActual('@cuttlely/components'),
    removeSpecificFileFromUpload: (filePath: string) => removeSpecificFileFromUpload(filePath)
}))

import { assertPredictionUploadsAllowed, getUploadPermissions } from './uploadPermissions'

type Flow = { flowData: string; speechToText?: string; chatbotConfig?: string; apiConfig?: string }

const node = (id: string, name: string, category: string, inputs: Record<string, unknown> = {}, inputParams: unknown[] = []) => ({
    id,
    data: { id, name, category, inputs, inputParams }
})

const chain = node('llmChain_0', 'llmChain', 'Chains')
const visionModel = node('chatOpenAI_0', 'chatOpenAI', 'Chat Models', { allowImageUploads: true }, [{ name: 'allowImageUploads' }])
const plainModel = node('chatOpenAI_0', 'chatOpenAI', 'Chat Models', { allowImageUploads: false }, [{ name: 'allowImageUploads' }])
const ragStore = node('memoryVectorStore_0', 'memoryVectorStore', 'Vector Stores', { fileUpload: true })
const pdfLoader = node('pdfFile_0', 'pdfFile', 'Document Loaders', {}, [{ name: 'pdfFile', type: 'file', fileType: '.pdf, .txt' }])
const ragEdge = {
    id: 'e1',
    source: 'pdfFile_0',
    target: 'memoryVectorStore_0',
    targetHandle: 'memoryVectorStore_0-input-document-Document'
}

const flowOf = (nodes: unknown[], edges: unknown[] = [], extra: Partial<Flow> = {}): Flow => ({
    flowData: JSON.stringify({ nodes, edges }),
    ...extra
})

const uploadsOff = flowOf([chain, plainModel])
const imagesOn = flowOf([chain, visionModel])
const speechOn = flowOf([chain, plainModel], [], { speechToText: JSON.stringify({ openAIWhisper: { status: true } }) })
const fullFileOn = flowOf([chain, plainModel], [], {
    chatbotConfig: JSON.stringify({ fullFileUpload: { status: true, allowedUploadFileTypes: 'text/csv,text/plain' } })
})
const ragOn = flowOf([chain, plainModel, ragStore, pdfLoader], [ragEdge])

const b64 = (text: string) => Buffer.from(text).toString('base64')
const image = { type: 'file', name: 'cake.png', mime: 'image/png', data: 'data:image/png;base64,iVBORw0KGgo=' }
const svg = { type: 'file', name: 'cake.svg', mime: 'image/svg+xml', data: `data:image/svg+xml;base64,${b64('<svg/>')}` }
const recording = { type: 'audio', name: 'order.webm', mime: 'audio/webm', data: 'data:audio/webm;base64,GkXfow==' }
const csvBody = { type: 'file', name: 'orders.csv', mime: 'text/csv', data: `data:text/csv;base64,${b64('item,qty\nsourdough,3')}` }
const csvFull = { ...csvBody, type: 'file:full' }
const pdfFull = { type: 'file:full', name: 'menu.pdf', mime: 'application/pdf', data: `data:application/pdf;base64,${b64('%PDF-1.4')}` }
const imageUrl = { type: 'url', name: 'cake.png', mime: 'image/png', data: 'https://bakery.example/cake.png' }
const ragPdf = { type: 'file:rag', name: 'menu.pdf', mime: 'application/pdf', data: `data:application/pdf;base64,${b64('%PDF-1.4')}` }
const ragExe = { type: 'file:rag', name: 'oven.exe', mime: 'application/octet-stream', data: 'data:application/octet-stream;base64,TVo=' }
const storedRef = { type: 'stored-file', name: 'cake.png', mime: 'image/png' }

const multipart = (originalname: string, mimetype: string) => ({ originalname, mimetype, path: `/tmp/upload-${originalname}` })

const refusal = async (flow: Flow, uploads: unknown, files?: ReturnType<typeof multipart>[]) => {
    try {
        await assertPredictionUploadsAllowed(flow as never, uploads, files)
    } catch (error: any) {
        return { status: error.statusCode, message: error.message }
    }
    return null
}

describe('prediction uploads follow the flow upload settings', () => {
    beforeEach(() => removeSpecificFileFromUpload.mockClear())

    it('reads the same settings the chat UI shows', () => {
        expect(getUploadPermissions(uploadsOff as never)).toMatchObject({
            imageTypes: [],
            speechToText: false,
            ragExtensions: null,
            fullFile: false
        })
        expect(getUploadPermissions(imagesOn as never).imageTypes).toEqual(['image/gif', 'image/jpeg', 'image/png', 'image/webp'])
        expect(getUploadPermissions(ragOn as never).ragExtensions).toEqual(['.pdf', '.txt'])
        expect(getUploadPermissions(fullFileOn as never).fullFile).toBe(true)
        expect(getUploadPermissions(speechOn as never).speechToText).toBe(true)
    })

    it('refuses every kind of upload when the flow has uploads off', async () => {
        expect(await refusal(uploadsOff, [image])).toEqual({ status: 403, message: 'Image uploads are not turned on for this flow' })
        expect(await refusal(uploadsOff, [imageUrl])).toEqual({ status: 403, message: 'Image uploads are not turned on for this flow' })
        expect(await refusal(uploadsOff, [recording])).toEqual({ status: 403, message: 'Audio uploads are not turned on for this flow' })
        expect(await refusal(uploadsOff, [csvBody])).toEqual({ status: 403, message: 'File uploads are not turned on for this flow' })
        expect(await refusal(uploadsOff, [csvFull])).toEqual({ status: 403, message: 'File uploads are not turned on for this flow' })
        expect(await refusal(uploadsOff, [ragPdf])).toEqual({ status: 403, message: 'File uploads are not turned on for this flow' })
        expect(await refusal(uploadsOff, [], [multipart('orders.csv', 'text/csv')])).toEqual({
            status: 403,
            message: 'File uploads are not turned on for this flow'
        })
        expect(await refusal(uploadsOff, [{ ...image, type: 'mystery' }])).toEqual({
            status: 400,
            message: "Upload type 'mystery' is not supported"
        })
    })

    it('removes the multipart temp files of a refused request, including ones that would have passed', async () => {
        const files = [multipart('orders.csv', 'text/csv'), multipart('notes.txt', 'text/plain')]
        expect(await refusal(uploadsOff, [image], files)).toMatchObject({ status: 403 })
        expect(removeSpecificFileFromUpload.mock.calls.map(([p]) => p)).toEqual(['/tmp/upload-orders.csv', '/tmp/upload-notes.txt'])
    })

    it('takes images of the allowed types when image uploads are on, and nothing else', async () => {
        expect(await refusal(imagesOn, [image, imageUrl, { ...image, mime: 'image/jpg', data: 'data:image/jpg;base64,/9j/' }])).toBeNull()
        expect(await refusal(imagesOn, [svg])).toEqual({ status: 400, message: "File type 'image/svg+xml' is not allowed for this flow" })
        expect(await refusal(imagesOn, [csvBody])).toEqual({ status: 403, message: 'File uploads are not turned on for this flow' })
        expect(await refusal(imagesOn, [recording])).toMatchObject({ status: 403 })
        // An audio type on another kind of upload still needs speech to text.
        expect(await refusal(imagesOn, [{ ...imageUrl, mime: 'audio/webm' }])).toEqual({
            status: 403,
            message: 'Audio uploads are not turned on for this flow'
        })
    })

    it('takes recordings only when speech to text is on', async () => {
        expect(await refusal(speechOn, [recording])).toBeNull()
        expect(await refusal(speechOn, [image])).toMatchObject({ status: 403 })
    })

    it('takes documents of the allowed types when full file uploads are on', async () => {
        expect(await refusal(fullFileOn, [csvFull, csvBody])).toBeNull()
        expect(await refusal(fullFileOn, [], [multipart('orders.csv', 'text/csv')])).toBeNull()
        expect(await refusal(fullFileOn, [pdfFull])).toEqual({
            status: 400,
            message: "File type 'application/pdf' is not allowed for this flow"
        })
        expect(await refusal(fullFileOn, [], [multipart('menu.pdf', 'application/pdf')])).toMatchObject({ status: 400 })
        expect(await refusal(fullFileOn, [], [multipart('cake.png', 'image/png')])).toMatchObject({ status: 400 })
        expect(await refusal(fullFileOn, [image])).toMatchObject({ status: 403 })
    })

    it('takes chat files of the vector store types when chat file uploads are on', async () => {
        expect(await refusal(ragOn, [ragPdf])).toBeNull()
        expect(await refusal(ragOn, [ragExe])).toEqual({
            status: 400,
            message: "File type 'application/octet-stream' is not allowed for this flow"
        })
        expect(await refusal(ragOn, [csvFull])).toMatchObject({ status: 403 })
    })

    it('still lets a multipart file fill a document loader the override list allows', async () => {
        const apiConfig = (enabled: boolean, status = true) =>
            JSON.stringify({
                overrideConfig: { status, nodes: { csvFile: [{ label: 'Csv File', name: 'csvFile', type: 'file', enabled }] } }
            })
        const files = [multipart('orders.csv', 'text/csv')]
        expect(await refusal({ ...uploadsOff, apiConfig: apiConfig(true) }, [], files)).toBeNull()
        expect(await refusal({ ...uploadsOff, apiConfig: apiConfig(false) }, [], files)).toMatchObject({ status: 403 })
        expect(await refusal({ ...uploadsOff, apiConfig: apiConfig(true, false) }, [], files)).toMatchObject({ status: 403 })
        expect(removeSpecificFileFromUpload).toHaveBeenCalledTimes(2)
    })

    it('lets requests with no uploads and stored-file references through', async () => {
        expect(await refusal(uploadsOff, undefined)).toBeNull()
        expect(await refusal(uploadsOff, [])).toBeNull()
        expect(await refusal(uploadsOff, [storedRef])).toBeNull()
    })

    it('refuses an uploads field that is not a list', async () => {
        const listOnly = { status: 400, message: 'The uploads field must be a list' }
        expect(await refusal(imagesOn, { not: 'a list' })).toEqual(listOnly)
        expect(await refusal(imagesOn, { length: 1, 0: image })).toEqual(listOnly)
        expect(await refusal(imagesOn, '[]')).toEqual(listOnly)
    })
})
