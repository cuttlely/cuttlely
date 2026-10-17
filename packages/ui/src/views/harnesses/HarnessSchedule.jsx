import { useEffect, useMemo, useState } from 'react'
import PropTypes from 'prop-types'

import { Alert, Autocomplete, Button, FormControlLabel, Paper, Stack, Switch, TextField, Typography } from '@mui/material'

import harnessesApi from '@/api/harnesses'
import { StyledPermissionButton } from '@/ui-component/button/RBACButtons'
import ConfirmDialog from '@/ui-component/dialog/ConfirmDialog'
import { useAuth } from '@/hooks/useAuth'
import useConfirm from '@/hooks/useConfirm'
import { formatListDateTime } from '@/utils/formatDate'
import { browserTimeZone, ownerLabel, timeZoneOptions } from './scheduleOptions'

const RUN_PERMISSION = 'chatflows:create,chatflows:update,agentflows:create'

function errorText(error, fallback) {
    const data = error?.response?.data
    if (data && typeof data === 'object' && data.message) return data.message
    if (typeof data === 'string' && data) return data.slice(0, 300)
    return fallback
}

const HarnessSchedule = ({ name, onChanged }) => {
    const { hasPermission } = useAuth()
    const { confirm } = useConfirm()
    const canRun = hasPermission(RUN_PERMISSION)
    const zones = useMemo(() => timeZoneOptions(), [])
    const [schedule, setSchedule] = useState(null)
    const [loaded, setLoaded] = useState(false)
    const [cron, setCron] = useState('0 7 * * 1-5')
    const [timezone, setTimezone] = useState(browserTimeZone())
    const [question, setQuestion] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')

    const show = (next) => {
        setSchedule(next)
        if (next) {
            setCron(next.cron)
            setTimezone(next.timezone)
            setQuestion(next.question)
        }
    }

    useEffect(() => {
        if (!name) return
        let cancelled = false
        harnessesApi
            .getSchedule(name)
            .then((res) => {
                if (!cancelled) show(res.data?.schedule || null)
            })
            .catch((err) => {
                if (!cancelled) setError(errorText(err, 'Could not load the schedule.'))
            })
            .finally(() => {
                if (!cancelled) setLoaded(true)
            })
        return () => {
            cancelled = true
        }
    }, [name])

    const act = async (call, fallback) => {
        setBusy(true)
        setError('')
        try {
            const res = await call()
            show(res.data?.schedule ?? null)
            onChanged?.()
        } catch (err) {
            setError(errorText(err, fallback))
        } finally {
            setBusy(false)
        }
    }

    const save = () =>
        act(
            () => harnessesApi.saveSchedule(name, { cron, timezone, question, active: schedule ? schedule.status === 'active' : true }),
            'The schedule was not saved.'
        )
    const toggle = () =>
        act(
            () => (schedule?.status === 'active' ? harnessesApi.pauseSchedule(name) : harnessesApi.resumeSchedule(name)),
            'The schedule did not change.'
        )
    const remove = async () => {
        const confirmed = await confirm({
            title: 'Delete schedule',
            description: `Delete the schedule for ${name}? It stops running. Its past runs stay under Runs.`,
            confirmButtonName: 'Delete schedule',
            cancelButtonName: 'Cancel'
        })
        if (!confirmed) return
        await act(() => harnessesApi.deleteSchedule(name).then(() => ({ data: { schedule: null } })), 'The schedule was not deleted.')
    }

    return (
        <Paper variant='outlined' sx={{ p: 2, borderRadius: 2 }}>
            <Stack sx={{ gap: 1.5 }}>
                <Stack direction='row' justifyContent='space-between' alignItems='center' sx={{ gap: 1, flexWrap: 'wrap' }}>
                    <Typography variant='h4'>Schedule</Typography>
                    {schedule && (
                        <FormControlLabel
                            control={<Switch checked={schedule.status === 'active'} onChange={toggle} disabled={busy || !canRun} />}
                            label={schedule.status === 'active' ? 'Active' : 'Paused'}
                        />
                    )}
                </Stack>
                <Typography color='text.secondary'>
                    Runs Live on a cron schedule, in the time zone you choose, with the permissions of the person who saved it. A run does
                    not start while the previous one is still going. Scheduled runs show under Runs as <code>schedule</code>.
                </Typography>
                {schedule && (
                    <Typography variant='body2'>
                        Runs as {ownerLabel(schedule.owner)}.{' '}
                        {schedule.status === 'active' && schedule.nextRunAt
                            ? `Next run ${formatListDateTime(schedule.nextRunAt)}.`
                            : 'Paused, so nothing runs until you turn it back on.'}
                        {schedule.lastResult ? ` Last: ${schedule.lastResult}${schedule.lastReason ? `. ${schedule.lastReason}` : ''}` : ''}
                    </Typography>
                )}
                {!loaded ? (
                    <Typography color='text.secondary'>Loading the schedule.</Typography>
                ) : (
                    <>
                        <Stack direction={{ xs: 'column', md: 'row' }} sx={{ gap: 1.5 }}>
                            <TextField
                                label='Cron (minute hour day month weekday)'
                                value={cron}
                                onChange={(event) => setCron(event.target.value)}
                                size='small'
                                sx={{ minWidth: 260 }}
                                disabled={busy || !canRun}
                                helperText='0 7 * * 1-5 is 07:00 on weekdays'
                            />
                            <Autocomplete
                                options={zones}
                                value={timezone}
                                onChange={(_event, value) => setTimezone(value || 'UTC')}
                                disableClearable
                                size='small'
                                sx={{ minWidth: 260 }}
                                disabled={busy || !canRun}
                                renderInput={(params) => <TextField {...params} label='Time zone' />}
                            />
                        </Stack>
                        <TextField
                            label='Question for each run'
                            value={question}
                            onChange={(event) => setQuestion(event.target.value)}
                            multiline
                            minRows={2}
                            fullWidth
                            disabled={busy || !canRun}
                        />
                        <Stack direction='row' alignItems='center' sx={{ gap: 1, flexWrap: 'wrap' }}>
                            <StyledPermissionButton
                                permissionId={RUN_PERMISSION}
                                variant='contained'
                                onClick={save}
                                disabled={busy || !cron.trim() || !question.trim()}
                                sx={{ borderRadius: 2, height: 40 }}
                            >
                                {schedule ? 'Save schedule' : 'Add schedule'}
                            </StyledPermissionButton>
                            {schedule && canRun && (
                                <Button
                                    variant='outlined'
                                    color='error'
                                    onClick={remove}
                                    disabled={busy}
                                    sx={{ borderRadius: 2, height: 40 }}
                                >
                                    Delete schedule
                                </Button>
                            )}
                            {canRun && (
                                <Typography variant='body2' color='text.secondary'>
                                    Saving makes you the owner, so the schedule runs with your permissions.
                                </Typography>
                            )}
                        </Stack>
                    </>
                )}
                {error && <Alert severity='error'>{error}</Alert>}
            </Stack>
            <ConfirmDialog />
        </Paper>
    )
}

HarnessSchedule.propTypes = {
    name: PropTypes.string,
    onChanged: PropTypes.func
}

export default HarnessSchedule
