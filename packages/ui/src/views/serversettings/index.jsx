// Admin, Server settings: how this server runs, for the organization owner.
// Runtime limits apply on the next use. The other settings apply when Cuttlely restarts.
// Values set where Cuttlely is installed show as Locked.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PropTypes from 'prop-types'
import { useDispatch, useSelector } from 'react-redux'
import { useNavigate } from 'react-router-dom'

import { alpha, useTheme } from '@mui/material/styles'
import { Alert, Box, Button, ButtonBase, InputAdornment, OutlinedInput, Paper, Skeleton, Stack, Typography } from '@mui/material'
import { IconRefresh, IconSearch, IconX } from '@tabler/icons-react'

import MainCard from '@/ui-component/cards/MainCard'
import serverSettingsApi from '@/api/serverSettings'
import { closeSnackbar as closeSnackbarAction, enqueueSnackbar as enqueueSnackbarAction } from '@/store/actions'
import useNotifier from '@/utils/useNotifier'

import AllSettingsPanel from './AllSettingsPanel'
import AuthKitCard from './AuthKitCard'
import AuthKitWizard from './AuthKitWizard'
import DatabaseCard from './DatabaseCard'
import GetStarted from './GetStarted'
import SwitchDatabase from './SwitchDatabase'
import HistoryPanel from './HistoryPanel'
import ReviewDialog from './ReviewDialog'
import { RestartChoice, RestartScreen, RestartSteps } from './RestartScreen'
import SettingField from './SettingField'
import TestConnection from './TestConnection'
import SaveBar from './SaveBar'
import { RAIL_LIST_SX, RAIL_NAV_SX, SEARCH_FIELD_SX, SENTENCE_CASE_BUTTONS, railItemSx, revealRailItem, saveBarRoom } from './layout'
import { SECTION_ICONS, readOnlyNote } from './sections'
import {
    GET_STARTED_DISMISSED,
    showGetStarted,
    cleanDrafts,
    effectiveValues,
    errorsByKey,
    groupSettings,
    isShown,
    matchesQuery,
    reviewRows,
    sectionCounts,
    testDrafts,
    testKindFor,
    testSignature,
    visibleProblems
} from './model'

const RAIL_WIDTH = 248

function readDismissed() {
    try {
        return globalThis.localStorage?.getItem(GET_STARTED_DISMISSED) === '1'
    } catch {
        return false
    }
}

