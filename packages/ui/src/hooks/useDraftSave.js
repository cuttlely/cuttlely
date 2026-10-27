import { useCallback, useRef, useState } from 'react'
import flowDraftsApi from '@/api/flowDrafts'
import { draftConflictFrom, draftVersion } from '@/utils/flowDrafts'

// One recorded draft version for every canvas. The next save sends it back so the server can
// tell whether someone else saved since this canvas opened.
export default function useDraftSave() {
    const versionRef = useRef(null)
    const recordedRef = useRef(false)
    const [conflict, setConflict] = useState(null)

    const record = useCallback((status) => {
        versionRef.current = draftVersion(status)
        recordedRef.current = true
    }, [])

    const dismiss = useCallback(() => setConflict(null), [])

    const save = useCallback(
        async (chatflowId, flowData, options = {}) => {
            const request = {}
            if (recordedRef.current) request.expectedDraftHash = versionRef.current
            if (options && options.overwriteDraftChanges === true) request.overwriteDraftChanges = true
            try {
                const response = await flowDraftsApi.saveDraft(chatflowId, flowData, request)
                record(response?.data)
                return response
            } catch (error) {
                const found = draftConflictFrom(error)
                if (found) {
                    setConflict(found)
                    return { conflict: found }
                }
                throw error
            }
        },
        [record]
    )

    return { record, save, conflict, dismiss }
}
