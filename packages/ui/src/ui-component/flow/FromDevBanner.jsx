// On a Prod server, a friendly line above the flows list for each flow with a new version from Dev.
// Only the organization owner sees it; everyone else gets nothing and no request is made.
import { useEffect, useState } from 'react'
import PropTypes from 'prop-types'
import { Link as RouterLink } from 'react-router-dom'
import { Box, Button, Stack, Typography } from '@mui/material'
import { alpha, useTheme } from '@mui/material/styles'
import { IconRocket, IconSparkles } from '@tabler/icons-react'

import flowVersionsApi from '@/api/flowVersions'
import { useAuth } from '@/hooks/useAuth'
import { OWNER_PERMISSION } from '@/utils/githubSync'
import { incomingLabel, incomingSummary, promotePath } from '@/utils/promote'

const SHOWN = 3

// What the banner shows, from plain props.
export const FromDevBannerView = ({ flows }) => {
    const theme = useTheme()
    if (!flows?.length) return null
    const shown = flows.slice(0, SHOWN)
    return (
        <Box
            data-testid='from-dev-banner'
            sx={{
                p: 2,
                borderRadius: 2,
                border: '1px solid',
                borderColor: alpha(theme.palette.primary.main, 0.3),
                background: `linear-gradient(135deg, ${alpha(theme.palette.primary.main, 0.08)}, ${alpha(
                    theme.palette.secondary.main,
                    0.06
                )})`
            }}
        >
            <Stack direction='row' spacing={1} alignItems='center' justifyContent='space-between'>
                <Stack direction='row' spacing={1} alignItems='center'>
                    <IconRocket size={20} color={theme.palette.primary.main} />
                    <Typography variant='h5'>{incomingSummary(flows)}</Typography>
                </Stack>
                <Button size='small' component={RouterLink} to={promotePath()}>
                    Review all
                </Button>
            </Stack>
            <Stack spacing={0.75} sx={{ mt: 1.25 }}>
                {shown.map((flow) => (
                    <Stack key={flow.flowId} direction='row' spacing={1.5} alignItems='center' data-testid='from-dev-flow'>
                        {flow.status === 'new' ? (
                            <IconSparkles size={16} color={theme.palette.secondary.main} />
                        ) : (
                            <IconRocket size={16} color={theme.palette.primary.main} />
                        )}
                        <Typography variant='body2' sx={{ fontWeight: 600 }} noWrap>
                            {flow.name}
                        </Typography>
                        <Typography variant='body2' color='text.secondary' noWrap sx={{ flex: 1 }}>
                            {incomingLabel(flow)}
                        </Typography>
                        <Button size='small' variant='outlined' component={RouterLink} to={promotePath(flow.flowId)}>
                            Review
                        </Button>
                    </Stack>
                ))}
                {flows.length > SHOWN && (
                    <Typography variant='caption' color='text.secondary'>
                        And {flows.length - SHOWN} more.
                    </Typography>
                )}
            </Stack>
        </Box>
    )
}
FromDevBannerView.propTypes = { flows: PropTypes.array }

// types: only flows of these types are listed (the chatflows page shows chatflows, and so on).
const FromDevBanner = ({ types }) => {
    const { hasPermission } = useAuth()
    const owner = hasPermission(OWNER_PERMISSION)
    const [flows, setFlows] = useState([])
    const key = (types || []).join(',')
    useEffect(() => {
        if (!owner) return undefined
        let cancelled = false
        flowVersionsApi
            .listIncoming()
            .then((res) => {
                if (cancelled) return
                const wanted = key ? key.split(',') : null
                setFlows((res.data?.flows || []).filter((flow) => !wanted || wanted.includes(flow.type || 'CHATFLOW')))
            })
            .catch(() => !cancelled && setFlows([]))
        return () => {
            cancelled = true
        }
    }, [owner, key])
    if (!owner) return null
    return <FromDevBannerView flows={flows} />
}
FromDevBanner.propTypes = { types: PropTypes.array }

export default FromDevBanner
