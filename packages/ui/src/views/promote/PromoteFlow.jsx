// One flow's new version from Dev: review it, check it, promote it. For the organization owner only.
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Box } from '@mui/material'

import MainCard from '@/ui-component/cards/MainCard'
import flowVersionsApi from '@/api/flowVersions'
import flowDraftsApi from '@/api/flowDrafts'
import PublishCheck from '@/views/canvas/PublishCheck'
import { apiErrorMessage } from '@/utils/flowDrafts'
import { canvasPathFor } from '@/utils/versionHistory'
import { rollbackTarget } from '@/utils/promote'
import { PromoteDetailView } from './PromoteViews'

const PromoteFlow = () => {
    const { id } = useParams()
    const [detail, setDetail] = useState(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')
    const [promoting, setPromoting] = useState(false)
    const [promoteError, setPromoteError] = useState('')
    const [result, setResult] = useState(null)
    const [target, setTarget] = useState(null)
    const [rollingBack, setRollingBack] = useState(false)
    const [rolledBack, setRolledBack] = useState(false)

    useEffect(() => {
        let cancelled = false
        setLoading(true)
        flowVersionsApi
            .getIncoming(id)
            .then((res) => !cancelled && setDetail(res.data))
            .catch((err) => !cancelled && setError(apiErrorMessage(err, 'This new version could not be loaded.')))
            .finally(() => !cancelled && setLoading(false))
        return () => {
            cancelled = true
        }
    }, [id])

    const onPromote = async () => {
        if (!detail?.version?.sha) return
        setPromoting(true)
        setPromoteError('')
        try {
            const res = await flowVersionsApi.promote(id, detail.version.sha)
            setResult(res.data)
            if (!res.data?.created && !res.data?.unchanged && res.data?.version?.sha) {
                const list = await flowVersionsApi.listVersions(id).catch(() => null)
                setTarget(rollbackTarget(list?.data?.versions || [], res.data.version.sha))
            }
        } catch (err) {
            setPromoteError(apiErrorMessage(err, 'Promote did not go through. Nothing changed. Try again.'))
        } finally {
            setPromoting(false)
        }
    }

    // Roll back the way version history does: Live goes back at once. With drafts off, restore does the same.
    const onRollBack = async () => {
        if (!target) return
        setRollingBack(true)
        setPromoteError('')
        try {
            try {
                await flowDraftsApi.rollback(id, target)
            } catch (err) {
                if (err?.response?.status !== 409 || !/Drafts are off/.test(apiErrorMessage(err, ''))) throw err
                await flowVersionsApi.restoreVersion(id, target)
            }
            setRolledBack(true)
        } catch (err) {
            setPromoteError(apiErrorMessage(err, 'Roll back did not go through. Use version history on the flow.'))
        } finally {
            setRollingBack(false)
        }
    }

    const type = result?.chatflow?.type || detail?.type
    return (
        // A card clips what overflows it, which would stop the Promote bar from staying on screen while the page scrolls.
        <MainCard sx={{ overflow: 'visible' }}>
            <PromoteDetailView
                detail={detail}
                loading={loading}
                error={error}
                promoting={promoting}
                promoteError={promoteError}
                result={result}
                rollingBack={rollingBack}
                rolledBack={rolledBack}
                canRollBack={Boolean(target)}
                onPromote={onPromote}
                onRollBack={onRollBack}
                openPath={type ? canvasPathFor(type, id) : null}
                now={Date.now()}
                check={
                    <Box data-testid='promote-check'>
                        <PublishCheck chatflowId={id} variant='promote' api={flowVersionsApi.promoteCheckApi} />
                    </Box>
                }
            />
        </MainCard>
    )
}

export default PromoteFlow
