import PropTypes from 'prop-types'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useDispatch } from 'react-redux'

import {
    Alert,
    Box,
    Button,
    Checkbox,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    FormControlLabel,
    Stack,
    Typography
} from '@mui/material'

import flowDraftsApi from '@/api/flowDrafts'
import useConfirm from '@/hooks/useConfirm'
import { useAuth } from '@/hooks/useAuth'
import { GATE_RUN_PERMISSION } from '@/utils/publishCheck'
import { CHANGE_COLORS } from '@/utils/versionHistory'
import { POLL_MS, pollGateCheck } from '@/utils/publishCheck'
import {
    STALE_DRAFT_WARNING,
    apiErrorMessage,
    canvasAfterDiscard,
    canvasAfterPublish,
    datasetGateBlock,
    publishBody,
    publishConflictMessage,
    PUBLISH_CONFLICT_ANYWAY,
    PUBLISH_CONFLICT_REVIEW,
    draftConflictFrom,
    publishChangeLines,
    publishResultMessage,
    showsPublishCheck
} from '@/utils/flowDrafts'
import { enqueueSnackbar as enqueueSnackbarAction } from '@/store/actions'

import PublishCheck from './PublishCheck'

const LINE_COLORS = {
    added: CHANGE_COLORS.added,
    changed: CHANGE_COLORS.changed,
    removed: '#c62828',
    moved: '#6d4c41'
}

export const PublishChangeList = ({ lines }) => (
    <Stack spacing={0.75} data-testid='publish-diff' aria-label='What changed'>
        {lines.length === 0 ? (
            <Typography variant='body2' color='text.secondary'>
                No changes to publish.
            </Typography>
        ) : (
            lines.map((line, index) => (
                <Stack key={`${line.status}-${index}`} direction='row' spacing={1} alignItems='flex-start'>
                    <Box
                        sx={{
                            mt: '6px',
                            width: 10,
                            height: 10,
                            borderRadius: '50%',
                            flexShrink: 0,
                            bgcolor: LINE_COLORS[line.status] || CHANGE_COLORS.changed
                        }}
                    />
                    <Typography variant='body2' sx={{ wordBreak: 'break-word' }}>
                        {line.text}
                    </Typography>
                </Stack>
            ))
        )}
    </Stack>
)

PublishChangeList.propTypes = {
    lines: PropTypes.array
}

export const PublishGateNotice = ({ gate, busy, runAnyway, onRunAnyway, onRun, startBlock, canRun = true }) => {
    if (!gate?.enabled) return null
    if (startBlock) {
        return (
            <Alert severity='warning' data-testid='publish-gate' sx={{ mt: 1.5 }}>
                <Typography variant='body2'>{startBlock}</Typography>
            </Alert>
        )
    }
    const result = gate.result
    const summary = result
        ? `Last result: ${result.passRate == null ? 'unscored' : `${result.passRate}%`} and ${result.verdict} (${result.passed} passed, ${
              result.failed
          } failed, ${result.errored} errored).`
        : 'There is no result for this draft yet.'
    return (
        <Alert severity={gate.block ? 'warning' : 'success'} data-testid='publish-gate' sx={{ mt: 1.5 }}>
            <Typography variant='body2'>{gate.block || 'This draft passed the test set.'}</Typography>
            <Typography variant='body2' sx={{ mt: 0.5 }}>
                {summary}
            </Typography>
            <FormControlLabel
                sx={{ display: 'flex', mt: 0.5 }}
                control={
                    <Checkbox size='small' checked={runAnyway} disabled={busy} onChange={(event) => onRunAnyway(event.target.checked)} />
                }
                label={<Typography variant='body2'>Run steps that could send or write something</Typography>}
            />
            {canRun ? (
                <Button variant='outlined' onClick={onRun} disabled={busy} data-testid='publish-gate-run' sx={{ mt: 1 }}>
                    {busy ? 'Running the test set…' : 'Run the test set'}
                </Button>
            ) : (
                <Typography variant='body2' sx={{ mt: 1 }} data-testid='publish-gate-permission'>
                    {GATE_RUN_PERMISSION}
                </Typography>
            )}
        </Alert>
    )
}

