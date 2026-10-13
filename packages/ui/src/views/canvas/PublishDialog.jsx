import PropTypes from 'prop-types'
import { useEffect, useMemo, useState } from 'react'
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
import { CHANGE_COLORS } from '@/utils/versionHistory'
import {
    STALE_DRAFT_WARNING,
    apiErrorMessage,
    publishBody,
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

const PublishDialog = ({ open, chatflow, draftStatus, isDirty, onClose, onDraftStatus, onChatflowUpdated, onApplyCanvas }) => {
    const dispatch = useDispatch()
    const { confirm } = useConfirm()
    const [replaceLiveChanges, setReplaceLiveChanges] = useState(false)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')

    const stale = Boolean(draftStatus?.draft?.stale)
    const replayCheck = showsPublishCheck(chatflow?.type)
    const lines = useMemo(
        () => (open ? publishChangeLines(chatflow?.flowData, draftStatus?.draft?.flowData) : []),
        [open, chatflow?.flowData, draftStatus?.draft?.flowData]
    )

    useEffect(() => {
        if (!open) return
        setReplaceLiveChanges(false)
        setError('')
        setBusy(false)
    }, [open])

    const finish = (data) => {
        if (data?.status) onDraftStatus(data.status)
        if (data?.chatflow) onChatflowUpdated(data.chatflow)
        if (data?.status?.draft?.flowData) onApplyCanvas(data.status.draft.flowData)
        const { message, variant } = publishResultMessage(data)
        dispatch(
            enqueueSnackbarAction({
                message,
                options: { key: new Date().getTime() + Math.random(), variant }
            })
        )
        onClose()
    }

    const onPublish = async () => {
        if (!chatflow?.id || busy) return
        if (stale && !replaceLiveChanges) return
        setBusy(true)
        setError('')
        try {
            const res = await flowDraftsApi.publish(chatflow.id, publishBody(stale, replaceLiveChanges))
            finish(res.data)
        } catch (err) {
            setError(apiErrorMessage(err, 'Publish failed.'))
            setBusy(false)
        }
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
            onApplyCanvas(chatflow.flowData || '')
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
                {chatflow?.id && replayCheck && <PublishCheck chatflowId={chatflow.id} />}
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
            </DialogContent>
            <DialogActions sx={{ flexWrap: 'wrap', gap: 1, px: 3, pb: 2 }}>
                <Button onClick={onDiscard} disabled={busy} color='inherit'>
                    Discard draft
                </Button>
                <Box sx={{ flexGrow: 1 }} />
                <Button onClick={onClose} disabled={busy}>
                    Keep editing
                </Button>
                <Button variant='contained' onClick={onPublish} disabled={busy || (stale && !replaceLiveChanges)}>
                    {busy ? 'Publishing…' : 'Publish'}
                </Button>
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
    onApplyCanvas: PropTypes.func
}

export default PublishDialog
