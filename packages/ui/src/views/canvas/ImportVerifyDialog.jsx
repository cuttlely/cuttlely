import { useState } from 'react'
import PropTypes from 'prop-types'
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Stack, TextField, Typography } from '@mui/material'
import chatflowsApi from '@/api/chatflows'
import flowDraftsApi from '@/api/flowDrafts'
import importVerifyApi from '@/api/importVerify'
import { harnessNameFrom } from '@/utils/buildWithAI'
import { requestFailureMessage } from '@/utils/errorSummary'
import { PLACEHOLDER_FLOW, progressLine, statusTitle, untrustFlow } from '@/utils/importVerify'

const ImportVerifyDialog = ({ open, onClose, chatflow, flowType = 'CHATFLOW', onPublished }) => {
    const [fileName, setFileName] = useState('')
    const [flowText, setFlowText] = useState('')
    const [name, setName] = useState('')
    const [error, setError] = useState('')
    const [busy, setBusy] = useState(false)
    const [record, setRecord] = useState(null)
    const [chatflowId, setChatflowId] = useState(chatflow?.id || '')
    const [choices, setChoices] = useState({})

    const reset = () => {
        setFileName('')
        setFlowText('')
        setName('')
        setError('')
        setBusy(false)
        setRecord(null)
        setChoices({})
        setChatflowId(chatflow?.id || '')
    }

    const close = () => {
        if (busy) return
        reset()
        onClose()
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
        if (chatflowId) {
            if (saveFile) await flowDraftsApi.saveDraft(chatflowId, flowText)
            return chatflowId
        }
        const typed = name.trim() || 'Imported flow'
        const savedName = flowType === 'HARNESS' ? harnessNameFrom(typed) : typed
        const body = { name: savedName, type: flowType, deployed: false, flowData: PLACEHOLDER_FLOW }
        if (flowType === 'HARNESS') body.draftFlowData = flowText
        const created = await chatflowsApi.createNewChatflow(body)
        const id = created?.data?.id
        if (!id) throw new Error('The flow was not created.')
        if (flowType !== 'HARNESS') await flowDraftsApi.saveDraft(id, flowText)
        setChatflowId(id)
        return id
    }

    const run = async (extra = {}) => {
        setBusy(true)
        setError('')
        try {
            const id = await ensureFlow(!extra.retryFailures && !extra.choices)
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
                if (response?.data) setRecord(response.data)
            } finally {
                clearInterval(timer)
            }
        } catch (err) {
            setError(requestFailureMessage(err))
        } finally {
            setBusy(false)
        }
    }

    const unresolved = (record?.connections || []).filter((item) => item.status === 'missing' || item.status === 'ambiguous')
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
                <Button onClick={close} disabled={busy}>
                    Close
                </Button>
                {unresolved.length > 0 && (
                    <Button variant='contained' disabled={busy} onClick={() => run({ choices })}>
                        Choose connection
                    </Button>
                )}
                {record?.queries?.some((item) => item.state === 'failed') && (
                    <Button variant='outlined' disabled={busy} onClick={() => run({ retryFailures: true, choices })}>
                        Retry
                    </Button>
                )}
                {record?.publishOffered && (
                    <Button
                        variant='contained'
                        disabled={busy}
                        onClick={async () => {
                            setBusy(true)
                            try {
                                await flowDraftsApi.publish(chatflowId, {})
                                if (onPublished) onPublished(chatflowId)
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
    onPublished: PropTypes.func
}

export default ImportVerifyDialog
