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
import datasetsApi from '@/api/dataset'
import evaluatorsApi from '@/api/evaluators'
import { useAuth } from '@/hooks/useAuth'
import { apiErrorMessage, datasetGateBlock } from '@/utils/flowDrafts'
import {
    checkKind,
    checkTitle,
    compareListLabel,
    countPickerLabel,
    loadFailureMessage,
    loadingText,
    CHECK_VARY_NOTE,
    CHECK_ADOPTED_NOTE,
    CHECK_WORDS,
    GATE_RUN_PERMISSION,
    promoteCheckWords,
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
    passMarkNumber,
    passRateText,
    verdictText,
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
                {side.scores?.length > 0 && (
                    <Stack direction='row' spacing={0.5} useFlexGap flexWrap='wrap' sx={{ mt: 0.5 }}>
                        {side.scores.map((score, index) => (
                            <Chip
                                key={score.id || `score-${index}`}
                                size='small'
                                data-testid='check-score'
                                title={score.message || undefined}
                                label={score.name ? `${score.name}: ${score.result}` : score.result}
                                color={score.result === 'Pass' ? 'success' : score.result === 'Fail' ? 'error' : 'warning'}
                                variant='outlined'
                            />
                        ))}
                    </Stack>
                )}
                {side.scores?.some((score) => score.message) && (
                    <Typography variant='caption' color='text.secondary' data-testid='check-score-message'>
                        {[...new Set(side.scores.map((score) => score.message).filter(Boolean))].join(' ')}
                    </Typography>
                )}
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
                        {progressText(check, replayInputs ? 'run' : 'question')}
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
                        {summaryText(check, words, replayInputs ? 'run' : 'question')}
                    </Typography>
                    {usageText(check, words) && (
                        <Typography variant='body2' color='text.secondary'>
                            {usageText(check, words)}
                        </Typography>
                    )}
                    {passRateText(check, words).map((line) => (
                        <Typography key={line} variant='body2' color='text.secondary' data-testid='check-pass-rate'>
                            {line}
                        </Typography>
                    ))}
                    {verdictText(check) && (
                        <Typography variant='body2' data-testid='check-verdict'>
                            {verdictText(check)}
                        </Typography>
                    )}
                </Box>
            )}
            {check.stopReason && <Alert severity='info'>{stopReasonText(check.stopReason, replayInputs ? 'run' : 'question')}</Alert>}
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
                        {c.expected ? (
                            <Typography
                                variant='caption'
                                color='text.secondary'
                                data-testid='check-expected'
                                sx={{ display: 'block', mb: 1 }}
                            >
                                Expected: {c.expected}
                            </Typography>
                        ) : null}
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
    checkKind: hintedKind = null,
    source = 'recent',
    datasets = [],
    datasetId = '',
    evaluators = [],
    evaluatorIds = [],
    canUseDatasets = false,
    canUseEvaluators = false,
    onSource = () => {},
    onDataset = () => {},
    onToggleEvaluator = () => {},
    gateNote = '',
    stopsOnClose = true,
    canRunGate = true
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
    // 'questions' only after a chat check is available. A refusal keeps the canvas hint, so an unknown
    // start stays Check instead of switching to Check recent questions.
    const shownKind = loading
        ? hintedKind
        : unavailable
        ? hintedKind === 'runs'
            ? 'runs'
            : null
        : replayInputs
        ? 'runs'
        : setup
        ? 'questions'
        : hintedKind
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
    const fromDataset = source === 'dataset'
    const chosenDataset = datasets.find((item) => item.id === datasetId)
    const datasetQuestions = chosenDataset?.rowCount ? Math.min(Number(chosenDataset.rowCount) || 0, maxQuestions) : 0
    const runnable = canRunCheck({
        picked: fromDataset ? datasetQuestions : questionCount,
        riskySteps: risky,
        runAnyway,
        running: running || starting,
        unavailable,
        source,
        datasetId
    })

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
                    {loadError} {gateNote || words.stillCan}
                </Alert>
            )}
            {!loading && !loadError && unavailable && (
                <Typography variant='body2' color='text.secondary' sx={{ mt: 0.5 }} data-testid='check-unavailable'>
                    {unavailable.message}
                </Typography>
            )}
            {!loading && !loadError && setup && !unavailable && (
                <>
                    <Typography variant='body2' color='text.secondary' sx={{ mt: 0.5 }} data-testid='check-intro'>
                        {gateNote ||
                            (fromDataset
                                ? `Ask the rows of a saved dataset, on Live and on ${words.yours}, and compare the answers. This is optional.`
                                : intro)}
                    </Typography>
                    {canUseDatasets && (
                        <TextField
                            select
                            size='small'
                            label='Questions from'
                            value={source}
                            disabled={running || starting}
                            onChange={(event) => onSource(event.target.value)}
                            SelectProps={{ native: true }}
                            inputProps={{ 'aria-label': 'Questions from', 'data-testid': 'check-question-source' }}
                            sx={{ mt: 1, width: 220 }}
                        >
                            <option value='recent'>{replayInputs ? 'Recent runs' : 'Recent questions'}</option>
                            <option value='dataset'>A dataset</option>
                        </TextField>
                    )}
                    {fromDataset && (
                        <TextField
                            select
                            size='small'
                            label='Dataset'
                            value={datasetId}
                            disabled={running || starting}
                            onChange={(event) => onDataset(event.target.value)}
                            SelectProps={{ native: true }}
                            inputProps={{ 'aria-label': 'Dataset', 'data-testid': 'check-dataset' }}
                            sx={{ mt: 1, ml: canUseDatasets ? 1 : 0, width: 260 }}
                        >
                            <option value=''>Choose a dataset</option>
                            {datasets.map((item) => (
                                <option key={item.id} value={item.id}>
                                    {item.name}
                                </option>
                            ))}
                        </TextField>
                    )}
                    {!fromDataset && cap && (
                        <Typography variant='body2' sx={{ mt: 1 }} data-testid='compare-cap'>
                            {cap}
                        </Typography>
                    )}
                    {!fromDataset && pastCount > 0 && (
                        <Stack sx={{ mt: 1 }} aria-label={compareListLabel(replayInputs)}>
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
                    {fromDataset ? null : pastCount === 0 && checklist.length === 0 ? (
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
                    {!fromDataset && !replayInputs && (
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
                        {costNote(limits, fromDataset ? datasetQuestions : questionCount, words, Boolean(setup.liveEmpty), unit)}
                    </Typography>
                    {canUseEvaluators && (
                        <Stack sx={{ mt: 1 }} aria-label='Evaluators'>
                            <Typography variant='body2' sx={{ fontWeight: 600 }}>
                                Evaluators
                            </Typography>
                            {evaluators.length === 0 ? (
                                <Typography variant='body2' color='text.secondary'>
                                    No evaluators in this workspace.
                                </Typography>
                            ) : (
                                evaluators.map((evaluator) => (
                                    <FormControlLabel
                                        key={evaluator.id}
                                        data-testid='check-evaluator'
                                        sx={{ alignItems: 'flex-start', mr: 0 }}
                                        control={
                                            <Checkbox
                                                size='small'
                                                checked={evaluatorIds.includes(evaluator.id)}
                                                disabled={running || starting}
                                                onChange={() => onToggleEvaluator(evaluator.id)}
                                            />
                                        }
                                        label={
                                            <Typography variant='body2' sx={{ pt: '9px' }}>
                                                {evaluator.name}
                                            </Typography>
                                        }
                                    />
                                ))
                            )}
                        </Stack>
                    )}
                    <Stack direction='row' spacing={1} sx={{ mt: 1 }} alignItems='center' flexWrap='wrap' useFlexGap>
                        {!fromDataset && (
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
                        )}
                        {running ? (
                            <Button variant='outlined' color='inherit' onClick={onStop} data-testid='check-stop'>
                                Stop
                            </Button>
                        ) : (
                            <Button
                                variant='outlined'
                                onClick={onRun}
                                disabled={!runnable || (Boolean(gateNote) && fromDataset && !canRunGate)}
                                data-testid='check-run'
                            >
                                {starting ? 'Starting…' : check ? 'Run check again' : 'Run check'}
                            </Button>
                        )}
                        <Typography variant='caption' color='text.secondary' data-testid='check-optional'>
                            {running
                                ? stopsOnClose
                                    ? words.closeNote
                                    : CHECK_ADOPTED_NOTE
                                : Boolean(gateNote) && fromDataset && !canRunGate
                                ? GATE_RUN_PERMISSION
                                : gateNote || words.optional}
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
    checkKind: PropTypes.oneOf(['runs', 'questions', null]),
    source: PropTypes.oneOf(['recent', 'dataset']),
    datasets: PropTypes.array,
    datasetId: PropTypes.string,
    evaluators: PropTypes.array,
    evaluatorIds: PropTypes.array,
    canUseDatasets: PropTypes.bool,
    canUseEvaluators: PropTypes.bool,
    onSource: PropTypes.func,
    onDataset: PropTypes.func,
    onToggleEvaluator: PropTypes.func,
    gateNote: PropTypes.string,
    stopsOnClose: PropTypes.bool,
    canRunGate: PropTypes.bool
}

// The publish check panel: loads recent questions, runs the check, polls it, and stops it when the dialog closes.
// The same panel checks a version from Dev before Promote: variant 'promote' with that check's api.
const asList = (payload) => (Array.isArray(payload) ? payload : payload?.data || [])

const PublishCheck = ({ chatflowId, variant = 'publish', api = flowDraftsApi, flowType, canvases, gateNote = '', sourceTitle }) => {
    const words = variant === 'promote' ? promoteCheckWords(sourceTitle) : CHECK_WORDS[variant] || CHECK_WORDS.publish
    const hintedKind = checkKind(flowType, canvases)
    const { hasPermission } = useAuth()
    const canUseDatasets = hasPermission('datasets:view')
    const canUseEvaluators = hasPermission('evaluators:view')
    const [setup, setSetup] = useState(null)
    const [loading, setLoading] = useState(true)
    const [loadError, setLoadError] = useState('')
    const [list, setList] = useState([])
    const [newQuestion, setNewQuestion] = useState('')
    const [addError, setAddError] = useState('')
    const [runAnyway, setRunAnyway] = useState(false)
    const [check, setCheck] = useState(null)
    const [count, setCount] = useState(DEFAULT_COMPARE_COUNT)
    const [source, setSource] = useState('recent')
    const [datasets, setDatasets] = useState([])
    const [datasetId, setDatasetId] = useState('')
    const [evaluators, setEvaluators] = useState([])
    const [evaluatorIds, setEvaluatorIds] = useState([])
    const [starting, setStarting] = useState(false)
    const [error, setError] = useState('')
    const [stopsOnClose, setStopsOnClose] = useState(false)
    const canRunGate = canUseDatasets && canUseEvaluators
    const timer = useRef(null)
    const live = useRef({ mounted: true, checkId: null, running: false, ownedId: null })

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
                    state.ownedId = null
                    setStopsOnClose(false)
                    if (state.running) poll(previous.id)
                }
            })
            .catch((err) => !cancelled && setLoadError(apiErrorMessage(err, loadFailureMessage(hintedKind))))
            .finally(() => !cancelled && setLoading(false))
        return () => {
            cancelled = true
            state.mounted = false
            clearTimeout(timer.current)
            // Stop only a check this instance started. A running check returned by setup (for example a
            // gate run started from Publish) must keep going so it can still store a pass.
            if (state.ownedId && state.running) api.stopCheck(chatflowId, state.ownedId).catch(() => {})
        }
    }, [chatflowId, poll, api, hintedKind])

    useEffect(() => {
        if (!canUseDatasets) return undefined
        let cancelled = false
        datasetsApi
            .getAllDatasets()
            .then((res) => {
                if (!cancelled) setDatasets(asList(res.data))
            })
            .catch(() => {
                if (!cancelled) setDatasets([])
            })
        return () => {
            cancelled = true
        }
    }, [canUseDatasets])

    useEffect(() => {
        if (!canUseEvaluators) return undefined
        let cancelled = false
        evaluatorsApi
            .getAllEvaluators()
            .then((res) => {
                if (!cancelled) setEvaluators(asList(res.data))
            })
            .catch(() => {
                if (!cancelled) setEvaluators([])
            })
        return () => {
            cancelled = true
        }
    }, [canUseEvaluators])

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
            const scored = evaluatorIds.length ? { evaluatorIds } : {}
            const body =
                source === 'dataset'
                    ? { datasetId, ...scored, includeRiskySteps: runAnyway }
                    : have > 0
                    ? { count, ...(added.length ? { questions: added } : {}), ...scored, includeRiskySteps: runAnyway }
                    : { questions: pickedQuestions(list), ...scored, includeRiskySteps: runAnyway }
            const res = await api.startCheck(chatflowId, body)
            if (!live.current.mounted) {
                // This instance started the check. Stop it if the dialog closed before the response.
                if (res.data?.status === 'running' && res.data?.id) api.stopCheck(chatflowId, res.data.id).catch(() => {})
                return
            }
            setCheck(res.data)
            setStopsOnClose(true)
            live.current.checkId = res.data?.id
            live.current.ownedId = res.data?.id || null
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
            source={canUseDatasets ? source : 'recent'}
            datasets={datasets}
            datasetId={datasetId}
            evaluators={evaluators}
            evaluatorIds={evaluatorIds}
            canUseDatasets={canUseDatasets}
            canUseEvaluators={canUseEvaluators}
            onSource={(value) => setSource(value === 'dataset' ? 'dataset' : 'recent')}
            onDataset={setDatasetId}
            onToggleEvaluator={(id) =>
                setEvaluatorIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))
            }
            gateNote={gateNote}
            stopsOnClose={stopsOnClose}
            canRunGate={canRunGate}
        />
    )
}

