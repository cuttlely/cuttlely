import { useCallback, useEffect, useState } from 'react'
import PropTypes from 'prop-types'
import { Alert, Button, Checkbox, FormControlLabel, LinearProgress, Paper, Stack, Typography } from '@mui/material'
import serverSettingsApi from '@/api/serverSettings'

const storagePhase = {
    sqlite: 'SQLite',
    copying: 'Copying',
    retiring: 'Retaining SQLite originals',
    postgres: 'PostgreSQL',
    restoring: 'Restoring SQLite'
}
const rowCount = (number) => number + (number === 1 ? ' row' : ' rows')

const actionLabels = {
    'stop-jobs': 'Stopping all jobs',
    'check-stop': 'Checking remaining work',
    'resume-jobs': 'Resuming new jobs',
    upgrade: 'Upgrading storage to PostgreSQL',
    rollback: 'Restoring SQLite storage'
}
function StorageActivity({ action, initial, waitingFor, onIdle }) {
    const [activity, setActivity] = useState(initial)
    const [lastResponse, setLastResponse] = useState(initial ? Date.now() : null)
    const [unreachable, setUnreachable] = useState(false)
    const [failure, setFailure] = useState(null)
    const [openedAt] = useState(Date.now)
    const [now, setNow] = useState(Date.now)
    useEffect(() => {
        let live = true
        let timer
        const check = async () => {
            try {
                const { data } = await serverSettingsApi.storageProgress()
                if (!live) return
                setLastResponse(Date.now())
                setFailure(data.failure)
                setUnreachable(false)
                setActivity(data.activity)
                if (!data.activity && onIdle) {
                    onIdle()
                    return
                }
            } catch {
                if (live) setUnreachable(true)
            }
            if (live) timer = setTimeout(check, 2000)
        }
        check()
        const clock = setInterval(() => setNow(Date.now()), 1000)
        return () => {
            live = false
            clearTimeout(timer)
            clearInterval(clock)
        }
    }, [onIdle])
    const seconds = Math.max(0, Math.floor((now - (initial?.startedAt || openedAt)) / 1000))
    const message =
        activity?.message || (waitingFor?.length ? 'Waiting for ' + waitingFor.join(', ') + ' to finish.' : 'Waiting for the server…')
    return (
        <Stack spacing={0.5}>
            <Typography role='status'>
                <strong>{actionLabels[activity?.action || action]}</strong> ·{' '}
                {failure?.message || (unreachable ? 'Server status unavailable. Reconnecting…' : message)}
            </Typography>
            {!failure && <LinearProgress aria-label='Storage operation in progress' />}
            <Typography variant='caption'>
                Elapsed {Math.floor(seconds / 60)}m {seconds % 60}s
                {lastResponse && ' · Last server response ' + Math.max(0, Math.floor((now - lastResponse) / 1000)) + 's ago'}
            </Typography>
        </Stack>
    )
}

StorageActivity.propTypes = {
    action: PropTypes.string.isRequired,
    initial: PropTypes.shape({ action: PropTypes.string, message: PropTypes.string, startedAt: PropTypes.number }),
    waitingFor: PropTypes.arrayOf(PropTypes.string),
    onIdle: PropTypes.func
}

