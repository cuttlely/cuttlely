// New versions from Dev, on a server labeled Prod. For the organization owner only.
import { useCallback, useEffect, useState } from 'react'
import { Stack } from '@mui/material'

import MainCard from '@/ui-component/cards/MainCard'
import ViewHeader from '@/layout/MainLayout/ViewHeader'
import flowVersionsApi from '@/api/flowVersions'
import { apiErrorMessage } from '@/utils/flowDrafts'
import { timeAgo } from '@/utils/githubSync'
import { listUnreadable, previousEnvironmentTitle, promoteLoadError, sourceTitleOf } from '@/utils/promote'
import { PromoteListView } from './PromoteViews'

const Promote = () => {
    const [list, setList] = useState(null)
    const [status, setStatus] = useState(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')
    const [checking, setChecking] = useState(false)

    const load = useCallback(async () => {
        let github = null
        try {
            github = (await flowVersionsApi.getGithub().catch(() => null))?.data || null
            setStatus(github)
            const incoming = await flowVersionsApi.listIncoming()
            setList(incoming.data)
            setError('')
        } catch (err) {
            setError(apiErrorMessage(err, promoteLoadError(github)))
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => {
        load()
        const timer = setInterval(load, 30000)
        return () => clearInterval(timer)
    }, [load])

    const onCheckNow = async () => {
        setChecking(true)
        try {
            await flowVersionsApi.syncGithub()
        } catch {
            // The status below says what went wrong.
        }
        await load()
        setChecking(false)
    }

    const from = listUnreadable(status) ? '' : list ? sourceTitleOf(list) : previousEnvironmentTitle(status)
    return (
        <MainCard>
            <Stack flexDirection='column' sx={{ gap: 3 }}>
                <ViewHeader
                    title={!from ? 'New versions' : from === 'Dev' ? 'From Dev' : `From ${from}`}
                    description={
                        !from
                            ? 'New versions could not be loaded.'
                            : from === 'Dev'
                            ? 'Review what Dev published and promote it to Live on this server'
                            : `Review what ${from} published and promote it to Live on this server`
                    }
                />
                <PromoteListView
                    list={list}
                    status={status}
                    loading={loading}
                    error={error}
                    checking={checking}
                    onCheckNow={onCheckNow}
                    now={Date.now()}
                    timeAgo={(iso) => timeAgo(iso)}
                />
            </Stack>
        </MainCard>
    )
}

export default Promote
