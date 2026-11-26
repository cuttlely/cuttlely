import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Checkbox, FormControlLabel, Paper, Stack, TextField, Typography } from '@mui/material'
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
    const [capacity, setCapacity] = useState('')
    const [confirmed, setConfirmed] = useState(false)
    const refresh = useCallback(async () => setState((await serverSettingsApi.storageStatus()).data), [])
    useEffect(() => {
        refresh().catch(() => setError('Storage status could not be loaded.'))
    }, [refresh])
    if (!state?.available && !error) return null
    const rollback = state?.phase === 'postgres' || state?.phase === 'restoring'
    const needsCapacity = state?.phase === 'sqlite'
    async function submit() {
        setBusy(true)
        setError('')
        try {
            await serverSettingsApi.changeStorage(rollback ? 'rollback' : 'upgrade', {
                availableBytes: Math.floor(Number(capacity) * 1024 * 1024),
                confirm: rollback ? 'ROLLBACK' : undefined
            })
            setConfirmed(false)
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
                                <div>
                                    Upgrade storage saves these prompts in PostgreSQL for a replacement host. Back up later prompt edits
                                    separately.
                                </div>
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
                        {state.temporary?.length > 0 && (
                            <Alert severity='info'>
                                Temporary data Cuttlely can rebuild
                                <ul>
                                    {state.temporary.map((message) => (
                                        <li key={message}>{message}</li>
                                    ))}
                                </ul>
                            </Alert>
                        )}
                        {state.unresolved?.length > 0 && (
                            <Alert severity='warning'>
                                These paths depend on the current disk. Supply immutable inputs on each host using the verified file
                                manifest, move mutable data to a durable service, or retire the dependency before cutover.
                                <ul>
                                    {state.unresolved.map((location) => (
                                        <li key={location}>{location}</li>
                                    ))}
                                </ul>
                            </Alert>
                        )}
                        {state.dependencies?.length > 0 && (
                            <Alert severity='warning'>
                                Resolve these local dependencies before moving storage.
                                <ul>
                                    {state.dependencies.map((item, i) => (
                                        <li key={i}>
                                            Team {item.workspace} · Flow {item.flow} ({item.revision}) · {item.node} · {item.input} ·{' '}
                                            {item.location}
                                            <div>{item.resolution}</div>
                                        </li>
                                    ))}
                                </ul>
                            </Alert>
                        )}
                        <Alert severity='info'>
                            If this host loses its local disk, the agent runtime starts fresh sessions. Runtime-only messages and
                            undelivered replies or task results can be lost. Clients can start a new conversation at the same endpoint.
                        </Alert>
                        {state.local.length > 0 && (
                            <details>
                                <summary>Agent runtime databases kept on disk</summary>
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
                        {!state.enabled && (
                            <Alert severity='info'>Set CUTTLELY_APP_DATABASE_STORES=1 and restart to enable the upgrade.</Alert>
                        )}
                        {needsCapacity && (
                            <TextField
                                label='Available PostgreSQL space (MiB)'
                                value={capacity}
                                onChange={(e) => setCapacity(e.target.value)}
                                type='number'
                                helperText={
                                    'Check the database host. Estimated minimum: ' + Math.ceil(state.requiredBytes / 1048576) + ' MiB.'
                                }
                            />
                        )}
                        <FormControlLabel
                            control={<Checkbox checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />}
                            label={
                                rollback
                                    ? 'I understand rollback restores pre-upgrade SQLite data. Later writes stay in PostgreSQL.'
                                    : 'I have backed up the application database. Pause new work and verify the SQLite copies.'
                            }
                        />
                        <Button
                            variant='contained'
                            disabled={
                                busy ||
                                !confirmed ||
                                (!rollback && (state.dependencies?.length > 0 || state.unresolved?.length > 0)) ||
                                (!rollback && !state.enabled) ||
                                (needsCapacity && (!capacity || Number(capacity) * 1048576 < state.requiredBytes))
                            }
                            onClick={submit}
                        >
                            {busy
                                ? 'Working…'
                                : rollback
                                ? 'Restore retained SQLite files'
                                : needsCapacity
                                ? 'Upgrade storage'
                                : 'Resume storage upgrade'}
                        </Button>
                    </>
                )}
            </Stack>
        </Paper>
    )
}
