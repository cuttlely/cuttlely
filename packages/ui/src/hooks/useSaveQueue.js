import { createElement, useCallback, useEffect, useRef } from 'react'
import { Button } from '@mui/material'
import { useSelector } from 'react-redux'

import { beginReconnect, endReconnect } from '@/api/connectionState'
import { createSaveQueue, SAVE_RETRY_NOTICE } from '@/utils/saveQueue'
import useDraftSave from './useDraftSave'

const NOTICE_KEY = 'canvas-save-waiting'

export default function useSaveQueue({ chatflowsApi, flowDraftsApi, dispatch, enqueueSnackbar, closeSnackbar }) {
    const userId = useSelector((state) => state.auth?.user?.id)
    const draftSave = useDraftSave()
    const draftSaveRef = useRef(draftSave)
    const userIdRef = useRef(userId)
    const mountedRef = useRef(false)
    const noticeOpenRef = useRef(false)
    const queueRef = useRef(null)

    draftSaveRef.current = draftSave
    userIdRef.current = userId

    const makeQueue = useCallback(
        () =>
            createSaveQueue({
                putDraft: flowDraftsApi.saveDraft,
                getDraftStatus: flowDraftsApi.getStatus,
                putLive: chatflowsApi.updateChatflow,
                getLive: chatflowsApi.getSpecificChatflow,
                beginReconnect,
                endReconnect,
                onExhausted: () => {
                    if (!mountedRef.current || noticeOpenRef.current) return
                    noticeOpenRef.current = true
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
                    if (!mountedRef.current || !noticeOpenRef.current) return
                    noticeOpenRef.current = false
                    dispatch(closeSnackbar(NOTICE_KEY))
                }
            }),
        [chatflowsApi, closeSnackbar, dispatch, enqueueSnackbar, flowDraftsApi]
    )

    useEffect(() => {
        mountedRef.current = true
        const queue = makeQueue()
        queueRef.current = queue
        const online = () => queueRef.current?.retry()
        window.addEventListener('online', online)
        return () => {
            window.removeEventListener('online', online)
            if (mountedRef.current && noticeOpenRef.current) dispatch(closeSnackbar(NOTICE_KEY))
            noticeOpenRef.current = false
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
                    const response = await flowDraftsApi.getStatus(created.id)
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
        retry: () => queueRef.current?.retry()
    }
}
