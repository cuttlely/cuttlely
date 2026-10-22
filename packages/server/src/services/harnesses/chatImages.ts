// The images and files a harness turn returns, as the chat's own artifacts, each as a data URL. Images are PNG and
// JPEG; files are PDF, DOCX, XLSX and CSV and keep their name so the chat can offer them as downloads.
// The streamed run events carry only the names, so the harness canvas chat gets the bytes once, after the run.
// The harness runtime (packages/harness/images.mjs) already checked each file's bytes and size limits.
export type ChatArtifactType = 'png' | 'jpeg' | 'pdf' | 'docx' | 'xlsx' | 'csv'

export interface ChatImage {
    type: ChatArtifactType
    data: string
    name?: string
}

const MIME: Record<string, ChatArtifactType> = {
    'image/png': 'png',
    'image/jpeg': 'jpeg',
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'text/csv': 'csv'
}

const FILE_TYPES = new Set<ChatArtifactType>(['pdf', 'docx', 'xlsx', 'csv'])
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

// The last path part, with anything but letters, digits, dot, dash and underscore replaced.
export function artifactFileName(name: unknown, type: ChatArtifactType): string {
    const base = (typeof name === 'string' ? name : '').split('/').pop() || ''
    const safe = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '')
    return (safe || `file.${type}`).slice(-120)
}

export function chatImages(artifacts: unknown): ChatImage[] {
    if (!Array.isArray(artifacts)) return []
    const images: ChatImage[] = []
    for (const item of artifacts) {
        const mime = typeof item?.mime === 'string' ? item.mime : ''
        const type = MIME[mime]
        if (!type || item?.type !== type || typeof item?.base64 !== 'string' || !BASE64.test(item.base64)) continue
        const artifact: ChatImage = { type, data: `data:${mime};base64,${item.base64}` }
        if (FILE_TYPES.has(type)) artifact.name = artifactFileName(item.name, type)
        images.push(artifact)
    }
    return images
}