const ServerSettings = () => {
    const theme = useTheme()
    const dispatch = useDispatch()
    const navigate = useNavigate()
    const [getStartedDismissed, setGetStartedDismissed] = useState(readDismissed)
    useNotifier()
    const notify = (message, variant = 'success') =>
        dispatch(
            enqueueSnackbarAction({
                message,
                options: {
                    key: Date.now() + Math.random(),
                    variant,
                    action: (key) => (
                        <Button style={{ color: 'white' }} onClick={() => dispatch(closeSnackbarAction(key))}>
                            <IconX />
                        </Button>
                    )
                }
            })
        )

    const [data, setData] = useState(null)
    const [loadError, setLoadError] = useState(null)
    const [active, setActive] = useState('signin')
    const [query, setQuery] = useState('')
    const [drafts, setDrafts] = useState({})
    const [fieldErrors, setFieldErrors] = useState({})
    const [reviewOpen, setReviewOpen] = useState(false)
    const [saving, setSaving] = useState(false)
    // Restarting in place: the full-screen progress. Otherwise the steps to restart by hand.
    const [restartScreen, setRestartScreen] = useState(null)
    const [restartStepsList, setRestartStepsList] = useState(null)
    const [restartChoice, setRestartChoice] = useState(null)
    const [historyKey, setHistoryKey] = useState(0)
    const [authKitOpen, setAuthKitOpen] = useState(false)
    const [authKitResume, setAuthKitResume] = useState(false)
    const [databaseDialog, setDatabaseDialog] = useState(null)
    const ownerEmail = useSelector((state) => state.auth?.user?.email)

    // Back from a test sign-in with AuthKit: open Sign-in and show the result.
    useEffect(() => {
        const params = new URLSearchParams(window.location.search)
        const section = params.get('section')
        if (section) setActive(section)
        if (params.get('authkit')) {
            setActive('signin')
            setAuthKitResume(true)
            setAuthKitOpen(true)
        }
        if (section || params.get('authkit')) window.history.replaceState(null, '', window.location.pathname)
    }, [])

    // After a restart: did the new settings start, or did safe boot put back the last ones that worked?
    const checkOutcome = useCallback(async () => Boolean((await serverSettingsApi.getSettings())?.data?.rolledBack), [])

    const load = useCallback(() => {
        serverSettingsApi
            .getSettings()
            .then((res) => {
                setData(res.data)
                setLoadError(null)
            })
            .catch((error) => setLoadError(error?.response?.status === 403 ? 'owner' : 'failed'))
    }, [])

    useEffect(() => load(), [load])

    const settings = useMemo(() => data?.settings ?? [], [data])
    const clean = useMemo(() => cleanDrafts(settings, drafts), [settings, drafts])
    const editedCount = Object.keys(clean).length
    const counts = useMemo(() => sectionCounts(settings, drafts), [settings, drafts])
    const effective = useMemo(() => effectiveValues(settings, drafts), [settings, drafts])
    const labels = useMemo(() => Object.fromEntries(settings.map((setting) => [setting.key, setting.label])), [settings])
    const pendingCount = data?.restart?.changed?.length ?? 0

    // Leaving with unsaved edits asks first.
    useEffect(() => {
        if (!editedCount) return undefined
        const warn = (event) => {
            event.preventDefault()
            event.returnValue = ''
        }
        window.addEventListener('beforeunload', warn)
        return () => window.removeEventListener('beforeunload', warn)
    }, [editedCount])

    const onDraft = (key, value) => {
        setDrafts((current) => {
            const next = { ...current }
            if (value === undefined) delete next[key]
            else next[key] = value
            return next
        })
        setFieldErrors((current) => {
            if (!current[key]) return current
            const next = { ...current }
            delete next[key]
            return next
        })
    }

    const save = async () => {
        setSaving(true)
        try {
            const res = await serverSettingsApi.saveSettings(clean)
            setData(res.data)
            setDrafts({})
            setFieldErrors({})
            setReviewOpen(false)
            setHistoryKey((n) => n + 1)
            const savedKeys = Object.keys(clean)
            const runtimeSaved = savedKeys.filter((key) => settings.find((setting) => setting.key === key)?.runtime).length
            const notice =
                runtimeSaved === savedKeys.length && savedKeys.length
                    ? 'Saved. These limits apply now.'
                    : runtimeSaved
                    ? 'Saved. Limits apply now. Restart Cuttlely to apply the rest.'
                    : 'Saved. Restart Cuttlely to apply.'
            notify(notice)
        } catch (error) {
            const errors = errorsByKey(error)
            setFieldErrors(errors)
            setReviewOpen(false)
            const first = Object.keys(errors)[0]
            const section = settings.find((setting) => setting.key === first)?.section
            if (section) setActive(section)
            notify(error?.response?.data?.message ?? 'The settings could not be saved.', 'error')
        } finally {
            setSaving(false)
        }
    }

    const discard = async () => {
        try {
            const res = await serverSettingsApi.discardChanges()
            setData(res.data)
            setDrafts({})
            setHistoryKey((n) => n + 1)
            notify('Saved changes discarded. Settings are back to what the server is running with.')
        } catch (error) {
            notify(error?.response?.data?.message ?? 'The changes could not be discarded.', 'error')
        }
    }

    const showRestart = (result, saved) => {
        if (result?.restarting) {
            // Clear earlier notices ("Saved. Restart Cuttlely to apply.") so they do not sit on the restart screen.
            dispatch(closeSnackbarAction())
            setRestartScreen({ saved, waitingFor: result.waitingFor ?? 0 })
        } else if (result?.steps?.length) setRestartStepsList(result.steps)
        else notify('A restart is already on its way.')
    }

    const startRestart = async (wait) => {
        setRestartChoice(null)
        const saved = data?.restart?.changed?.length ?? 0
        try {
            const res = await serverSettingsApi.restart(wait)
            showRestart(res.data, saved)
        } catch (error) {
            notify(error?.response?.data?.message ?? 'Cuttlely could not restart.', 'error')
        }
    }

    // Runs in progress: ask whether to let them finish. Reads a fresh count first.
    const restart = async () => {
        try {
            const res = await serverSettingsApi.getSettings()
            setData(res.data)
            if (res.data?.restart?.inPlace && res.data?.runs?.inProgress > 0) {
                setRestartChoice(res.data.runs)
                return
            }
        } catch {
            // the restart call itself reports problems
        }
        startRestart(true)
    }

    const retry = async () => {
        try {
            const res = await serverSettingsApi.retryRolledBack()
            setData(res.data)
            setHistoryKey((n) => n + 1)
            notify('The settings that did not start are back. Restart Cuttlely to try them again.')
        } catch (error) {
            notify(error?.response?.data?.message ?? 'The settings could not be put back.', 'error')
        }
    }

    // On a phone the sections are a sideways row: keep the open one in view (after search or a link opens a section).
    const railRef = useRef(null)
    useEffect(() => {
        const nav = railRef.current
        revealRailItem(nav, nav?.querySelector(`[data-testid="rail-${active}"]`))
    }, [active, data])

    const openSetting = (section, key) => {
        setQuery('')
        setActive(section)
        setTimeout(
            () => document.querySelector(`[data-testid="setting-${key}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
            50
        )
    }

    if (loadError) {
        return (
            <MainCard>
                <Box sx={{ py: 8, textAlign: 'center' }}>
                    <Typography variant='h3' sx={{ mb: 1 }}>
                        {loadError === 'owner' ? 'Only the owner can change server settings' : 'Server settings could not be loaded'}
                    </Typography>
                    <Typography color='text.secondary'>
                        {loadError === 'owner' ? 'Ask the owner of this server.' : 'Refresh the page to try again.'}
                    </Typography>
                </Box>
            </MainCard>
        )
    }

    const sections = data?.sections ?? []
    const searching = query.trim() !== ''
    const visibleIn = (sectionId) =>
        settings.filter(
            (setting) => setting.section === sectionId && isShown(setting, effective) && (!searching || matchesQuery(setting, query))
        )

    const railItem = (id, label, badge) => {
        const Icon = SECTION_ICONS[id]
        const selected = !searching && active === id
        return (
            <ButtonBase
                key={id}
                onClick={() => {
                    setQuery('')
                    setActive(id)
                }}
                data-testid={`rail-${id}`}
                aria-current={selected ? 'page' : undefined}
                sx={{
                    ...railItemSx,
                    justifyContent: 'flex-start',
                    gap: { xs: 1, md: 1.5 },
                    py: 1.1,
                    borderRadius: 2.5,
                    color: selected ? theme.palette.primary.main : theme.palette.text.primary,
                    backgroundColor: selected
                        ? alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.18 : 0.08)
                        : 'transparent',
                    transition: 'background-color 120ms ease',
                    '&:hover': { backgroundColor: selected ? undefined : alpha(theme.palette.text.primary, 0.04) }
                }}
            >
                {Icon && <Icon size={19} stroke={1.7} />}
                <Typography sx={{ fontWeight: selected ? 600 : 500, fontSize: '0.92rem', flexGrow: 1, textAlign: 'left' }} noWrap>
                    {label}
                </Typography>
                {badge}
            </ButtonBase>
        )
    }

    const countBadge = (id) => {
        const entry = counts[id]
        if (!entry) return null
        if (entry.edited) return <Dot color={theme.palette.primary.main} title={`${entry.edited} edited`} />
        if (entry.pending) return <Dot color={theme.palette.warning.main} title={`${entry.pending} wait for a restart`} />
        return null
    }

    const sectionView = (section) => {
        const visible = visibleIn(section.id)
        if (searching && visible.length === 0) return null
        return (
            <Box key={section.id} sx={{ mb: searching ? 4 : 0 }} data-testid={`section-${section.id}`}>
                <Stack direction='row' alignItems='center' gap={1.5} sx={{ mb: 0.75 }}>
                    {SECTION_ICONS[section.id] &&
                        (() => {
                            const Icon = SECTION_ICONS[section.id]
                            return (
                                <Box
                                    sx={{
                                        width: 38,
                                        height: 38,
                                        borderRadius: 2.5,
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        color: theme.palette.primary.main,
                                        backgroundColor: alpha(theme.palette.primary.main, 0.1)
                                    }}
                                >
                                    <Icon size={21} stroke={1.7} />
                                </Box>
                            )
                        })()}
                    <Typography variant='h2' sx={{ fontSize: '1.45rem', fontWeight: 650 }}>
                        {section.label}
                    </Typography>
                </Stack>
                <Typography color='text.secondary' sx={{ mb: 2, maxWidth: 720 }}>
                    {section.summary}
                </Typography>
                {section.id === 'models' && !searching && (
                    <Stack
                        direction={{ xs: 'column', sm: 'row' }}
                        alignItems={{ sm: 'center' }}
                        justifyContent='space-between'
                        gap={1.5}
                        sx={{ mb: 2, px: 2, py: 1.5, maxWidth: 720, borderRadius: 2.5, border: `1px solid ${theme.palette.divider}` }}
                        data-testid='models-credentials-hint'
                    >
                        <Typography variant='body2'>
                            Model keys live in Credentials, saved encrypted, one per provider. Flows pick the one they use.
                        </Typography>
                        <Button
                            size='small'
                            variant='outlined'
                            onClick={() => navigate('/credentials')}
                            sx={{ borderRadius: 2, flexShrink: 0 }}
                        >
                            Open Credentials
                        </Button>
                    </Stack>
                )}
                {!searching && (
                    <Stack
                        direction='row'
                        alignItems='flex-start'
                        gap={1.25}
                        sx={{
                            mb: 3,
                            px: 2,
                            py: 1.25,
                            borderRadius: 2.5,
                            maxWidth: 720,
                            backgroundColor: alpha(theme.palette.info.main, theme.palette.mode === 'dark' ? 0.12 : 0.06),
                            border: `1px solid ${alpha(theme.palette.info.main, 0.18)}`
                        }}
                    >
                        <IconRefresh size={17} style={{ marginTop: 2, flexShrink: 0, color: theme.palette.info.main }} />
                        <Typography variant='body2'>
                            <Box component='span' sx={{ fontWeight: 600 }}>
                                After a restart.{' '}
                            </Box>
                            {section.afterRestart}
                        </Typography>
                    </Stack>
                )}
                {!searching && section.id === 'signin' && (
                    <AuthKitCard
                        authKit={data?.authKit}
                        onOpen={() => {
                            setAuthKitResume(false)
                            setAuthKitOpen(true)
                        }}
                    />
                )}
                {!searching && section.id === 'database' && (
                    <DatabaseCard
                        database={data?.database}
                        onSwitch={() => setDatabaseDialog('switch')}
                        onRestore={() => setDatabaseDialog('restore')}
                    />
                )}
                <Stack gap={2.5}>
                    {groupSettings(visible).map((group) => (
                        <Box key={group.name || 'main'}>
                            {group.name && (
                                <Typography
                                    sx={{
                                        fontSize: '0.75rem',
                                        fontWeight: 700,
                                        letterSpacing: 0.8,
                                        textTransform: 'uppercase',
                                        color: 'text.secondary',
                                        mb: 1,
                                        ml: 0.5
                                    }}
                                >
                                    {group.name}
                                </Typography>
                            )}
                            <Paper
                                variant='outlined'
                                sx={{
                                    borderRadius: 3,
                                    overflow: 'hidden',
                                    '& > *:not(:first-of-type)': { borderTop: `1px solid ${theme.palette.divider}` }
                                }}
                            >
                                {group.settings.map((setting) => (
                                    <SettingField
                                        key={setting.key}
                                        setting={setting}
                                        drafts={drafts}
                                        onDraft={onDraft}
                                        error={fieldErrors[setting.key]}
                                        readOnlyNote={readOnlyNote(setting)}
                                    />
                                ))}
                            </Paper>
                        </Box>
                    ))}
                    {!searching && testKindFor(section.id) && (
                        <TestConnection
                            kind={testKindFor(section.id)}
                            values={testDrafts(settings, drafts, testKindFor(section.id))}
                            signature={testSignature(settings, drafts, testKindFor(section.id))}
                            edited={Object.keys(testDrafts(settings, drafts, testKindFor(section.id))).length > 0}
                        />
                    )}
                </Stack>
            </Box>
        )
    }

    const activeSection = sections.find((section) => section.id === active)

    return (
        <MainCard sx={{ pb: saveBarRoom(editedCount || pendingCount), ...SENTENCE_CASE_BUTTONS }}>
            <Stack
                direction={{ xs: 'column', sm: 'row' }}
                alignItems={{ sm: 'flex-end' }}
                justifyContent='space-between'
                gap={2}
                sx={{ mb: 3 }}
            >
                <Box>
                    <Typography variant='h1' sx={{ fontSize: '1.8rem', fontWeight: 600 }}>
                        Server settings
                    </Typography>
                    <Typography sx={{ mt: 1, color: 'text.secondary', fontWeight: 500 }}>
                        How this server runs. Runtime limits apply on the next use. The other settings wait for a restart.
                    </Typography>
                </Box>
                <OutlinedInput
                    size='small'
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder='Search settings'
                    inputProps={{ 'aria-label': 'Search settings', 'data-testid': 'settings-search' }}
                    sx={{ width: { xs: '100%', sm: 320 }, borderRadius: 2.5, ...SEARCH_FIELD_SX(theme.palette.background.paper) }}
                    startAdornment={
                        <InputAdornment position='start'>
                            <IconSearch size={16} color={theme.palette.text.secondary} />
                        </InputAdornment>
                    }
                    endAdornment={
                        query ? (
                            <InputAdornment position='end'>
                                <ButtonBase onClick={() => setQuery('')} aria-label='Clear search' sx={{ borderRadius: 1 }}>
                                    <IconX size={15} />
                                </ButtonBase>
                            </InputAdornment>
                        ) : null
                    }
                />
            </Stack>

            {data?.rolledBack && (
                <Alert
                    severity='warning'
                    sx={{ mb: 2, borderRadius: 2.5, alignItems: 'center' }}
                    data-testid='safe-boot-banner'
                    action={
                        <Stack direction='row' gap={1}>
                            <Button color='inherit' size='small' onClick={() => setActive('history')} sx={{ whiteSpace: 'nowrap' }}>
                                See what changed
                            </Button>
                            {data.retryAvailable && (
                                <Button
                                    color='inherit'
                                    size='small'
                                    onClick={retry}
                                    sx={{ whiteSpace: 'nowrap' }}
                                    data-testid='safe-boot-retry'
                                >
                                    Try it again
                                </Button>
                            )}
                        </Stack>
                    }
                >
                    The last two starts did not finish, so Cuttlely put back the last settings that started.
                </Alert>
            )}
            {data?.ignored && (
                <Alert severity='info' sx={{ mb: 2, borderRadius: 2.5 }}>
                    The saved settings are ignored on this start (CUTTLELY_IGNORE_ADMIN_SETTINGS is on). You can still change them; they
                    apply once that is off.
                </Alert>
            )}
            {showGetStarted(data, getStartedDismissed) && !searching && (
                <GetStarted
                    data={data}
                    onSkip={() => {
                        setGetStartedDismissed(true)
                        try {
                            globalThis.localStorage?.setItem(GET_STARTED_DISMISSED, '1')
                        } catch {
                            // private mode: hidden until the page reloads
                        }
                    }}
                    onOpen={(id) => {
                        if (id === 'models') return navigate('/credentials')
                        setActive(id)
                        if (id === 'signin' && !data?.authKit?.locked) {
                            setAuthKitResume(false)
                            setAuthKitOpen(true)
                        }
                    }}
                />
            )}
            {visibleProblems(data).map((problem) => (
                <Alert key={problem} severity='warning' sx={{ mb: 2, borderRadius: 2.5 }}>
                    {problem}
                </Alert>
            ))}

            <Stack direction={{ xs: 'column', md: 'row' }} gap={{ xs: 2, md: 4 }} alignItems='flex-start'>
                <Box
                    component='nav'
                    ref={railRef}
                    aria-label='Server settings sections'
                    sx={{ ...RAIL_NAV_SX, width: { xs: '100%', md: RAIL_WIDTH } }}
                >
                    {!data ? (
                        <Stack gap={1}>
                            {Array.from({ length: 9 }).map((_, i) => (
                                <Skeleton key={i} variant='rounded' height={38} sx={{ borderRadius: 2.5 }} />
                            ))}
                        </Stack>
                    ) : (
                        <Stack sx={RAIL_LIST_SX}>
                            {sections.map((section) => railItem(section.id, section.label, countBadge(section.id)))}
                            <Box
                                sx={{
                                    display: { xs: 'none', md: 'block' },
                                    my: 1.25,
                                    mx: 1.5,
                                    borderTop: `1px solid ${theme.palette.divider}`
                                }}
                            />
                            {railItem('all', 'All settings')}
                            {railItem('history', 'History')}
                        </Stack>
                    )}
                </Box>

                <Box sx={{ flexGrow: 1, minWidth: 0, width: '100%' }}>
                    {!data ? (
                        <Stack gap={2}>
                            <Skeleton variant='text' width={240} height={40} />
                            <Skeleton variant='rounded' height={320} sx={{ borderRadius: 3 }} />
                        </Stack>
                    ) : searching ? (
                        <>
                            {sections.map((section) => sectionView(section))}
                            {sections.every((section) => visibleIn(section.id).length === 0) && (
                                <Typography color='text.secondary' sx={{ py: 6, textAlign: 'center' }}>
                                    No setting matches that search. Try All settings to see everything.
                                </Typography>
                            )}
                        </>
                    ) : active === 'all' ? (
                        <>
                            <PanelTitle
                                title='All settings'
                                summary='Every setting, where its value comes from, and what stays out of the browser.'
                            />
                            <AllSettingsPanel
                                settings={settings}
                                sections={sections}
                                keptOut={data.keptOut ?? []}
                                query={query}
                                onOpen={openSetting}
                            />
                        </>
                    ) : active === 'history' ? (
                        <>
                            <PanelTitle
                                title='History'
                                summary='Every save, discard, restore and restart. Secret values are never recorded.'
                            />
                            <HistoryPanel labels={labels} refreshKey={historyKey} />
                        </>
                    ) : (
                        activeSection && sectionView(activeSection)
                    )}
                </Box>
            </Stack>

            {data && (editedCount > 0 || pendingCount > 0) && (
                <SaveBar
                    editedCount={editedCount}
                    pendingCount={pendingCount}
                    onReset={() => {
                        setDrafts({})
                        setFieldErrors({})
                    }}
                    onReview={() => setReviewOpen(true)}
                    onDiscard={discard}
                    onRestart={restart}
                    inPlace={Boolean(data?.restart?.inPlace)}
                />
            )}

            {data && (
                <AuthKitWizard
                    open={authKitOpen}
                    resume={authKitResume}
                    onClose={() => {
                        setAuthKitOpen(false)
                        setAuthKitResume(false)
                    }}
                    settings={settings}
                    ownerEmail={ownerEmail}
                    passwordLocked={Boolean(settings.find((setting) => setting.key === 'CUTTLELY_LOCAL_ADMIN')?.locked)}
                    onSaved={(view, keptPassword) => {
                        setData(view)
                        setAuthKitOpen(false)
                        setAuthKitResume(false)
                        setHistoryKey((n) => n + 1)
                        notify(
                            keptPassword
                                ? 'AuthKit saved. Restart Cuttlely to apply. Password sign-in stays on.'
                                : 'AuthKit saved. Restart Cuttlely to apply. After that, sign in with AuthKit.'
                        )
                    }}
                />
            )}
            {data && (
                <SwitchDatabase
                    open={Boolean(databaseDialog)}
                    mode={databaseDialog === 'restore' ? 'restore' : 'switch'}
                    onClose={() => setDatabaseDialog(null)}
                    settings={settings}
                    database={data.database}
                    onDone={(result) => {
                        setDatabaseDialog(null)
                        setHistoryKey((n) => n + 1)
                        load()
                        showRestart(result, 0)
                    }}
                />
            )}
            <ReviewDialog
                open={reviewOpen}
                rows={reviewRows(settings, drafts)}
                sections={sections}
                saving={saving}
                onClose={() => setReviewOpen(false)}
                onSave={save}
            />

            <RestartChoice
                open={Boolean(restartChoice)}
                runs={restartChoice}
                onClose={() => setRestartChoice(null)}
                onChoose={startRestart}
            />
            <RestartSteps open={Boolean(restartStepsList)} steps={restartStepsList} onClose={() => setRestartStepsList(null)} />
            <RestartScreen
                open={Boolean(restartScreen)}
                saved={restartScreen?.saved ?? 0}
                waitingFor={restartScreen?.waitingFor ?? 0}
                checkOutcome={checkOutcome}
                onBack={(outcome) => {
                    setRestartScreen(null)
                    setHistoryKey((n) => n + 1)
                    if (outcome === 'rolled-back') setActive('history')
                    load()
                }}
            />
        </MainCard>
    )
}

const PanelTitle = ({ title, summary }) => (
    <Box sx={{ mb: 3 }}>
        <Typography variant='h2' sx={{ fontSize: '1.45rem', fontWeight: 650 }}>
            {title}
        </Typography>
        <Typography color='text.secondary' sx={{ mt: 0.75 }}>
            {summary}
        </Typography>
    </Box>
)

const Dot = ({ color, title }) => (
    <Box component='span' title={title} sx={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: color, flexShrink: 0 }} />
)

PanelTitle.propTypes = { title: PropTypes.string.isRequired, summary: PropTypes.string }
Dot.propTypes = { color: PropTypes.string.isRequired, title: PropTypes.string }

export default ServerSettings
