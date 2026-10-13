import PropTypes from 'prop-types'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
    Alert,
    Box,
    Button,
    Checkbox,
    Chip,
    CircularProgress,
    FormControlLabel,
    LinearProgress,
    Stack,
    TextField,
    Typography
} from '@mui/material'
import { useTheme } from '@mui/material/styles'

import flowDraftsApi from '@/api/flowDrafts'
import { apiErrorMessage } from '@/utils/flowDrafts'
import {
    checkKind,
    checkTitle,
    countPickerLabel,
    loadingText,
    CHECK_VARY_NOTE,
    CHECK_WORDS,
    COMPARE_COUNTS,
    DEFAULT_COMPARE_COUNT,
    POLL_MS,
    RESULT_PAGE_SIZE,
    RUN_ANYWAY_LABEL,
    addQuestion,
    canRunCheck,
    capMessage,
    caseBadge,
    costNote,
    initialPicks,
    inputMeta,
    inputPreview,
    noPastRunsMessage,
    pickedQuestions,
    progressText,
    riskyWarning,
    sideCaption,
    stopReasonText,
    summaryText,
    togglePick,
    usageText,
    visibleCases
} from '@/utils/publishCheck'

const Side = ({ title, side, running, empty }) => (
    <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant='caption' color='text.secondary' sx={{ fontWeight: 600 }}>
            {title}
        </Typography>
        {side ? (
            <>
                <Typography
                    variant='body2'
                    color={side.error ? 'error' : 'text.primary'}
                    sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 160, overflow: 'auto' }}
                >
                    {side.error || side.text || '(empty answer)'}
                </Typography>
                <Typography variant='caption' color='text.secondary'>
                    {sideCaption(side)}
                </Typography>
            </>
        ) : (
            <Typography variant='body2' color='text.secondary'>
                {empty || (running ? 'Waiting…' : 'Not asked')}
            </Typography>
        )}
    </Box>
)

Side.propTypes = { title: PropTypes.string, side: PropTypes.object, running: PropTypes.bool, empty: PropTypes.string }

// Source and recorded time for one form, webhook or schedule input. Chat questions have neither.
const InputMeta = ({ source, date, fallbackSource }) => {
    const meta = inputMeta(source || fallbackSource, date)
    if (!meta) return null
    return (
        <Typography variant='caption' color='text.secondary' data-testid='input-meta' sx={{ display: 'block' }}>
            {meta}
        </Typography>
    )
}

InputMeta.propTypes = { source: PropTypes.string, date: PropTypes.string, fallbackSource: PropTypes.string }

export const CheckResults = ({ check, words = CHECK_WORDS.publish, replayInputs = false, replaySource }) => {
    const theme = useTheme()
    const [shown, setShown] = useState(RESULT_PAGE_SIZE)
    useEffect(() => {
        setShown(RESULT_PAGE_SIZE)
    }, [check?.id])
    if (!check) return null
    const running = check.status === 'running'
    const allCases = visibleCases(check)
    const cases = allCases.slice(0, shown)
    return (
        <Stack spacing={1.25} data-testid='check-results' sx={{ mt: 1.5 }}>
            {running && (
                <Box>
                    <Typography variant='body2' data-testid='check-progress'>
                        {progressText(check)}
                    </Typography>
                    <LinearProgress
                        variant='determinate'
                        value={check.total ? (check.completed / check.total) * 100 : 0}
                        sx={{ mt: 0.5 }}
                        aria-label='Check progress'
                    />
                </Box>
            )}
            {!running && (
                <Box data-testid='check-summary'>
                    <Typography variant='body2' sx={{ fontWeight: 600 }}>
                        {summaryText(check, words)}
                    </Typography>
                    {usageText(check, words) && (
                        <Typography variant='body2' color='text.secondary'>
                            {usageText(check, words)}
                        </Typography>
                    )}
                </Box>
            )}
            {check.stopReason && <Alert severity='info'>{stopReasonText(check.stopReason)}</Alert>}
            {check.status === 'failed' && <Alert severity='error'>{check.error || 'The check could not run.'}</Alert>}
            {check.draftChanged && !running && <Alert severity='warning'>{words.changed}</Alert>}
            {cases.map((c, index) => {
                const badge = caseBadge(c, check.liveEmpty)
                return (
                    <Box
                        key={`${index}-${c.question}`}
                        data-testid='check-case'
                        sx={{ border: '1px solid', borderColor: theme.palette.divider, borderRadius: 1, p: 1.25 }}
                    >
                        <Stack direction='row' spacing={1} alignItems='flex-start' sx={{ mb: 1 }}>
                            <Box sx={{ flex: 1, minWidth: 0 }}>
                                {replayInputs && <InputMeta source={c.source} date={c.date} fallbackSource={replaySource || undefined} />}
                                <Typography
                                    variant='body2'
                                    sx={{
                                        fontWeight: 600,
                                        wordBreak: 'break-word',
                                        ...(replayInputs ? { fontFamily: 'monospace', fontSize: '0.8rem' } : {})
                                    }}
                                >
                                    {replayInputs
                                        ? c.preview ||
                                          inputPreview(
                                              c.question,
                                              undefined,
                                              allCases.map((item) => item.question)
                                          )
                                        : c.question}
                                </Typography>
                            </Box>
                            <Chip
                                size='small'
                                label={badge.label}
                                color={badge.color}
                                variant={badge.color === 'default' ? 'outlined' : 'filled'}
                            />
                        </Stack>
                        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                            <Side title='Live' side={c.live} running={running} empty={check.liveEmpty ? words.emptyLive : ''} />
                            <Side title={words.side} side={c.draft} running={running} />
                        </Stack>
                    </Box>
                )
            })}
            {allCases.length > shown && (
                <Button
                    variant='text'
                    color='primary'
                    onClick={() => setShown((current) => current + RESULT_PAGE_SIZE)}
                    data-testid='check-results-more'
                >
                    Show more
                </Button>
            )}
            {!running && allCases.length > 0 && (
                <Typography variant='caption' color='text.secondary'>
                    {CHECK_VARY_NOTE}
                </Typography>
            )}
        </Stack>
    )
}

