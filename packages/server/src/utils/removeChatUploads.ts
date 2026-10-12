import {
    getFilesListFromStorage,
    isChatScopedUploadName,
    removeFilesFromStorage,
    removeSpecificFileFromStorage
} from '@cuttlely/components'

/**
 * Removes every stored upload of these chats in one chatflow: each chat's own folder, and the documents a prediction stored
 * in the chatflow folder under a name that starts with the chat id (chatScopedUploadName). Files of other chats are kept.
 * Returns the storage size after the last removal (undefined when nothing was removed), for the usage counter.
 */
export const removeChatUploads = async (orgId: string, chatflowid: string, chatIds: string[]): Promise<number | undefined> => {
    let totalSize: number | undefined
    const ids = chatIds.filter((id) => typeof id === 'string' && id.length > 0)
    if (!orgId || !chatflowid || !ids.length) return totalSize
    for (const chatId of ids) {
        try {
            totalSize = (await removeFilesFromStorage(orgId, chatflowid, chatId)).totalSize
        } catch {
            // The folder may not exist.
        }
    }
    let names: string[] = []
    try {
        const files = await getFilesListFromStorage(orgId, chatflowid)
        names = [...new Set(files.map((file) => file.name).filter((name) => ids.some((id) => isChatScopedUploadName(id, name))))]
    } catch {
        // No chatflow folder, so no chat-named documents either.
    }
    for (const name of names) {
        try {
            totalSize = (await removeSpecificFileFromStorage(orgId, chatflowid, name)).totalSize
        } catch {
            // Already gone.
        }
    }
    return totalSize
}
