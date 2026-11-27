import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Checkbox, FormControlLabel, Paper, Stack, Typography } from '@mui/material'
import serverSettingsApi from '@/api/serverSettings'

const storagePhase = {
    sqlite: 'SQLite',
    copying: 'Copying',
    retiring: 'Retaining SQLite originals',
    postgres: 'PostgreSQL',
    restoring: 'Restoring SQLite'
}
const rowCount = (number) => number + (number === 1 ? ' row' : ' rows')

export default function StorageUpgradeCard() {
    const [state, setState] = useState(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [confirmedFor, setConfirmedFor] = useState(null)
    const refresh = useCallback(async () => setState((await serverSettingsApi.storageStatus()).data), [])
    useEffect(() => {
        refresh().catch(() => setError('Storage status could not be loaded.'))
    }, [refresh])
    if (!state?.available && !error) return null
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
        if (active.length) blockers.push('Finish or stop active work (' + active.join(', ') + ').')
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
    async function recheck() {
        setBusy(true)
        setError('')
        try {
            await refresh()
        } catch {
            setError('Storage status could not be loaded.')
        } finally {
            setBusy(false)
        }
    }
    async function submit() {
        setBusy(true)
        setError('')
        try {
            await serverSettingsApi.changeStorage(rollback ? 'rollback' : 'upgrade', {
                availableBytes: needsCapacity ? minimumMiB * 1048576 : 0,
                confirm: rollback ? 'ROLLBACK' : undefined
            })
            setConfirmedFor(null)
        } catch (e) {
            setError(e.response?.data?.message || 'The request did not finish. Check storage status before retrying.')
        } finally {
            try {
                await refresh()
            } catch {
                setError('Storage status could not be loaded.')
            }
            setBusy(false)
        }
    }
    return (
        <Paper variant='outlined' sx={{ p: 2.5, mb: 3, maxWidth: 880 }}>
            <Stack spacing={1.5}>
                <Typography variant='h3'>Application database storage</Typography>
                {error && <Alert severity='error'>{error}</Alert>}
                {state?.available && (
                    <>
                        <Typography>
                            Storage status: {storagePhase[state.phase] || state.phase}. ETL, vector collections and agent team stores can
                            share the application PostgreSQL database.
                        </Typography>
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
                        <Button variant='contained' disabled={busy || !confirmed || blockers.length > 0} onClick={submit}>
                            {busy
                                ? 'Working…'
                                : rollback
                                ? 'Restore retained SQLite files'
                                : needsCapacity
                                ? 'Upgrade storage'
                                : 'Resume storage upgrade'}
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