CheckResults.propTypes = {
    check: PropTypes.object,
    words: PropTypes.object,
    replayInputs: PropTypes.bool,
    replaySource: PropTypes.string
}

// Everything the panel shows, from plain props, so it can be rendered in tests without a server.
export const PublishCheckView = ({
    setup,
    loading,
    loadError,
    list,
    newQuestion,
    addError,
    runAnyway,
    check,
    starting,
    error,
    onToggle,
    onNewQuestion,
    onAdd,
    onRunAnyway,
    onRun,
    onStop,
    count = DEFAULT_COMPARE_COUNT,
    onCount = () => {},
    words = CHECK_WORDS.publish,
    // 'runs', 'questions', or null. Known from the canvas before the setup request returns.
    checkKind: hintedKind = null
}) => {
    const theme = useTheme()
    const [previewShown, setPreviewShown] = useState(RESULT_PAGE_SIZE)
    useEffect(() => {
        setPreviewShown(RESULT_PAGE_SIZE)
    }, [count])
    const limits = setup?.limits || {}
    const maxQuestions = limits.maxQuestions || 100
    const picked = pickedQuestions(list).length
    const running = check?.status === 'running'
    const risky = setup?.riskySteps || []
    const unavailable = setup?.unavailable || null
    const replayInputs = Boolean(setup?.replayInputs)
    // While the setup request is in flight, the canvas hint is all we have. Setup and loading clear together.
    const shownKind = loading ? hintedKind : replayInputs ? 'runs' : setup ? 'questions' : hintedKind
    const past = (setup?.questions || []).filter((q) => !q.starter)
    const pastCount = Number.isFinite(Number(setup?.pastCount)) ? Number(setup.pastCount) : past.length
    const used = pastCount > 0 ? Math.min(count, pastCount) : 0
    const addedPicked = pastCount > 0 ? list.filter((q) => q.added && q.picked).length : 0
    const questionCount = pastCount > 0 ? used + addedPicked : picked
    const checklist = pastCount > 0 ? list.filter((q) => q.added) : list
    const unit = replayInputs ? 'run' : 'question'
    const cap = capMessage(count, pastCount, Boolean(setup?.pastTruncated), unit)
    const countLabel = countPickerLabel({ replayInputs, requested: count, available: pastCount })
    const intro = replayInputs
        ? setup?.liveEmpty
            ? words.introInputsNew || words.introNew
            : words.introInputs || words.intro
        : setup?.liveEmpty
        ? words.introNew
        : words.intro
    if (unavailable?.code === 'off') return null
    const runnable = canRunCheck({ picked: questionCount, riskySteps: risky, runAnyway, running: running || starting, unavailable })

    return (
        <Box data-testid='publish-check' sx={{ mt: 2, p: 1.5, border: '1px solid', borderColor: theme.palette.divider, borderRadius: 1 }}>
            <Typography variant='subtitle1' component='h3' sx={{ fontWeight: 600 }} data-testid='check-title'>
                {checkTitle(shownKind)}
            </Typography>
            {loading && (
                <Stack direction='row' spacing={1} alignItems='center' sx={{ mt: 1 }}>
                    <CircularProgress size={16} />
                    <Typography variant='body2' color='text.secondary'>
                        {loadingText(shownKind)}
                    </Typography>
                </Stack>
            )}
            {loadError && (
                <Alert severity='warning' sx={{ mt: 1 }}>
                    {loadError} {words.stillCan}
                </Alert>
            )}
            {!loading && !loadError && unavailable && (
                <Typography variant='body2' color='text.secondary' sx={{ mt: 0.5 }} data-testid='check-unavailable'>
                    {unavailable.message}
                </Typography>
            )}
            {!loading && !loadError && setup && !unavailable && (
                <>
                    <Typography variant='body2' color='text.secondary' sx={{ mt: 0.5 }}>
                        {intro}
                    </Typography>
                    {cap && (
                        <Typography variant='body2' sx={{ mt: 1 }} data-testid='compare-cap'>
                            {cap}
                        </Typography>
                    )}
                    {pastCount > 0 && (
                        <Stack sx={{ mt: 1 }} aria-label='Questions to compare'>
                            {past
                                .slice(0, used)
                                .slice(0, previewShown)
                                .map((q, index) => (
                                    <Box key={`${index}-${q.text}`} data-testid='compare-input'>
                                        {replayInputs && (
                                            <InputMeta source={q.source} date={q.date} fallbackSource={setup?.replaySource || undefined} />
                                        )}
                                        <Typography
                                            variant='body2'
                                            data-testid='compare-question'
                                            sx={{
                                                wordBreak: 'break-word',
                                                ...(replayInputs ? { fontFamily: 'monospace', fontSize: '0.8rem' } : {})
                                            }}
                                        >
                                            {replayInputs
                                                ? q.preview ||
                                                  inputPreview(
                                                      q.text,
                                                      undefined,
                                                      past.map((item) => item.text)
                                                  )
                                                : q.text}
                                        </Typography>
                                    </Box>
                                ))}
                            {used > previewShown && (
                                <Button
                                    variant='text'
                                    color='primary'
                                    onClick={() => setPreviewShown((current) => current + RESULT_PAGE_SIZE)}
                                    data-testid='compare-questions-more'
                                >
                                    Show more
                                </Button>
                            )}
                        </Stack>
                    )}
                    {pastCount === 0 && checklist.length === 0 ? (
                        <Typography variant='body2' color='text.secondary' sx={{ mt: 1 }} data-testid='check-empty'>
                            {replayInputs
                                ? noPastRunsMessage(setup?.replaySource)
                                : 'No one has asked this flow anything yet. Add a question to check.'}
                        </Typography>
                    ) : checklist.length > 0 ? (
                        <Stack sx={{ mt: 1 }} aria-label='Questions to check'>
                            {checklist.map((q) => {
                                const index = list.indexOf(q)
                                return (
                                    <FormControlLabel
                                        key={`${index}-${q.text}`}
                                        data-testid='check-question'
                                        sx={{ alignItems: 'flex-start', mr: 0 }}
                                        control={
                                            <Checkbox
                                                size='small'
                                                checked={q.picked}
                                                disabled={running || starting || (!q.picked && picked >= maxQuestions)}
                                                onChange={() => onToggle(index)}
                                            />
                                        }
                                        label={
                                            <Typography variant='body2' sx={{ pt: '9px', wordBreak: 'break-word' }}>
                                                {q.text}
                                                {(q.added || q.starter) && (
                                                    <Typography component='span' variant='caption' color='text.secondary'>
                                                        {' '}
                                                        {q.added ? '(added)' : '(starter question)'}
                                                    </Typography>
                                                )}
                                            </Typography>
                                        }
                                    />
                                )
                            })}
                        </Stack>
                    ) : null}
                    {!replayInputs && (
                        <Stack direction='row' spacing={1} sx={{ mt: 1 }} alignItems='flex-start'>
                            <TextField
                                size='small'
                                fullWidth
                                placeholder='Add your own question'
                                value={newQuestion}
                                disabled={running || starting}
                                onChange={(event) => onNewQuestion(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter') {
                                        event.preventDefault()
                                        onAdd()
                                    }
                                }}
                                error={Boolean(addError)}
                                helperText={addError || ' '}
                                inputProps={{ 'aria-label': 'Add your own question', maxLength: limits.maxQuestionChars || 2000 }}
                            />
                            <Button variant='outlined' onClick={onAdd} disabled={running || starting || !String(newQuestion || '').trim()}>
                                Add
                            </Button>
                        </Stack>
                    )}
                    {risky.length > 0 && (
                        <Alert severity='warning' data-testid='check-risky' sx={{ mt: 0.5 }}>
                            {riskyWarning(risky)}
                            <FormControlLabel
                                sx={{ display: 'flex', mt: 0.5 }}
                                control={
                                    <Checkbox
                                        size='small'
                                        checked={runAnyway}
                                        disabled={running || starting}
                                        onChange={(event) => onRunAnyway(event.target.checked)}
                                    />
                                }
                                label={<Typography variant='body2'>{RUN_ANYWAY_LABEL}</Typography>}
                            />
                        </Alert>
                    )}
                    <Typography variant='body2' color='text.secondary' sx={{ mt: 1 }} data-testid='check-cost'>
                        {costNote(limits, questionCount, words, Boolean(setup.liveEmpty), unit)}
                    </Typography>
                    <Stack direction='row' spacing={1} sx={{ mt: 1 }} alignItems='center' flexWrap='wrap' useFlexGap>
                        <TextField
                            select
                            size='small'
                            label={countLabel}
                            value={String(COMPARE_COUNTS.includes(count) ? count : DEFAULT_COMPARE_COUNT)}
                            disabled={running || starting || pastCount === 0}
                            onChange={(event) => onCount(Number(event.target.value))}
                            SelectProps={{ native: true }}
                            inputProps={{
                                'aria-label': countLabel,
                                'data-testid': 'compare-count'
                            }}
                            sx={{ width: 180 }}
                        >
                            {COMPARE_COUNTS.map((n) => (
                                <option key={n} value={n}>
                                    {n}
                                </option>
                            ))}
                        </TextField>
                        {running ? (
                            <Button variant='outlined' color='inherit' onClick={onStop} data-testid='check-stop'>
                                Stop
                            </Button>
                        ) : (
                            <Button variant='outlined' onClick={onRun} disabled={!runnable} data-testid='check-run'>
                                {starting ? 'Starting…' : check ? 'Run check again' : 'Run check'}
                            </Button>
                        )}
                        <Typography variant='caption' color='text.secondary'>
                            {running ? words.closeNote : words.optional}
                        </Typography>
                    </Stack>
                    {error && (
                        <Alert severity='error' sx={{ mt: 1 }}>
                            {error}
                        </Alert>
                    )}
                    <CheckResults check={check} words={words} replayInputs={replayInputs} replaySource={setup?.replaySource} />
                </>
            )}
        </Box>
    )
}

