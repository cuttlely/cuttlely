import { createElement, useCallback, useEffect, useRef } from 'react'
import { Button } from '@mui/material'
import { useDispatch, useSelector } from 'react-redux'

import chatflowsApi from '@/api/chatflows'
import flowDraftsApi from '@/api/flowDrafts'
import { beginReconnect, endReconnect } from '@/api/connectionState'
import { closeSnackbar, enqueueSnackbar } from '@/store/actions'
import { createSaveQueue, SAVE_RETRY_NOTICE } from '@/utils/saveQueue'
import useDraftSave from './useDraftSave'

const NOTICE_KEY = 'canvas-save-waiting'

export default function useSaveQueue() {
    const dispatch = useDispatch()
    const userId = useSelector((state) => state.auth?.user?.id)
    const draftSave = useDraftSave()
    const draftSaveRef = useRef(draftSave)
    const userIdRef = useRef(userId)
    const mountedRef = useRef(true)
    const queueRef = useRef(null)

    draftSaveRef.current = draftSave
    userIdRef.current = userId

    if (!queueRef.current) {
        queueRef.current = createSaveQueue({
            putDraft: flowDraftsApi.saveDraft,
            getDraftStatus: flowDraftsApi.getStatus,
            putLive: chatflowsApi.updateChatflow,
            getLive: chatflowsApi.getSpecificChatflow,
            beginReconnect,
            endReconnect,
            onExhausted: () => {
                if (!mountedRef.current) return
                dispatch(
                    enqueueSnackbar({
                        message: SAVE_RETRY_NOTICE,
                        options: {
                            key: NOTICE_KEY,
                            variant: 'warning',
                            persist: true,
                            action: () =>
                                createElement(
                                    Button,
                                    {
                                        style: { color: 'white' },
                                        onClick: () => queueRef.current?.retry()
                                    },
                                    'Retry'
                                )
                        }
                    })
                )
            },
            onResolved: () => {
                if (mountedRef.current) dispatch(closeSnackbar(NOTICE_KEY))
            }
        })
    }

    useEffect(() => {
        const online = () => queueRef.current?.retry()
        window.addEventListener('online', online)
        return () => {
            mountedRef.current = false
            window.removeEventListener('online', online)
            queueRef.current?.dispose()
        }
    }, [])

    const saveDraft = useCallback((entry) => {
        const base = draftSaveRef.current.snapshot()
        queueRef.current.enqueue({
            ...entry,
            kind: 'draft',
            userId: userIdRef.current,
            expectedDraftHash: base.recorded ? base.expectedDraftHash : undefined,
            baseDraftUpdatedDate: base.baseDraftUpdatedDate,
            baseFlowData: base.baseFlowData,
            onAck: async (status, details) => {
                draftSaveRef.current.record(status, status?.draft?.flowData || entry.flowData)
                if (mountedRef.current) await entry.onAck?.(status, details)
            },
            onConflict: async (found, status) => {
                if (!mountedRef.current) return
                await draftSaveRef.current.openConflict(entry.id, found, entry.flowData)
                await entry.onConflict?.(found, status)
            },
            onError: async (error) => {
                if (mountedRef.current) await entry.onError?.(error)
            }
        })
    }, [])

    const saveLive = useCallback((entry) => {
        queueRef.current.enqueue({
            ...entry,
            kind: 'live',
            onAck: async (flow, details) => {
                if (mountedRef.current) await entry.onAck?.(flow, details)
            },
            onChanged: async (flow) => {
                if (mountedRef.current) await entry.onChanged?.(flow)
            },
            onError: async (error) => {
                if (mountedRef.current) await entry.onError?.(error)
            }
        })
    }, [])

    const waitForNonReplay = useCallback((entry) => {
        queueRef.current.enqueue({ ...entry, kind: 'create' })
    }, [])

    return {
        ...draftSave,
        saveDraft,
        saveLive,
        waitForNonReplay,
        retry: () => queueRef.current?.retry()
    }
}
