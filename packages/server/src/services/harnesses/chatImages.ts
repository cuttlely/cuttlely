// The images a harness turn returns, as the chat's own artifacts: PNG and JPEG only, each as a data URL.
// The streamed run events carry only the image names, so the harness canvas chat gets the bytes once, after the run.
export interface ChatImage {
    type: 'png' | 'jpeg'
    data: string
}

const MIME: Record<string, ChatImage['type']> = { 'image/png': 'png', 'image/jpeg': 'jpeg' }

export function chatImages(artifacts: unknown): ChatImage[] {
    if (!Array.isArray(artifacts)) return []
    const images: ChatImage[] = []
    for (const item of artifacts) {
        const mime = typeof item?.mime === 'string' ? item.mime : ''
        const type = MIME[mime]
        if (!type || typeof item?.base64 !== 'string' || !item.base64) continue
        images.push({ type, data: `data:${mime};base64,${item.base64}` })
    }
    return images
}