PublishCheck.propTypes = {
    chatflowId: PropTypes.string,
    variant: PropTypes.oneOf(['publish', 'promote']),
    api: PropTypes.object,
    flowType: PropTypes.string,
    canvases: PropTypes.array,
    gateNote: PropTypes.string,
    sourceTitle: PropTypes.string
}

// Flow configuration: require a passing dataset check before Publish. Uses the same dataset and evaluator lists as the check above.
export const PublishGateSettings = ({ dialogProps }) => {
    const { hasPermission } = useAuth()
    const chatflow = dialogProps?.chatflow
    const draftStatus = dialogProps?.draftStatus
    const gate = draftStatus?.publishGate
    const locked = Boolean(draftStatus?.publishInstantly)
    const canChoose = hasPermission('datasets:view') && hasPermission('evaluators:view')
    const startBlock = datasetGateBlock(chatflow?.type, [chatflow?.flowData, draftStatus?.draft?.flowData])
    const chooseLocked = locked || !canChoose || Boolean(startBlock)
    const [on, setOn] = useState(Boolean(gate?.enabled))
    const [datasetId, setDatasetId] = useState(gate?.datasetId || '')
    const [evaluatorIds, setEvaluatorIds] = useState(gate?.evaluatorIds || [])
    const [threshold, setThreshold] = useState(gate?.threshold ?? 100)
    const [datasets, setDatasets] = useState([])
    const [evaluators, setEvaluators] = useState([])
    const [error, setError] = useState('')
    const [saved, setSaved] = useState('')
    const writeChain = useRef(Promise.resolve())

    const evaluatorKey = (gate?.evaluatorIds || []).join(',')
    useEffect(() => {
        setOn(Boolean(gate?.enabled))
        setDatasetId(gate?.datasetId || '')
        setEvaluatorIds(gate?.evaluatorIds || [])
        setThreshold(gate?.threshold ?? 100)
    }, [gate?.enabled, gate?.datasetId, gate?.threshold, gate?.evaluatorIds, evaluatorKey])

    useEffect(() => {
        if (!canChoose) return undefined
        let cancelled = false
        datasetsApi
            .getAllDatasets()
            .then((res) => {
                if (!cancelled) setDatasets(asList(res.data))
            })
            .catch(() => {
                if (!cancelled) setDatasets([])
            })
        evaluatorsApi
            .getAllEvaluators()
            .then((res) => {
                if (!cancelled) setEvaluators(asList(res.data))
            })
            .catch(() => {
                if (!cancelled) setEvaluators([])
            })
        return () => {
            cancelled = true
        }
    }, [canChoose])

    const persist = async (next) => {
        if (!chatflow?.id) return
        setError('')
        setSaved('')
        const whole = passMarkNumber(next.threshold)
        if (next.enabled && (!next.datasetId || !next.evaluatorIds.length)) {
            setOn(Boolean(gate?.enabled))
            setError('Choose a dataset and at least one evaluator.')
            return
        }
        if (next.enabled && whole == null) {
            setThreshold(gate?.threshold ?? 100)
            setError('The pass mark is a whole number from 0 to 100.')
            return
        }
        try {
            const res = await flowDraftsApi.updateSettings(chatflow.id, {
                publishGate: next.enabled
                    ? { enabled: true, datasetId: next.datasetId, evaluatorIds: next.evaluatorIds, threshold: whole }
                    : { enabled: false }
            })
            if (res.data) dialogProps.onDraftStatus?.(res.data)
            setSaved(next.enabled ? 'Publish waits for a passing test set.' : 'Publish no longer waits for a test set.')
        } catch (err) {
            setOn(Boolean(gate?.enabled))
            setError(apiErrorMessage(err, 'That setting could not be saved.'))
        }
    }

    // One settings write at a time, in the order the person chose. A later blur cannot finish first
    // and leave the server on the older dataset or evaluator.
    const save = (next) => {
        const run = writeChain.current.catch(() => {}).then(() => persist(next))
        writeChain.current = run
        return run
    }

    const toggleEvaluator = (id) => {
        const nextIds = evaluatorIds.includes(id) ? evaluatorIds.filter((item) => item !== id) : [...evaluatorIds, id]
        setEvaluatorIds(nextIds)
        if (on) save({ enabled: true, datasetId, evaluatorIds: nextIds, threshold })
    }

    return (
        <Box data-testid='publish-gate-settings'>
            {locked && (
                <Alert severity='info' sx={{ mb: 1 }}>
                    Turn off Publish instantly before requiring a passing test set.
                </Alert>
            )}
            {startBlock && (
                <Alert severity='warning' sx={{ mb: 1 }} data-testid='publish-gate-start'>
                    {startBlock}
                </Alert>
            )}
            {!canChoose && (
                <Alert severity='info' sx={{ mb: 1 }}>
                    You need permission to view datasets and evaluators before requiring a passing test set.
                </Alert>
            )}
            <FormControlLabel
                control={
                    <Checkbox
                        checked={on}
                        disabled={locked || (!canChoose && !on)}
                        onChange={(event) => {
                            const next = event.target.checked
                            setOn(next)
                            save({ enabled: next, datasetId, evaluatorIds, threshold })
                        }}
                        inputProps={{ 'aria-label': 'Require a passing test set before Publish' }}
                    />
                }
                label='Require a passing test set before Publish'
            />
            <Typography variant='body2' color='text.secondary' sx={{ mt: 1 }}>
                Publish is refused until this draft passes the dataset at the mark you set. Errored rows count as not passed.
            </Typography>
            <Stack spacing={1} sx={{ mt: 1.5 }}>
                <TextField
                    select
                    size='small'
                    label='Dataset'
                    value={datasetId}
                    disabled={chooseLocked}
                    onChange={(event) => {
                        const nextId = event.target.value
                        setDatasetId(nextId)
                        if (on) save({ enabled: true, datasetId: nextId, evaluatorIds, threshold })
                    }}
                    SelectProps={{ native: true }}
                    inputProps={{ 'aria-label': 'Dataset', 'data-testid': 'publish-gate-dataset' }}
                >
                    <option value=''>Choose a dataset</option>
                    {datasets.map((item) => (
                        <option key={item.id} value={item.id}>
                            {item.name}
                        </option>
                    ))}
                </TextField>
                <TextField
                    size='small'
                    type='number'
                    label='Pass at'
                    value={threshold}
                    disabled={chooseLocked}
                    onChange={(event) => setThreshold(event.target.value)}
                    onBlur={() => {
                        const mark = passMarkNumber(threshold)
                        if (mark == null) {
                            setThreshold(gate?.threshold ?? 100)
                            setError('The pass mark is a whole number from 0 to 100.')
                            return
                        }
                        setThreshold(mark)
                        if (on) save({ enabled: true, datasetId, evaluatorIds, threshold: mark })
                    }}
                    inputProps={{ 'aria-label': 'Pass at', min: 0, max: 100, step: 1, 'data-testid': 'publish-gate-threshold' }}
                    helperText='A whole number from 0 to 100. 100 means every score passed.'
                />
                <Typography variant='body2' sx={{ fontWeight: 600 }}>
                    Evaluators
                </Typography>
                {evaluators.length === 0 ? (
                    <Typography variant='body2' color='text.secondary'>
                        No evaluators in this workspace.
                    </Typography>
                ) : (
                    evaluators.map((evaluator) => (
                        <FormControlLabel
                            key={evaluator.id}
                            data-testid='publish-gate-evaluator'
                            control={
                                <Checkbox
                                    size='small'
                                    checked={evaluatorIds.includes(evaluator.id)}
                                    disabled={chooseLocked}
                                    onChange={() => toggleEvaluator(evaluator.id)}
                                />
                            }
                            label={evaluator.name}
                        />
                    ))
                )}
            </Stack>
            {saved && (
                <Alert severity='success' sx={{ mt: 1 }}>
                    {saved}
                </Alert>
            )}
            {error && (
                <Alert severity='error' sx={{ mt: 1 }}>
                    {error}
                </Alert>
            )}
        </Box>
    )
}

PublishGateSettings.propTypes = {
    dialogProps: PropTypes.object
}

export default PublishCheck
