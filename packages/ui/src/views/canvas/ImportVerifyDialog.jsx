import { useEffect, useRef, useState } from 'react'
import PropTypes from 'prop-types'
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Stack, TextField, Typography } from '@mui/material'
import chatflowsApi from '@/api/chatflows'
import flowDraftsApi from '@/api/flowDrafts'
import importVerifyApi from '@/api/importVerify'
import { harnessNameFrom } from '@/utils/buildWithAI'
import { requestFailureMessage } from '@/utils/errorSummary'
import {
    PLACEHOLDER_FLOW,
    connectionNeedsChoice,
    deliverImportedDraft,
    draftStatusWhenImportUnknown,
    importDraftSaveOptions,
    progressLine,
    shouldReplaceDraft,
    showResume,
    statusTitle,
    untrustFlow,
    verificationFlowId
} from '@/utils/importVerify'

const ImportVerifyDialog = ({
    open,
    onClose,
    chatflow,
    flowType = 'CHATFLOW',
    onPublished,
    onImported,
    onFlowCreated,
    onDraftStatus,
    onDraftUnavailable,
    expectedDraftHash,
    draftStatus,
    canvasDirty = false
}) => {
    const [fileName, setFileName] = useState('')
    const [flowText, setFlowText] = useState('')
    const [name, setName] = useState('')
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)
    const [record, setRecord] = useState(null)
    const [draftStatusFailed, setDraftStatusFailed] = useState(false)
    const [chatflowId, setChatflowId] = useState(chatflow?.id || '')
    const [choices, setChoices] = useState({})
    const adoptedId = useRef('')
    const openRef = useRef(open)
    const dirtyRef = useRef(canvasDirty === true)
    const closedWhileRunning = useRef(false)

    useEffect(() => {
        if (chatflow?.id) setChatflowId(chatflow.id)
    }, [chatflow?.id])

    useEffect(() => {
        openRef.current = open
        dirtyRef.current = canvasDirty === true
    }, [open, canvasDirty])

    useEffect(() => {
        const id = chatflow?.id || chatflowId
        if (!open || !id) return undefined
        let cancelled = false
        importVerifyApi
            .status(id)
            .then((response) => {
                const data = response?.data
                if (!cancelled && data?.status && data.status !== 'idle') setRecord(data)
            })
            .catch(() => undefined)
        return () => {
            cancelled = true
        }
    }, [open, chatflow?.id, chatflowId])

    const reset = () => {
        setFileName('')
        setFlowText('')
        setName('')
        setError('')
        setBusy(false)
        setRecord(null)
        setDraftStatusFailed(false)
        setChoices({})
        setChatflowId(chatflow?.id || adoptedId.current || '')
    }

    const publishHash = typeof record?.draftHash === 'string' ? record.draftHash : ''
    const draftKnown = Boolean(draftStatus?.mode) && draftStatus.mode !== 'unknown' && !draftStatusFailed

    const close = () => {
        if (busy) closedWhileRunning.current = true
        onClose()
        if (!busy) reset()
    }

    const mayPaint = () => openRef.current && !closedWhileRunning.current && !dirtyRef.current

    const showImported = async (id, fallback) => {
        let saved = fallback
        let status = null
        try {
            const response = await flowDraftsApi.getStatus(id)
            status = response?.data || null
            const stored = status?.draft?.flowData
            if (typeof stored === 'string' && stored) saved = stored
        } catch {
            // The file already written to the draft is enough to replace the canvas.
        }
        const delivered = deliverImportedDraft({ status, flowText: saved, onDraftStatus, onImported })
        setDraftStatusFailed(!status || typeof status !== 'object')
        if (!status || typeof status !== 'object') {
            if (onDraftUnavailable) onDraftUnavailable(draftStatusWhenImportUnknown(id))
            setError(
                fallback
                    ? 'The draft was saved, but its status could not be loaded. The canvas was not changed. Reload this flow before you save.'
                    : 'The draft status could not be loaded. The canvas was not changed. Reload this flow before you save.'
            )
        }
        return delivered
    }

    const onFile = (event) => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (!file) return
        setFileName(file.name)
        setError('')
        setRecord(null)
        const reader = new FileReader()
        reader.onload = () => {
            try {
                const parsed = JSON.parse(String(reader.result || ''))
                const graph = parsed?.flowData ? JSON.parse(parsed.flowData) : parsed?.flow || parsed
                if (!graph || !Array.isArray(graph.nodes)) {
                    setFlowText('')
                    setError('That file is not a flow.')
                    return
                }
                setFlowText(JSON.stringify(untrustFlow(graph)))
                if (!name) setName(String(parsed.name || file.name.replace(/\.json$/i, '') || 'Imported flow'))
            } catch {
                setFlowText('')
                setError('That file is not a flow.')
            }
        }
        reader.readAsText(file)
    }

    const ensureFlow = async (saveFile) => {
        const id = verificationFlowId(chatflow?.id, chatflowId)
        if (id) {
            if (saveFile && flowText) {
                const loaded = typeof expectedDraftHash === 'function' ? expectedDraftHash() : {}
                await flowDraftsApi.saveDraft(id, flowText, importDraftSaveOptions(loaded))
            }
            if (id !== chatflowId) setChatflowId(id)
            return id
        }
        const typed = name.trim() || 'Imported flow'
        const savedName = flowType === 'HARNESS' ? harnessNameFrom(typed) : typed
        const body = { name: savedName, type: flowType, deployed: false, flowData: PLACEHOLDER_FLOW }
        if (flowType === 'HARNESS') body.draftFlowData = flowText
        const created = await chatflowsApi.createNewChatflow(body)
        const createdId = created?.data?.id
        if (!createdId) throw new Error('The flow was not created.')
        await flowDraftsApi.saveDraft(createdId, flowText)
        const adopted = {
            ...(created.data || {}),
            id: createdId,
            name: created.data?.name || savedName,
            type: created.data?.type || flowType
        }
        adoptedId.current = createdId
        setChatflowId(createdId)
        if (onFlowCreated) await onFlowCreated(adopted)
        return createdId
    }

    const run = async (extra = {}) => {
        setBusy(true)
        setError('')
        try {
            const replaceDraft = shouldReplaceDraft({
                flowText,
                retryFailures: extra.retryFailures,
                choices: extra.choices,
                resume: extra.resume
            })
            closedWhileRunning.current = false
            const id = await ensureFlow(replaceDraft)
            if (replaceDraft && flowText && openRef.current && !closedWhileRunning.current) await showImported(id, flowText)
            const pending = importVerifyApi.start(id, extra)
            const timer = setInterval(() => {
                importVerifyApi
                    .status(id)
                    .then((response) => {
                        if (response?.data?.status && response.data.status !== 'idle') setRecord(response.data)
                    })
                    .catch(() => undefined)
            }, 700)
            try {
                const response = await pending
                if (!mayPaint()) return
                if (response?.data) setRecord(response.data)
                await showImported(id, replaceDraft ? flowText : '')
            } finally {
                clearInterval(timer)
            }
        } catch (err) {
            setError(requestFailureMessage(err))
        } finally {
            setBusy(false)
        }
    }

    const unresolved = (record?.connections || []).filter(connectionNeedsChoice)
    const retryable = (record?.queries || []).some((item) => item.state === 'failed')
    const flowId = verificationFlowId(chatflow?.id, chatflowId)
    const title = statusTitle(record?.status)

    return (
        <Dialog fullWidth maxWidth='sm' open={open} onClose={close} aria-labelledby='import-verify-title'>
            <DialogTitle id='import-verify-title'>Import & verify</DialogTitle>
            <DialogContent>
                <Stack sx={{ gap: 1.5, pt: 0.5 }}>
                    <Typography variant='body2'>
                        Choose a flow file. Cuttlely keeps the queries, checks them on this server, and leaves the published version alone.
                        You do not enter sample values.
                    </Typography>
                    <Button variant='outlined' component='label' sx={{ textTransform: 'none', alignSelf: 'flex-start' }}>
                        Choose file
                        <input type='file' hidden accept='.json,application/json' onChange={onFile} />
                    </Button>
                    {fileName ? (
                        <Typography variant='caption' color='text.secondary'>
                            {fileName}
                        </Typography>
                    ) : null}
                    {!chatflow?.id && (
                        <TextField label='Name' value={name} onChange={(event) => setName(event.target.value)} size='small' fullWidth />
                    )}
                    {record && (
                        <Alert severity={record.status === 'ready' ? 'success' : record.status === 'attention' ? 'warning' : 'info'}>
                            <strong>{title}.</strong> {record.summary || progressLine(record)}
                        </Alert>
                    )}
                    {unresolved.map((slot) => (
                        <TextField
                            key={slot.slotId}
                            select
                            label={slot.nodeLabel || 'Connection'}
                            value={choices[slot.slotId] || ''}
                            onChange={(event) => setChoices((current) => ({ ...current, [slot.slotId]: event.target.value }))}
                            helperText='Choose a connection saved on this server. Secrets stay in Credentials.'
                            size='small'
                            fullWidth
                        >
                            {(slot.options || []).map((option) => (
                                <MenuItem key={option.id} value={option.id}>
                                    {option.name}
                                </MenuItem>
                            ))}
                        </TextField>
                    ))}
                    {(record?.blockers || []).map((item) => (
                        <Typography key={item.id} variant='body2'>
                            {item.message}
                        </Typography>
                    ))}
                    {error ? <Alert severity='error'>{error}</Alert> : null}
                </Stack>
            </DialogContent>
            <DialogActions>
                <Button onClick={close}>Close</Button>
                {unresolved.length > 0 && (
                    <Button variant='contained' disabled={busy} onClick={() => run({ choices })}>
                        Choose connection
                    </Button>
                )}
                {retryable && (
                    <Button variant='outlined' disabled={busy} onClick={() => run({ retryFailures: true, choices, resume: true })}>
                        Retry
                    </Button>
                )}
                {showResume(record) && (
                    <Button variant='outlined' disabled={busy} data-testid='import-verify-resume' onClick={() => run({ resume: true })}>
                        Resume
                    </Button>
                )}
                {record?.publishOffered && publishHash && draftKnown && (
                    <Button
                        variant='contained'
                        disabled={busy}
                        onClick={async () => {
                            setBusy(true)
                            try {
                                const published = await flowDraftsApi.publish(flowId, {
                                    expectedDraftHash: publishHash,
                                    strictDraftHash: true
                                })
                                if (onPublished) onPublished(published?.data)
                            } catch (err) {
                                setError(requestFailureMessage(err))
                            } finally {
                                setBusy(false)
                            }
                        }}
                    >
                        Publish
                    </Button>
                )}
                {!record && unresolved.length === 0 && (
                    <Button variant='contained' disabled={busy || !flowText} onClick={() => run({})}>
                        Import & verify
                    </Button>
                )}
            </DialogActions>
        </Dialog>
    )
}

ImportVerifyDialog.propTypes = {
    open: PropTypes.bool,
    onClose: PropTypes.func,
    chatflow: PropTypes.object,
    flowType: PropTypes.string,
    onPublished: PropTypes.func,
    onImported: PropTypes.func,
    onFlowCreated: PropTypes.func,
    onDraftStatus: PropTypes.func,
    onDraftUnavailable: PropTypes.func,
    expectedDraftHash: PropTypes.func,
    draftStatus: PropTypes.object,
    canvasDirty: PropTypes.bool
}

export default ImportVerifyDialog
