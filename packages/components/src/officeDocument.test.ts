const parseOfficeAsync = jest.fn(async () => 'slide text')
jest.mock('officeparser', () => ({ parseOfficeAsync: (...args: unknown[]) => (parseOfficeAsync as any)(...args) }))

import { parseOfficeDocument } from './officeDocument'

// The first bytes of an ASF (WMV/WMA) file: the header object GUID.
const ASF_HEADER = Buffer.from('3026b2758e66cf11a6d900aa0062ce6c', 'hex')

describe('parseOfficeDocument', () => {
    beforeEach(() => parseOfficeAsync.mockClear())

    it('passes a ZIP package to officeparser', async () => {
        const docx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(32)])
        await expect(parseOfficeDocument(docx, 'PowerPoint')).resolves.toBe('slide text')
        expect(parseOfficeAsync).toHaveBeenCalledWith(docx)
    })

    it('refuses an ASF file before officeparser guesses its type', async () => {
        await expect(parseOfficeDocument(Buffer.concat([ASF_HEADER, Buffer.alloc(64)]), 'Word')).rejects.toThrow(
            'This is not a Word file. Upload a .docx file.'
        )
        expect(parseOfficeAsync).not.toHaveBeenCalled()
    })

    it('refuses empty and short input', async () => {
        await expect(parseOfficeDocument(Buffer.alloc(0), 'Word')).rejects.toThrow('not a Word file')
        await expect(parseOfficeDocument(Buffer.from('PK'), 'PowerPoint')).rejects.toThrow('Upload a .pptx file')
        expect(parseOfficeAsync).not.toHaveBeenCalled()
    })
})