export default function StorageUpgradeCard() {
    const [state, setState] = useState(null)
    const [pending, setPending] = useState('loading')
    const [observed, setObserved] = useState(null)
    const busy = Boolean(pending || observed)
    const [error, setError] = useState('')
    const [confirmStop, setConfirmStop] = useState(false)
    const [confirmedFor, setConfirmedFor] = useState(null)
    const refresh = useCallback(async () => setState((await serverSettingsApi.storageStatus()).data), [])
    const readPanel = useCallback(async () => {
        const { data } = await serverSettingsApi.storageProgress()
        if (data.failure) {
            setState(null)
            throw new Error(data.failure.message)
        }
        setObserved(data.activity)
        if (!data.activity) await refresh()
    }, [refresh])
    const recheck = useCallback(async () => {
        setPending('loading')
        setObserved(null)
        setError('')
        try {
            await readPanel()
        } catch (e) {
            setError(e.response?.data?.message || e.message || 'Storage status could not be loaded.')
        } finally {
            setPending(null)
        }
    }, [readPanel])
    useEffect(() => {
        recheck()
    }, [recheck])
    const stopping = state?.jobsPaused && !state?.stopComplete && state.phase === 'sqlite'
    useEffect(() => {
        if (!stopping || busy || error) return
        let cancelled = false
        let timer
        const check = async () => {
            try {
                const { data } = await serverSettingsApi.changeStorage('check-stop', {})
                if (cancelled) return
                setState(data)
                if (data.jobsPaused && !data.stopComplete) timer = setTimeout(check, 2000)
            } catch (e) {
                if (!cancelled) setError(e.response?.data?.message || 'Could not check job cancellation. Select Check again to retry.')
            }
        }
        timer = setTimeout(check, 2000)
        return () => {
            cancelled = true
            clearTimeout(timer)
        }
    }, [stopping, busy, error])
    if (!state?.available && !error && !busy) return null
    const rollback = state?.phase === 'postgres' || state?.phase === 'restoring'
    const needsCapacity = state?.phase === 'sqlite'
    const active = needsCapacity
        ? state.stores.filter((store) => store.busy).flatMap((store) => (store.active?.length ? store.active : [store.kind]))
        : []
    const unresolvedCount = state?.unresolved?.length || 0
    const dependencyCount = state?.dependencies?.length || 0
    const blockers = []
    if (!rollback && state?.available) {
        if (!state.enabled) blockers.push('Set CUTTLELY_APP_DATABASE_STORES=1 on the server and restart it.')
        if (stopping) blockers.push('Waiting for active work to stop before upgrading.')
        else if (active.length) blockers.push('Finish or stop active work (' + active.join(', ') + ').')
        if (unresolvedCount)
            blockers.push(
                'Review ' + unresolvedCount + ' local ' + (unresolvedCount === 1 ? 'path' : 'paths') + ' under Local files below.'
            )
        if (dependencyCount) blockers.push('Resolve the team inputs listed under Local dependencies below.')
    }
    const minimumBytes = state?.requiredBytes || 0
    const minimumMiB = Math.ceil(minimumBytes / 1048576)
    const confirmationKey = state?.phase + '/' + minimumMiB
    const confirmed = confirmedFor === confirmationKey
    async function changeJobs(stop) {
        setPending(stop ? 'stop-jobs' : 'resume-jobs')
        setError('')
        setConfirmStop(false)
        try {
            const { data } = await serverSettingsApi.changeStorage(stop ? 'stop-jobs' : 'resume-jobs', stop ? { confirm: 'STOP' } : {})
            setState(data)
        } catch (e) {
            setError(e.response?.data?.message || 'Could not change job admission. Check again for the current status.')
            await readPanel().catch(() => {})
        } finally {
            setPending(null)
        }
    }
    async function submit() {
        setPending(rollback ? 'rollback' : 'upgrade')
        setError('')
        try {
            const { data } = await serverSettingsApi.changeStorage(rollback ? 'rollback' : 'upgrade', {
                availableBytes: needsCapacity ? minimumMiB * 1048576 : 0,
                confirm: rollback ? 'ROLLBACK' : undefined
            })
            setState(data)
            setConfirmedFor(null)
        } catch (e) {
            setError(e.response?.data?.message || 'The request did not finish. Check storage status before retrying.')
            await readPanel().catch(() => {})
        } finally {
            setPending(null)
        }
    }
    return (
        <Paper variant='outlined' sx={{ p: 2.5, mb: 3, maxWidth: 880 }}>
            <Stack spacing={1.5}>
                <Typography variant='h3'>Application database storage</Typography>
                {error && (
                    <Alert
                        severity='error'
                        action={
                            <Button disabled={busy} onClick={recheck}>
                                Check again
                            </Button>
                        }
                    >
                        {error}
                    </Alert>
                )}
                {observed || (pending && pending !== 'loading') || (stopping && !error && !pending) ? (
                    <StorageActivity
                        key={observed?.action || pending || 'stop-jobs'}
                        action={observed?.action || pending || 'stop-jobs'}
                        initial={observed}
                        waitingFor={stopping ? state.waitingFor : undefined}
                        onIdle={observed ? recheck : undefined}
                    />
                ) : pending === 'loading' ? (
                    <Stack spacing={0.5}>
                        <Typography role='status'>Checking storage and available upgrade actions…</Typography>
                        <LinearProgress aria-label='Checking storage' />
                    </Stack>
                ) : null}
                {state?.failure && <Alert severity='error'>{state.failure.message}</Alert>}
                {state?.available && (
                    <>
                        <Typography>
                            Storage status: {storagePhase[state.phase] || state.phase}. ETL, vector collections and agent team stores can
                            share the application PostgreSQL database.
                        </Typography>
                        {!busy && ['copying', 'retiring', 'restoring'].includes(state.phase) && (
                            <Alert severity='warning'>
                                {rollback
                                    ? 'The restore is paused. Confirm below to resume it.'
                                    : 'The upgrade is paused. Confirm below to resume it.'}
                            </Alert>
                        )}
                        {blockers.length > 0 && (
                            <Alert
                                severity='warning'
                                action={
                                    <Button disabled={busy} onClick={recheck}>
                                        Check again
                                    </Button>
                                }
                            >
                                <strong>Before you can upgrade</strong>
                                <ul>
                                    {blockers.map((message) => (
                                        <li key={message}>{message}</li>
                                    ))}
                                </ul>
                            </Alert>
                        )}
                        {needsCapacity &&
                            (state.jobsPaused ? (
                                <Stack alignItems='flex-start'>
                                    {!stopping && (
                                        <Typography role='status'>
                                            Jobs have stopped. New jobs are paused for the storage upgrade.
                                        </Typography>
                                    )}
                                    <Button disabled={busy} onClick={() => changeJobs(false)}>
                                        Resume new jobs
                                    </Button>
                                </Stack>
                            ) : confirmStop ? (
                                <Alert severity='warning'>
                                    Stop jobs for every team and pause new work on this instance for the upgrade? Running jobs may have
                                    already performed part of their work. Stop standalone workers that share the old files first.
                                    <Stack direction='row' spacing={1}>
                                        <Button color='error' disabled={busy} onClick={() => changeJobs(true)}>
                                            Stop jobs and pause new work
                                        </Button>
                                        <Button disabled={busy} onClick={() => setConfirmStop(false)}>
                                            Keep jobs running
                                        </Button>
                                    </Stack>
                                </Alert>
                            ) : (
                                <Button sx={{ alignSelf: 'flex-start' }} disabled={busy} onClick={() => setConfirmStop(true)}>
                                    Stop all jobs
                                </Button>
                            ))}
                        <Alert severity='info'>
                            PostgreSQL restores saved chats, runtime settings and memory notes. Files created by code execution, such as
                            documents and images, can disappear when a container is replaced. Direct shell edits to runtime settings also
                            depend on the local disk.
                        </Alert>
                        <FormControlLabel
                            control={
                                <Checkbox
                                    checked={confirmed}
                                    onChange={(e) => setConfirmedFor(e.target.checked ? confirmationKey : null)}
                                />
                            }
                            label={
                                rollback
                                    ? 'I understand rollback restores pre-upgrade SQLite data. Later writes stay in PostgreSQL.'
                                    : needsCapacity
                                    ? 'I have backed up the application database and checked that my PostgreSQL host has at least ' +
                                      minimumMiB +
                                      ' MiB free.'
                                    : 'I have backed up the application database and am ready to resume the upgrade.'
                            }
                        />
                        <Button
                            variant='contained'
                            disabled={busy || Boolean(state.failure) || !confirmed || blockers.length > 0}
                            onClick={submit}
                        >
                            {rollback ? 'Restore retained SQLite files' : needsCapacity ? 'Upgrade storage' : 'Resume storage upgrade'}
                        </Button>
                        {needsCapacity && state.runtimeFiles?.length > 0 && (
                            <Alert severity='info'>
                                {state.runtimeFiles.length} runtime files and directories included. Upgrade storage encrypts the snapshot
                                with your installation key. Supply that same key when starting a replacement host.
                            </Alert>
                        )}
                        {state.versions && (
                            <Typography>
                                Flow version history · {Math.ceil(state.versions.bytes / 1024)} KiB at revision{' '}
                                {state.versions.head.slice(0, 12)}
                            </Typography>
                        )}
                        {state.stores.map((s) => (
                            <details key={s.kind + '/' + (s.name || '')}>
                                <summary>
                                    {s.kind}
                                    {s.name ? ' / ' + s.name : ''} · {rowCount(Object.values(s.counts).reduce((a, b) => a + b, 0))}
                                    {s.retired ? ' · retained SQLite copy' : ''}
                                    {s.busy ? ' · busy' : ''}
                                </summary>
                                <ul>
                                    {Object.entries(s.counts).map(([table, count]) => (
                                        <li key={table}>
                                            {table} · {rowCount(count)}
                                        </li>
                                    ))}
                                </ul>
                            </details>
                        ))}
                        {needsCapacity && state.prompts?.length > 0 && (
                            <Alert severity='info'>
                                <strong>
                                    {state.prompts.length} profile {state.prompts.length === 1 ? 'prompt' : 'prompts'} included in the
                                    upgrade
                                </strong>
                                <div>Upgrade storage verifies and copies these prompts to PostgreSQL.</div>
                                <details>
                                    <summary>Show prompt files</summary>
                                    <ul>
                                        {state.prompts.map(({ name }) => (
                                            <li key={name}>{name}</li>
                                        ))}
                                    </ul>
                                </details>
                            </Alert>
                        )}
                        {unresolvedCount > 0 && (
                            <details>
                                <summary>Local files ({unresolvedCount})</summary>
                                <p>
                                    Supply immutable inputs through the verified file manifest, move mutable files to durable storage, or
                                    retire the dependency.
                                </p>
                                <ul>
                                    {state.unresolved.map((location) => (
                                        <li key={location}>{location}</li>
                                    ))}
                                </ul>
                            </details>
                        )}
                        {dependencyCount > 0 && (
                            <details>
                                <summary>Local dependencies ({dependencyCount})</summary>
                                <ul>
                                    {state.dependencies.map((item, i) => (
                                        <li key={i}>
                                            Team {item.workspace} · Flow {item.flow} ({item.revision}) · {item.node} · {item.input} ·{' '}
                                            {item.location}
                                            <div>{item.resolution}</div>
                                        </li>
                                    ))}
                                </ul>
                            </details>
                        )}
                        {state.temporary?.length > 0 && (
                            <details>
                                <summary>Temporary data Cuttlely can rebuild</summary>
                                <ul>
                                    {state.temporary.map((message) => (
                                        <li key={message}>{message}</li>
                                    ))}
                                </ul>
                            </details>
                        )}
                        {state.local.length > 0 && (
                            <details>
                                <summary>Agent runtime session databases</summary>
                                {state.local.map((item) => (
                                    <div key={item.name}>
                                        {item.name} ·{' '}
                                        {item.unavailable
                                            ? 'counts unavailable'
                                            : Object.entries(item.counts)
                                                  .map(([name, count]) => name + ' ' + count)
                                                  .join(', ')}
                                    </div>
                                ))}
                            </details>
                        )}
                        {state.report && Object.keys(state.report).length > 0 && (
                            <details>
                                <summary>Verification report</summary>
                                <pre style={{ overflowX: 'auto' }}>{JSON.stringify(state.report, null, 2)}</pre>
                            </details>
                        )}
                        {state.reminder && (
                            <Alert severity='info'>
                                The retained SQLite files are at least 30 days old. Keep them while you need rollback.
                            </Alert>
                        )}
                    </>
                )}
            </Stack>
        </Paper>
    )
}
