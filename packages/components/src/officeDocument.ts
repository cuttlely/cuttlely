import { parseOfficeAsync } from 'officeparser'

const ZIP_LOCAL_FILE_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04])

/**
 * Extracts the text of a .docx or .pptx upload. Both are ZIP packages, so anything that does not start with a ZIP
 * header is refused before officeparser sees it. officeparser guesses a buffer's type with file-type 16, whose
 * ASF parser can loop forever on a crafted file (GHSA-5v7r-6r5c-r473); a ZIP never reaches that parser.
 */
export async function parseOfficeDocument(raw: Buffer, kind: 'Word' | 'PowerPoint'): Promise<string> {
    if (!Buffer.isBuffer(raw) || raw.length < 4 || !raw.subarray(0, 4).equals(ZIP_LOCAL_FILE_HEADER)) {
        throw new Error(`This is not a ${kind} file. Upload a ${kind === 'Word' ? '.docx' : '.pptx'} file.`)
    }
    const text = await parseOfficeAsync(raw)
    return typeof text === 'string' ? text : ''
}
