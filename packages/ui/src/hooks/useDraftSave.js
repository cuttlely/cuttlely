import { useCallback, useRef, useState } from 'react'
import flowDraftsApi from '@/api/flowDrafts'
import { draftConflictFrom, draftVersion } from '@/utils/flowDrafts'

// One recorded draft version for every canvas. The next save or publish sends it back so the server
// can tell whether someone else saved since this canvas opened. The canvas text of that version is
// kept too, as the base the conflict review screen compares both sides with.
export default function useDraftSave() {
    const versionRef = useRef(null)
    const baseRef = useRef(null)
    const recordedRef = useRef(false)
    const conflictRef = useRef(0)
    const [conflict, setConflict] = useState(null)

    // baseText is the canvas this version holds. It defaults to the status draft, which is right after a
    // load or a save. A status with no draft means the canvas started from Live, so pass Live's text then.
    const record = useCallback((status, baseText) => {
        versionRef.current = draftVersion(status)
        const text = typeof baseText === 'string' && baseText ? baseText : status?.draft?.flowData
        baseRef.current = typeof text === 'string' && text ? text : null
        recordedRef.current = true
    }, [])

    const dismiss = useCallback(() => {
        conflictRef.current += 1
        setConflict(null)
    }, [])

    // What a publish sends: the recorded hash, once the canvas has one.
    const expected = useCallback(() => (recordedRef.current ? { expectedDraftHash: versionRef.current } : {}), [])

    // Shows the review screen for a 409 and reads the draft the other person saved.
    // mine is the open editor's canvas text, unsaved edits included.
    const openConflict = useCallback(async (chatflowId, found, mine) => {
        const generation = ++conflictRef.current
        const base = baseRef.current
        setConflict({ ...found, mine: typeof mine === 'string' ? mine : null, base, theirs: null, loading: true })
        let theirs = null
        try {
            const res = await flowDraftsApi.getStatus(chatflowId)
            const status = res?.data
            const text = status?.draft?.flowData
            if (typeof text === 'string' && text) theirs = { flowData: text, hash: draftVersion(status), status }
        } catch {
            theirs = null
        }
        if (conflictRef.current !== generation) return
        setConflict((current) => (current ? { ...current, theirs, loading: false } : current))
    }, [])

    // After the merge is applied: the editor now builds on the draft they saved, so the next save sends
    // that draft's hash.
    const adopt = useCallback((theirs) => {
        if (!theirs) return
        versionRef.current = theirs.hash ?? null
        baseRef.current = typeof theirs.flowData === 'string' ? theirs.flowData : null
        recordedRef.current = true
    }, [])

    const save = useCallback(
        async (chatflowId, flowData, options = {}) => {
            const request = {}
            if (recordedRef.current) request.expectedDraftHash = versionRef.current
            if (options && options.overwriteDraftChanges === true) request.overwriteDraftChanges = true
            try {
                const response = await flowDraftsApi.saveDraft(chatflowId, flowData, request)
                // A save equal to Live clears the draft, so the base is then the canvas just sent.
                record(response?.data, response?.data?.draft?.flowData || flowData)
                return response
            } catch (error) {
                const found = draftConflictFrom(error)
                if (found) {
                    openConflict(chatflowId, found, flowData)
                    return { conflict: found }
                }
                throw error
            }
        },
        [record, openConflict]
    )

    return { record, save, conflict, dismiss, expected, openConflict, adopt }
}
