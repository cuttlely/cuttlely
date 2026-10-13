import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { fetchEventSource } from '@microsoft/fetch-event-source'

import { Alert, Box, Button, Chip, Paper, Stack, TextField, Typography } from '@mui/material'

import harnessesApi from '@/api/harnesses'
import useApi from '@/hooks/useApi'
import ViewHeader from '@/layout/MainLayout/ViewHeader'
import MainCard from '@/ui-component/cards/MainCard'
import { StyledPermissionButton } from '@/ui-component/button/RBACButtons'
import { baseURL } from '@/store/constant'
import { formatListDateTime } from '@/utils/formatDate'
import HarnessRunTrace from '@/views/chatmessage/HarnessRunTrace'
import { harnessCanvasRunPath, harnessRunPath } from '@/utils/harnessCanvasChat'
import { emptyTrace, failTrace, reduceHarnessEvent } from '../../../../../packages/harness/trace.mjs'

const STATUS_COLOR = {
    succeeded: 'success',
    completed_with_errors: 'warning',
    failed: 'error',
    cancelled: 'warning',
    running: 'info'
}

const STATUS_LABEL = {
    succeeded: 'succeeded',
    completed_with_errors: 'completed with errors',
    failed: 'failed',
    cancelled: 'cancelled',
    running: 'running'
}

function tokenLabel(tokens) {
    if (!tokens) return 'tokens n/a'
    const prompt = tokens.prompt == null ? 'n/a' : tokens.prompt
    const completion = tokens.completion == null ? 'n/a' : tokens.completion
    return `in ${prompt} · out ${completion}`
}

function latencyLabel(run) {
    if (run?.status === 'running' || run?.latencyMs == null) return 'in progress'
    if (run.latencyMs < 1000) return `${run.latencyMs} ms`
    return `${(run.latencyMs / 1000).toFixed(1)} s`
}

function messageFrom(response, fallback) {
    if (!response) return fallback
    try {
        const body = JSON.parse(response)
        if (body?.message) return body.message
    } catch {
        // A non-JSON body is shown as text.
    }
    return response.slice(0, 300) || fallback
}