PublishCheckView.propTypes = {
    setup: PropTypes.object,
    loading: PropTypes.bool,
    loadError: PropTypes.string,
    list: PropTypes.array,
    newQuestion: PropTypes.string,
    addError: PropTypes.string,
    runAnyway: PropTypes.bool,
    check: PropTypes.object,
    starting: PropTypes.bool,
    error: PropTypes.string,
    onToggle: PropTypes.func,
    onNewQuestion: PropTypes.func,
    onAdd: PropTypes.func,
    onRunAnyway: PropTypes.func,
    onRun: PropTypes.func,
    onStop: PropTypes.func,
    count: PropTypes.number,
    onCount: PropTypes.func,
    words: PropTypes.object,
    checkKind: PropTypes.oneOf(['runs', 'questions', null])
}

// The publish check panel: loads recent questions, runs the check, polls it, and stops it when the dialog closes.
// The same panel checks a version from Dev before Promote: variant 'promote' with that check's api.
const PublishCheck = ({ chatflowId, variant = 'publish', api = flowDraftsApi, flowType, canvases }) => {
    const words = CHECK_WORDS[variant] || CHECK_WORDS.publish
    const hintedKind = checkKind(flowType, canvases)
    const [setup, setSetup] = useState(null)
    const [loading, setLoading] = useState(true)
    const [loadError, setLoadError] = useState('')
    const [list, setList] = useState([])
    const [newQuestion, setNewQuestion] = useState('')
    const [addError, setAddError] = useState('')
    const [runAnyway, setRunAnyway] = useState(false)
    const [check, setCheck] = useState(null)
    const [count, setCount] = useState(DEFAULT_COMPARE_COUNT)
    const [starting, setStarting] = useState(false)
    const [error, setError] = useState('')
    const timer = useRef(null)
    const live = useRef({ mounted: true, checkId: null, running: false })

    const poll = useCallback(
        (checkId) => {
            clearTimeout(timer.current)
            timer.current = setTimeout(async () => {
                try {
                    const res = await api.getCheck(chatflowId, checkId)
                    if (!live.current.mounted) return
                    setCheck(res.data)
                    live.current.running = res.data?.status === 'running'
                    if (live.current.running) poll(checkId)
                } catch (err) {
                    if (!live.current.mounted) return
                    live.current.running = false
                    setError(apiErrorMessage(err, 'Could not read the check.'))
                    setCheck((current) => (current ? { ...current, status: 'failed', error: null } : current))
                }
            }, POLL_MS)
        },
        [chatflowId, api]
    )

    useEffect(() => {
        const state = live.current
        state.mounted = true
        let cancelled = false
        setLoading(true)
        api.getCheckSetup(chatflowId)
            .then((res) => {
                if (cancelled) return
                const data = res.data
                setSetup(data)
                const questions = data?.questions || []
                const past = questions.filter((q) => !q.starter)
                const reported = Number(data?.pastCount)
                const hasPast = (Number.isFinite(reported) && reported > 0) || past.length > 0
                // Past questions are chosen by the count. The tick list is only for a flow with none yet.
                setList(hasPast ? [] : initialPicks(questions, data?.limits?.defaultQuestions || DEFAULT_COMPARE_COUNT))
                const previous = data?.check
                if (previous && !(previous.draftChanged && previous.status !== 'running')) {
                    setCheck(previous)
                    state.checkId = previous.id
                    state.running = previous.status === 'running'
                    if (state.running) poll(previous.id)
                }
            })
            .catch((err) => !cancelled && setLoadError(apiErrorMessage(err, 'Recent questions could not be loaded.')))
            .finally(() => !cancelled && setLoading(false))
        return () => {
            cancelled = true
            state.mounted = false
            clearTimeout(timer.current)
            // Closing the dialog (or publishing) stops a check that is still running, so it stops costing tokens.
            if (state.running && state.checkId) api.stopCheck(chatflowId, state.checkId).catch(() => {})
        }
    }, [chatflowId, poll, api])

    const pastCount = () => {
        const reported = Number(setup?.pastCount)
        if (Number.isFinite(reported)) return reported
        return (setup?.questions || []).filter((q) => !q.starter).length
    }

    const onAdd = () => {
        const have = pastCount()
        const used = have > 0 ? Math.min(count, have) : 0
        const cap = setup?.limits?.maxQuestions || 100
        const result = addQuestion(list, newQuestion, { ...setup?.limits, maxQuestions: Math.max(0, cap - used) })
        setList(result.list)
        setAddError(result.error)
        if (result.list !== list) setNewQuestion('')
    }

    const onRun = async () => {
        setStarting(true)
        setError('')
        try {
            const have = pastCount()
            const added = list.filter((q) => q.added && q.picked).map((q) => q.text)
            const body =
                have > 0
                    ? { count, ...(added.length ? { questions: added } : {}), includeRiskySteps: runAnyway }
                    : { questions: pickedQuestions(list), includeRiskySteps: runAnyway }
            const res = await api.startCheck(chatflowId, body)
            if (!live.current.mounted) return
            setCheck(res.data)
            live.current.checkId = res.data?.id
            live.current.running = res.data?.status === 'running'
            if (live.current.running) poll(res.data.id)
        } catch (err) {
            if (live.current.mounted) setError(apiErrorMessage(err, 'The check could not start.'))
        } finally {
            if (live.current.mounted) setStarting(false)
        }
    }

    const onStop = async () => {
        if (!check?.id) return
        try {
            const res = await api.stopCheck(chatflowId, check.id)
            if (live.current.mounted && res.data) setCheck(res.data)
        } catch (err) {
            if (live.current.mounted) setError(apiErrorMessage(err, 'The check could not be stopped.'))
        }
    }

    return (
        <PublishCheckView
            setup={setup}
            loading={loading}
            loadError={loadError}
            list={list}
            newQuestion={newQuestion}
            addError={addError}
            runAnyway={runAnyway}
            check={check}
            starting={starting}
            error={error}
            onToggle={(index) => setList((current) => togglePick(current, index, setup?.limits?.maxQuestions || 10))}
            onNewQuestion={(value) => {
                setNewQuestion(value)
                if (addError) setAddError('')
            }}
            onAdd={onAdd}
            onRunAnyway={setRunAnyway}
            onRun={onRun}
            onStop={onStop}
            count={count}
            onCount={setCount}
            words={words}
            checkKind={hintedKind}
        />
    )
}

PublishCheck.propTypes = {
    chatflowId: PropTypes.string,
    variant: PropTypes.oneOf(['publish', 'promote']),
    api: PropTypes.object,
    flowType: PropTypes.string,
    canvases: PropTypes.array
}

export default PublishCheck
