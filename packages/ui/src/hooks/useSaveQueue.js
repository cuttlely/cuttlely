import { createElement, useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@mui/material'
import { useSelector } from 'react-redux'

import { beginReconnect, endReconnect } from '@/api/connectionState'
import { CREATE_STATUS_NOTICE, createSaveQueue, SAVE_RETRY_NOTICE } from '@/utils/saveQueue'
import useDraftSave from './useDraftSave'

const NOTICE_KEY = 'canvas-save-waiting'
const CREATE_NOTICE_KEY = 'canvas-create-status-waiting'

export default function useSaveQueue({ chatflowsApi, flowDraftsApi, dispatch, enqueueSnackbar, closeSnackbar }) {
    const userId = useSelector((state) => state.auth?.user?.id)
    const draftSave = useDraftSave()
    const draftSaveRef = useRef(draftSave)
    const userIdRef = useRef(userId)
    const mountedRef = useRef(false)
    const noticeOpenRef = useRef(null)
    const queueRef = useRef(null)
    const [busy, setBusy] = useState(false)

    draftSaveRef.current = draftSave
    userIdRef.current = userId

    const makeQueue = useCallback(() => {
        const showRetryNotice = (key, message) => {
            if (!mountedRef.current || noticeOpenRef.current) return
            noticeOpenRef.current = key
            dispatch(
                enqueueSnackbar({
                    message,
                    options: {
                        key,
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
        }
        return createSaveQueue({
            putDraft: flowDraftsApi.saveDraft,
            getDraftStatus: flowDraftsApi.getStatus,
            putLive: chatflowsApi.updateChatflow,
            getLive: chatflowsApi.getSpecificChatflow,
            beginReconnect,
            endReconnect,
            onExhausted: () => showRetryNotice(NOTICE_KEY, SAVE_RETRY_NOTICE),
            onCreateStatusWaiting: () => showRetryNotice(CREATE_NOTICE_KEY, CREATE_STATUS_NOTICE),
            onResolved: () => {
                if (!mountedRef.current || !noticeOpenRef.current) return
                const key = noticeOpenRef.current
                noticeOpenRef.current = null
                dispatch(closeSnackbar(key))
            },
            onBusyChange: (next) => {
                if (mountedRef.current) setBusy(next)
            }
        })
    }, [chatflowsApi, closeSnackbar, dispatch, enqueueSnackbar, flowDraftsApi])

    useEffect(() => {
        mountedRef.current = true
        setBusy(false)
        const queue = makeQueue()
        queueRef.current = queue
        const online = () => queueRef.current?.retry()
        window.addEventListener('online', online)
        return () => {
            window.removeEventListener('online', online)
            if (mountedRef.current && noticeOpenRef.current) dispatch(closeSnackbar(noticeOpenRef.current))
            noticeOpenRef.current = null
            mountedRef.current = false
            queue.dispose()
            if (queueRef.current === queue) queueRef.current = null
        }
    }, [closeSnackbar, dispatch, makeQueue])

    const wrapDraft = useCallback((entry, recordedStatus) => {
        const snapshot = recordedStatus
            ? {
                  recorded: true,
                  expectedDraftHash: recordedStatus?.draft?.hash ?? null,
                  baseDraftUpdatedDate: recordedStatus?.draft?.updatedDate ?? null,
                  baseFlowData: recordedStatus?.draft?.flowData ?? entry.liveFlowData
              }
            : draftSaveRef.current.snapshot()
        return {
            ...entry,
            kind: 'draft',
            userId: userIdRef.current,
            expectedDraftHash: snapshot.recorded ? snapshot.expectedDraftHash : undefined,
            baseDraftUpdatedDate: snapshot.baseDraftUpdatedDate,
            baseFlowData: snapshot.baseFlowData,
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
        }
    }, [])

    const wrapLive = useCallback(
        (entry) => ({
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
        }),
        []
    )

    const wrapNonReplay = useCallback(
        (entry) => ({
            ...entry,
            kind: 'nonReplay',
            onAck: async (saved, details) => {
                if (mountedRef.current) await entry.onAck?.(saved, details)
            },
            onError: async (error) => {
                if (mountedRef.current) await entry.onError?.(error)
            }
        }),
        []
    )

    const normalizeCreatedEntry = useCallback(
        (entry, status) => {
            if (!entry) return null
            if (entry.kind === 'draft') return wrapDraft(entry, status)
            if (entry.kind === 'live') return wrapLive(entry)
            return wrapNonReplay(entry)
        },
        [wrapDraft, wrapLive, wrapNonReplay]
    )

    const saveDraft = useCallback(
        (entry) => {
            queueRef.current?.enqueue(wrapDraft(entry))
        },
        [wrapDraft]
    )

    const saveLive = useCallback(
        (entry, options = {}) => {
            queueRef.current?.enqueue({ ...wrapLive(entry), internal: options.internal === true })
        },
        [wrapLive]
    )

    const saveCreate = useCallback(
        (entry) => {
            queueRef.current?.enqueue({
                ...wrapNonReplay(entry),
                kind: 'create',
                needsPostCreate: entry.needsPostCreate === true,
                afterCreate: async (created, details) => {
                    let response
                    try {
                        response = await flowDraftsApi.getStatus(created.id)
                    } catch (error) {
                        if (error && typeof error === 'object') error.createStatusReadFailed = true
                        throw error
                    }
                    const status = response?.data ?? response
                    if (status?.mode !== 'draft' && status?.mode !== 'live') {
                        const error = new Error('The save mode is still unknown.')
                        error.saveModeUnknown = true
                        throw error
                    }
                    if (!mountedRef.current) return null
                    draftSaveRef.current.record(status, status?.draft?.flowData || created.flowData)
                    await entry.onStatus?.(status, created)
                    const next = await entry.afterCreate?.(created, status, details)
                    return normalizeCreatedEntry(next, status)
                }
            })
        },
        [flowDraftsApi, normalizeCreatedEntry, wrapNonReplay]
    )

    const runNonReplay = useCallback(
        (entry, options = {}) => {
            queueRef.current?.enqueue({ ...wrapNonReplay(entry), internal: options.internal === true })
        },
        [wrapNonReplay]
    )

    return {
        ...draftSave,
        saveDraft,
        saveLive,
        saveCreate,
        runNonReplay,
        retry: () => queueRef.current?.retry(),
        busy
    }
}