const HarnessHome = () => {
    const { name } = useParams()
    const navigate = useNavigate()
    const harnessApi = useApi(harnessesApi.getHarness)
    const runsApi = useApi(harnessesApi.listRuns)
    const [question, setQuestion] = useState('')
    const [output, setOutput] = useState('')
    const [liveTrace, setLiveTrace] = useState(null)
    const [runError, setRunError] = useState('')
    const [running, setRunning] = useState(false)
    const [selectedId, setSelectedId] = useState(null)
    const chatIdRef = useRef('')
    const abortRef = useRef(null)

    useEffect(() => {
        if (!name) return
        harnessApi.request(name)
        runsApi.request(name)
        return () => abortRef.current?.abort()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [name])

    const harness = harnessApi.data
    const runs = Array.isArray(runsApi.data) ? runsApi.data : []
    const selected = runs.find((run) => run.id === selectedId) || null
    const updated = formatListDateTime(harness?.updatedAt)
    const specialists = harness?.specialists?.length || 0

    const reloadRuns = () => {
        if (name) runsApi.request(name)
    }

    const stop = () => {
        abortRef.current?.abort()
        abortRef.current = null
    }

    const send = async () => {
        const prompt = question.trim()
        if (!prompt || !name || running) return
        setRunning(true)
        setOutput('')
        setRunError('')
        setLiveTrace(emptyTrace(name))
        const controller = new AbortController()
        abortRef.current = controller
        let sawAnswer = false
        try {
            const runPath = harness?.chatflowId ? harnessCanvasRunPath(harness.chatflowId) : harnessRunPath(name)
            await fetchEventSource(`${baseURL}${runPath}`, {
                openWhenHidden: true,
                method: 'POST',
                signal: controller.signal,
                headers: {
                    'Content-Type': 'application/json',
                    'x-request-from': 'internal'
                },
                body: JSON.stringify({
                    question: prompt,
                    streaming: true,
                    ...(chatIdRef.current ? { chatId: chatIdRef.current } : {})
                }),
                async onopen(response) {
                    if (response.ok && (response.headers.get('content-type') || '').includes('text/event-stream')) return
                    const text = await response.text()
                    throw new Error(messageFrom(text, `Harness run failed (${response.status}).`))
                },
                onmessage(ev) {
                    const payload = JSON.parse(ev.data)
                    const event = payload.event
                    const data = payload.data || {}
                    if (typeof event === 'string' && event.startsWith('harness.') && event !== 'harness.recorded') {
                        const type = event.slice('harness.'.length)
                        setLiveTrace((current) => reduceHarnessEvent(current || emptyTrace(data.harness || name), { ...data, type }))
                    }
                    if (event === 'harness.partial' && data.phase === 'answer' && typeof data.text === 'string') {
                        sawAnswer = true
                        setOutput((prev) => prev + data.text)
                    } else if (event === 'harness.final') {
                        if (!sawAnswer && typeof data.text === 'string') setOutput(data.text)
                    } else if (event === 'harness.recorded') {
                        if (data.chatId) chatIdRef.current = data.chatId
                        if (data.run?.id) setSelectedId(data.run.id)
                    } else if (event === 'error') {
                        setRunError(data.message || 'The harness run failed.')
                        setLiveTrace((current) => failTrace(current, data.message || 'The harness run failed.'))
                        if (data.run?.id) setSelectedId(data.run.id)
                    }
                },
                onerror(err) {
                    throw err
                }
            })
        } catch (error) {
            if (!controller.signal.aborted) {
                const message = error?.message || 'The harness run failed.'
                setRunError(message)
                setLiveTrace((current) => failTrace(current, message))
            }
        } finally {
            if (abortRef.current === controller) abortRef.current = null
            setRunning(false)
            reloadRuns()
        }
    }

    return (
        <MainCard>
            <Stack flexDirection='column' sx={{ gap: 3 }}>
                <ViewHeader
                    isBackButton
                    onBack={() => navigate('/harnesses')}
                    title={harness?.name || name}
                    description={
                        harness
                            ? `${specialists} specialist${specialists === 1 ? '' : 's'}${updated ? ` · Updated ${updated}` : ''}`
                            : 'Loading harness.'
                    }
                >
                    <Button
                        variant='outlined'
                        onClick={() => navigate(harness?.chatflowId ? `/harnesscanvas/${harness.chatflowId}` : '/harnesscanvas')}
                        sx={{ borderRadius: 2, height: 40 }}
                    >
                        Open canvas
                    </Button>
                </ViewHeader>
                {harnessApi.error && <Alert severity='error'>Could not load this harness.</Alert>}
                <Paper variant='outlined' sx={{ p: 2, borderRadius: 2 }}>
                    <Stack sx={{ gap: 1.5 }}>
                        <Typography variant='h4'>Try it</Typography>
                        <Typography color='text.secondary'>
                            Runs the draft when the canvas has one, and Live otherwise. External callers use{' '}
                            <code>POST /api/v1/harnesses/{name}/runs</code>, which stays on Live until you publish. A chatflow uses the
                            Harness tool and selects {name}.
                        </Typography>
                        <TextField
                            value={question}
                            onChange={(event) => setQuestion(event.target.value)}
                            placeholder='Ask this harness'
                            multiline
                            minRows={3}
                            fullWidth
                            disabled={running}
                        />
                        <Stack direction='row' sx={{ gap: 1, flexWrap: 'wrap' }}>
                            <StyledPermissionButton
                                permissionId={'chatflows:create,chatflows:update,agentflows:create'}
                                variant='contained'
                                onClick={send}
                                disabled={running || !question.trim()}
                                sx={{ borderRadius: 2, height: 40 }}
                            >
                                {running ? 'Running' : 'Run'}
                            </StyledPermissionButton>
                            {running && (
                                <Button variant='outlined' onClick={stop} sx={{ borderRadius: 2, height: 40 }}>
                                    Stop
                                </Button>
                            )}
                        </Stack>
                        {liveTrace && <HarnessRunTrace trace={liveTrace} />}
                        {runError && <Alert severity='error'>{runError}</Alert>}
                        {(output || running) && (
                            <Box
                                component='pre'
                                sx={{
                                    m: 0,
                                    p: 1.5,
                                    borderRadius: 1.5,
                                    bgcolor: 'action.hover',
                                    whiteSpace: 'pre-wrap',
                                    overflowWrap: 'anywhere',
                                    fontFamily: 'inherit'
                                }}
                            >
                                {output || 'Waiting for the first token.'}
                            </Box>
                        )}
                    </Stack>
                </Paper>
                <Stack sx={{ gap: 1.5 }}>
                    <Typography variant='h4'>Runs</Typography>
                    {runsApi.error ? (
                        <Typography color='error'>Could not load runs.</Typography>
                    ) : runs.length === 0 ? (
                        <Typography color='text.secondary'>
                            No runs yet. Send a prompt above, or call this harness from a chatflow.
                        </Typography>
                    ) : (
                        runs.map((run) => (
                            <Paper
                                key={run.id}
                                variant='outlined'
                                onClick={() => setSelectedId(run.id)}
                                sx={{
                                    p: 1.5,
                                    borderRadius: 1.5,
                                    cursor: 'pointer',
                                    borderColor: selected?.id === run.id ? 'primary.main' : undefined
                                }}
                            >
                                <Stack direction='row' justifyContent='space-between' alignItems='flex-start' sx={{ gap: 1 }}>
                                    <Box sx={{ minWidth: 0, flex: 1 }}>
                                        <Typography variant='subtitle2'>
                                            {formatListDateTime(run.startedAt)} · {run.source} · {latencyLabel(run)}
                                        </Typography>
                                        <Typography variant='caption' color='text.secondary'>
                                            {tokenLabel(run.tokens)}
                                            {run.inputPreview ? ` · ${run.inputPreview}` : ''}
                                        </Typography>
                                    </Box>
                                    <Chip
                                        size='small'
                                        label={STATUS_LABEL[run.status] || run.status}
                                        color={STATUS_COLOR[run.status] || 'default'}
                                        sx={{ flexShrink: 0 }}
                                    />
                                </Stack>
                            </Paper>
                        ))
                    )}
                    {selected && (
                        <Paper variant='outlined' sx={{ p: 2, borderRadius: 2 }}>
                            <Stack sx={{ gap: 1 }}>
                                <Typography variant='h5'>Run</Typography>
                                {selected.trace ? (
                                    <HarnessRunTrace trace={selected.trace} />
                                ) : (
                                    <Typography variant='body2'>
                                        {selected.status} · {latencyLabel(selected)} · {tokenLabel(selected.tokens)}
                                    </Typography>
                                )}
                                {selected.error && (
                                    <Alert severity='error'>
                                        {selected.error.code}: {selected.error.message}
                                    </Alert>
                                )}
                                {selected.textPreview && !selected.trace && (
                                    <Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                                        {selected.textPreview}
                                    </Typography>
                                )}
                            </Stack>
                        </Paper>
                    )}
                </Stack>
            </Stack>
        </MainCard>
    )
}

export default HarnessHome