PublishGateNotice.propTypes = {
    gate: PropTypes.object,
    busy: PropTypes.bool,
    runAnyway: PropTypes.bool,
    onRunAnyway: PropTypes.func,
    onRun: PropTypes.func,
    startBlock: PropTypes.string,
    canRun: PropTypes.bool
}

const PublishDialog = ({
    open,
    chatflow,
    draftStatus,
    isDirty,
    onClose,
    onDraftStatus,
    onChatflowUpdated,
    onApplyCanvas,
    draftExpected = () => ({}),
    onDraftConflict = () => undefined
}) => {
    const dispatch = useDispatch()
    const { confirm } = useConfirm()
    const { hasPermission } = useAuth()
    const canRunGate = hasPermission('datasets:view') && hasPermission('evaluators:view')
    const [replaceLiveChanges, setReplaceLiveChanges] = useState(false)
    const [busy, setBusy] = useState(false)
    const [gateBusy, setGateBusy] = useState(false)
    const [runAnyway, setRunAnyway] = useState(false)
    const [error, setError] = useState('')
    // A 409 DRAFT_CHANGED: someone else saved the draft after this canvas loaded it.
    const [publishConflict, setPublishConflict] = useState(null)

    const stale = Boolean(draftStatus?.draft?.stale)
    const replayCheck = showsPublishCheck(chatflow?.type)
    const startBlock =
        replayCheck && draftStatus?.publishGate?.enabled
            ? datasetGateBlock(chatflow?.type, [chatflow?.flowData, draftStatus?.draft?.flowData])
            : null
    const gateBlock = replayCheck && draftStatus?.publishGate?.enabled ? startBlock || draftStatus.publishGate.block : null
    const lines = useMemo(
        () => (open ? publishChangeLines(chatflow?.flowData, draftStatus?.draft?.flowData) : []),
        [open, chatflow?.flowData, draftStatus?.draft?.flowData]
    )

    useEffect(() => {
        if (!open) return
        setReplaceLiveChanges(false)
        setError('')
        setBusy(false)
        setPublishConflict(null)
    }, [open])

    const onStatus = useRef(onDraftStatus)
    onStatus.current = onDraftStatus
    const mounted = useRef(true)
    const gateGeneration = useRef(0)
    useEffect(() => {
        if (!open) {
            // The dialog stays mounted. Bump the generation and clear the busy flag here. The poll's
            // finally still checks the generation, so an older run cannot clear a newer one.
            gateGeneration.current += 1
            setGateBusy(false)
            return undefined
        }
        if (!chatflow?.id) return undefined
        const generation = gateGeneration.current
        let cancelled = false
        // A check that is still running was started before this open. Re-read it instead of keeping
        // the busy flag from the previous open.
        flowDraftsApi
            .getCheckSetup(chatflow.id)
            .then(async (res) => {
                const running = res?.data?.check
                if (cancelled || gateGeneration.current !== generation) return
                // An optional recent-question check must not disable Publish. Only a dataset run
                // that matches the passing-test settings is the gate run.
                if (!running || running.status !== 'running' || !running.id || !running.matchesPublishGate) return
                setGateBusy(true)
                try {
                    const view = await pollGateCheck({
                        view: running,
                        pollMs: POLL_MS,
                        shouldStop: () => cancelled || !mounted.current || gateGeneration.current !== generation,
                        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
                        read: async () => (await flowDraftsApi.getCheck(chatflow.id, running.id)).data
                    })
                    if (cancelled || !mounted.current || gateGeneration.current !== generation) return
                    const status = await flowDraftsApi.getStatus(chatflow.id)
                    if (cancelled || !mounted.current || gateGeneration.current !== generation) return
                    if (status?.data) onStatus.current(status.data)
                    if (view?.status !== 'done') setError(view?.error || 'The test set did not finish.')
                } finally {
                    if (mounted.current && gateGeneration.current === generation) setGateBusy(false)
                }
            })
            .catch(() => {})
        return () => {
            cancelled = true
        }
    }, [open, chatflow?.id])
    useEffect(
        () => () => {
            mounted.current = false
            gateGeneration.current += 1
        },
        []
    )
    useEffect(() => {
        if (!open || !chatflow?.id) return
        let cancelled = false
        Promise.resolve(flowDraftsApi.getStatus(chatflow.id))
            .then((res) => {
                if (!cancelled && res?.data) onStatus.current(res.data)
            })
            .catch(() => {})
        return () => {
            cancelled = true
        }
    }, [open, chatflow?.id])

    const finish = (data) => {
        if (data?.status) onDraftStatus(data.status)
        const next = canvasAfterPublish(chatflow, data, draftStatus?.draft?.flowData)
        if (data?.chatflow || next.chatflow?.flowData) onChatflowUpdated(next.chatflow)
        if (next.apply) onApplyCanvas(next.apply)
        const { message, variant } = publishResultMessage(data)
        dispatch(
            enqueueSnackbarAction({
                message,
                options: { key: new Date().getTime() + Math.random(), variant }
            })
        )
        onClose()
    }

    const onRunGate = async () => {
        const gate = draftStatus?.publishGate
        if (!chatflow?.id || !gate?.enabled || gateBusy || busy) return
        const generation = ++gateGeneration.current
        const stopped = () => !mounted.current || gateGeneration.current !== generation
        setGateBusy(true)
        setError('')
        try {
            const started = await flowDraftsApi.startCheck(chatflow.id, {
                datasetId: gate.datasetId,
                evaluatorIds: gate.evaluatorIds,
                threshold: gate.threshold ?? 100,
                includeRiskySteps: runAnyway
            })
            if (stopped()) return
            // Closing the dialog stops this poll. It does not stop the check, so a run already
            // started can still record a pass for the draft it scored.
            const view = await pollGateCheck({
                view: started.data,
                pollMs: POLL_MS,
                shouldStop: stopped,
                sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
                read: async () => (await flowDraftsApi.getCheck(chatflow.id, started.data?.id)).data
            })
            if (stopped()) return
            const status = await flowDraftsApi.getStatus(chatflow.id)
            if (stopped()) return
            if (status.data) onDraftStatus(status.data)
            if (view?.status !== 'done') setError(view?.error || 'The test set did not finish.')
        } catch (err) {
            if (!stopped()) setError(apiErrorMessage(err, 'The test set could not start.'))
        } finally {
            if (mounted.current && gateGeneration.current === generation) setGateBusy(false)
        }
    }

    const onPublish = async (overwriteDraftChanges = false) => {
        if (!chatflow?.id || busy) return
        if (stale && !replaceLiveChanges) return
        setBusy(true)
        setError('')
        setPublishConflict(null)
        try {
            const draft = { ...(draftExpected() || {}), ...(overwriteDraftChanges === true ? { overwriteDraftChanges: true } : {}) }
            const res = await flowDraftsApi.publish(chatflow.id, publishBody(stale, replaceLiveChanges, draft))
            finish(res.data)
        } catch (err) {
            const found = draftConflictFrom(err)
            if (found) setPublishConflict(found)
            else setError(apiErrorMessage(err, 'Publish failed.'))
            setBusy(false)
        }
    }

    const onReviewConflict = () => {
        const found = publishConflict
        setPublishConflict(null)
        onClose()
        if (found) onDraftConflict(found)
    }

    const onDiscard = async () => {
        if (!chatflow?.id || busy) return
        const ok = await confirm({
            title: 'Discard draft?',
            description: isDirty
                ? 'The canvas goes back to Live. Live itself does not change. Edits you have not saved are discarded too.'
                : 'The canvas goes back to Live. Live itself does not change.',
            confirmButtonName: 'Discard draft',
            cancelButtonName: 'Keep editing'
        })
        if (!ok) return
        setBusy(true)
        setError('')
        try {
            const res = await flowDraftsApi.discardDraft(chatflow.id)
            if (res.data) onDraftStatus(res.data)
            const live = canvasAfterDiscard(chatflow)
            if (live) onApplyCanvas(live)
            dispatch(
                enqueueSnackbarAction({
                    message: 'Draft discarded. Live is unchanged.',
                    options: { key: new Date().getTime() + Math.random(), variant: 'success' }
                })
            )
            onClose()
        } catch (err) {
            setError(apiErrorMessage(err, 'The draft could not be discarded.'))
            setBusy(false)
        }
    }

    return (
        <Dialog open={open} onClose={() => !busy && onClose()} fullWidth maxWidth='md' aria-labelledby='publish-dialog-title'>
            <DialogTitle id='publish-dialog-title' sx={{ fontSize: '1.1rem', fontWeight: 600 }}>
                Publish
            </DialogTitle>
            <DialogContent>
                <Typography variant='body2' color='text.secondary' sx={{ mb: 1.5 }}>
                    {replayCheck
                        ? 'This is what will go live. People using this flow keep seeing the current Live version until you publish.'
                        : 'This is what will go live. Scheduled runs, a run you start, and a full rebuild keep using the current Live pipeline until you publish. There is no question check.'}
                </Typography>
                {isDirty && (
                    <Alert severity='info' sx={{ mb: 1.5 }}>
                        You have unsaved changes. Save them first, or Publish uses the last saved draft.
                    </Alert>
                )}
                {stale && (
                    <Alert severity='warning' data-testid='stale-draft-warning' sx={{ mb: 1.5 }}>
                        {STALE_DRAFT_WARNING}
                    </Alert>
                )}
                <PublishChangeList lines={lines} />
                {chatflow?.id && replayCheck && (
                    <PublishCheck
                        chatflowId={chatflow.id}
                        flowType={chatflow.type}
                        canvases={[chatflow.flowData, draftStatus?.draft?.flowData]}
                        gateNote={
                            draftStatus?.publishGate?.enabled ? draftStatus.publishGate.block || 'This draft passed the test set.' : ''
                        }
                    />
                )}
                {replayCheck && (
                    <PublishGateNotice
                        gate={draftStatus?.publishGate}
                        busy={gateBusy}
                        runAnyway={runAnyway}
                        onRunAnyway={setRunAnyway}
                        onRun={onRunGate}
                        startBlock={startBlock}
                        canRun={canRunGate}
                    />
                )}
                {stale && (
                    <FormControlLabel
                        sx={{ mt: 1, alignItems: 'flex-start' }}
                        control={
                            <Checkbox
                                checked={replaceLiveChanges}
                                onChange={(event) => setReplaceLiveChanges(event.target.checked)}
                                inputProps={{ 'aria-label': 'Replace the Live changes' }}
                            />
                        }
                        label='Replace the Live changes'
                    />
                )}
                {error && (
                    <Alert severity='error' sx={{ mt: 1.5 }}>
                        {error}
                    </Alert>
                )}
                {publishConflict && (
                    <Alert severity='warning' data-testid='publish-draft-conflict' sx={{ mt: 1.5 }}>
                        <Typography variant='body2'>{publishConflictMessage(publishConflict)}</Typography>
                        <Stack direction='row' spacing={1} sx={{ mt: 1 }} flexWrap='wrap'>
                            <Button variant='outlined' size='small' onClick={onReviewConflict} disabled={busy}>
                                {PUBLISH_CONFLICT_REVIEW}
                            </Button>
                            <Button size='small' color='warning' onClick={() => onPublish(true)} disabled={busy}>
                                {PUBLISH_CONFLICT_ANYWAY}
                            </Button>
                        </Stack>
                    </Alert>
                )}
            </DialogContent>
            <DialogActions sx={{ flexWrap: 'wrap', gap: 1, px: 3, pb: 2 }}>
                <Button onClick={onDiscard} disabled={busy} color='inherit'>
                    Discard draft
                </Button>
                <Box sx={{ flexGrow: 1 }} />
                <Button onClick={onClose} disabled={busy}>
                    Keep editing
                </Button>
                <Button
                    variant='contained'
                    onClick={() => onPublish(false)}
                    disabled={busy || gateBusy || Boolean(gateBlock) || (stale && !replaceLiveChanges)}
                >
                    {busy ? 'Publishing…' : 'Publish'}
                </Button>
                {gateBlock && (
                    <Typography variant='caption' color='text.secondary' data-testid='publish-gate-reason' sx={{ flexBasis: '100%' }}>
                        {gateBlock}
                    </Typography>
                )}
            </DialogActions>
        </Dialog>
    )
}

PublishDialog.propTypes = {
    open: PropTypes.bool,
    chatflow: PropTypes.object,
    draftStatus: PropTypes.object,
    isDirty: PropTypes.bool,
    onClose: PropTypes.func,
    onDraftStatus: PropTypes.func,
    onChatflowUpdated: PropTypes.func,
    onApplyCanvas: PropTypes.func,
    draftExpected: PropTypes.func,
    onDraftConflict: PropTypes.func
}

export default PublishDialog
