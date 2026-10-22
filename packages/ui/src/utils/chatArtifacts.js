// Files a harness specialist made (PDF, DOCX, XLSX, CSV) reach the chat as artifacts next to its PNG and JPEG
// images. Images show inline; files are offered as downloads.
export const FILE_ARTIFACT_TYPES = ['pdf', 'docx', 'xlsx', 'csv']

const FILE_DATA_URL = {
    pdf: 'data:application/pdf;base64,',
    docx: 'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,',
    xlsx: 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,',
    csv: 'data:text/csv;base64,'
}

export function isFileArtifact(item) {
    return Boolean(item) && FILE_ARTIFACT_TYPES.includes(item.type)
}

// A stored file (FILE-STORAGE::name) becomes the chat's file link, with download=true so it saves instead of opening.
// A file that is already a link or a data URL is left as it is; fileArtifactHref decides whether it is shown.
export function storedFileArtifactUrl(baseURL, chatflowId, chatId, data) {
    if (typeof data !== 'string' || !data.startsWith('FILE-STORAGE::')) return data
    const params = new URLSearchParams({ chatflowId: chatflowId || '', chatId: chatId || '', fileName: data.replace('FILE-STORAGE::', '') })
    return `${baseURL}/api/v1/get-upload-file?${params.toString()}&download=true`
}

// The link a file artifact may use: this server's file route, or a data URL of the artifact's own type (the harness
// canvas chat). Anything else is not offered.
export function fileArtifactHref(item, baseURL) {
    if (!isFileArtifact(item) || typeof item.data !== 'string') return null
    if (item.data.startsWith(FILE_DATA_URL[item.type]) && /^[A-Za-z0-9+/]+={0,2}$/.test(item.data.slice(FILE_DATA_URL[item.type].length))) {
        return item.data
    }
    if (item.data.startsWith(`${baseURL}/api/v1/get-upload-file?`)) return item.data
    return null
}

// The name to save as: the artifact's own name, or the stored file name without the harness_<specialist>_<time>_<n>_ prefix.
export function fileArtifactName(item) {
    const named = typeof item?.name === 'string' ? item.name : ''
    let stored = ''
    if (!named && typeof item?.data === 'string') {
        const match = /[?&]fileName=([^&]+)/.exec(item.data)
        stored = (match ? decodeURIComponent(match[1]) : item.data.replace(/^FILE-STORAGE::/, '')).replace(
            /^harness_[A-Za-z0-9_-]*?_\d+_\d+_/,
            ''
        )
        if (stored.startsWith('data:')) stored = ''
    }
    const name = (named || stored)
        .split('/')
        .pop()
        .replace(/[^A-Za-z0-9._-]/g, '_')
    return name || `file.${item?.type || 'bin'}`
}
