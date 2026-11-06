import { useEffect, useState } from 'react'
import { Button, LinearProgress } from '@mui/material'
import PropTypes from 'prop-types'

const elapsed = (ms) => {
    const seconds = Math.max(0, Math.floor(ms / 1000))
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}
export default function RefreshStatus({ record, onRetry, disabled, onCancel, cancelling }) {
    const [now, setNow] = useState(Date.now())
    useEffect(() => {
        if (!record?.refreshing) return
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
    }, [record?.refreshing])
    const progress = record?.refreshProgress
    if (!progress && !record?.refreshing) return null
    const status = progress?.status || 'running'
    const running = record?.refreshing
    const failed = status === 'failed' || status === 'interrupted' || status === 'cancelled'
    const ready = Object.keys(record?.snapshot?.pipelineViews?.views || {}).length
    const titles = {
        starting: 'Connecting to your sources',
        sources: 'Validating dashboard cards',
        views: 'Preparing instant filter views',
        saving: 'Saving the complete snapshot'
    }
    const title = running
        ? titles[progress?.phase] || titles.starting
        : status === 'cancelled'
        ? 'Refresh cancelled'
        : failed
        ? status === 'interrupted'
            ? 'Refresh interrupted'
            : 'Refresh failed'
        : 'Refresh complete'
    const end = progress?.finishedAt ? Date.parse(progress.finishedAt) : now
    const duration = progress?.startedAt ? elapsed(end - Date.parse(progress.startedAt)) : null
    const failures = progress?.failedItems || progress?.failedViews || []
    const waiting = running && progress?.updatedAt && now - Date.parse(progress.updatedAt) > 60000
    return (
        <section className={`df-refresh-status ${failed ? 'df-refresh-failed' : ''}`} aria-label='Refresh status'>
            <div className='df-refresh-heading'>
                <div role='status' aria-live='polite'>
                    <strong>{title}</strong>
                    <span>
                        {running && progress?.total
                            ? `${progress.completed} / ${progress.total} ${
                                  progress.phase === 'views' ? 'period/region views ready' : 'cards validated'
                              }`
                            : !failed && !running
                            ? `${ready ? `${ready} cached views prepared · ` : ''}Ready to publish`
                            : 'The previous published dashboard is unchanged.'}
                    </span>
                </div>
                <div className='df-refresh-clock'>{duration && `${running ? 'Elapsed' : 'Duration'} ${duration}`}</div>
            </div>
            {running && (
                <LinearProgress
                    variant={progress?.total && progress.phase !== 'saving' ? 'determinate' : 'indeterminate'}
                    value={progress?.total ? (progress.completed / progress.total) * 100 : 0}
                />
            )}
            {!!progress?.active?.length && (
                <div className='df-refresh-jobs'>
                    {progress.active.map((job) => (
                        <span key={job}>{job}</span>
                    ))}
                </div>
            )}
            {!!failures.length && <p>Could not prepare: {failures.join(', ')}</p>}
            {waiting && <p>Waiting for source results. Last progress update {elapsed(now - Date.parse(progress.updatedAt))} ago.</p>}
            <div className='df-refresh-details'>
                <span>
                    {record?.snapshot
                        ? `${running || failed ? 'Showing last successful snapshot' : 'Snapshot saved'} · ${new Date(
                              record.snapshot.refreshedAt
                          ).toLocaleString()}`
                        : 'No successful snapshot for this saved definition yet.'}
                </span>
                {running && <span>You can leave this page; preparation continues in the background.</span>}
                {failed && (
                    <span>
                        {status === 'interrupted'
                            ? 'The worker stopped or restarted. Retry to start a new refresh.'
                            : status === 'cancelled'
                            ? 'Old results cannot replace this dashboard. A source query already in flight may finish or time out.'
                            : record?.error || 'Check source availability, then retry.'}
                    </span>
                )}
                {running && onCancel && (
                    <>
                        <div className='df-refresh-controls'>
                            <Button color='warning' disabled={cancelling} onClick={() => onCancel(false)}>
                                Cancel refresh
                            </Button>
                            <Button variant='outlined' disabled={cancelling} onClick={() => onCancel(true)}>
                                Cancel & restart
                            </Button>
                        </div>
                        <span>
                            Force-cancels this dashboard refresh and discards late results. Database calls already running may finish or
                            time out.
                        </span>
                    </>
                )}
                {failed && onRetry && (
                    <Button disabled={disabled} onClick={onRetry}>
                        Retry refresh
                    </Button>
                )}
            </div>
        </section>
    )
}
RefreshStatus.propTypes = {
    record: PropTypes.object,
    onRetry: PropTypes.func,
    disabled: PropTypes.bool,
    onCancel: PropTypes.func,
    cancelling: PropTypes.bool
}
