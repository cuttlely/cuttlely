// First-run setup, last step: an optional, skippable "Keep a copy in GitHub" page shown right after the
// first account is created. It is the same card as Version History, so connecting here or there is the same.
import { useCallback, useEffect, useState } from 'react'
import PropTypes from 'prop-types'
import { useLocation, useNavigate } from 'react-router-dom'
import { Box, Button, Chip, Stack, Typography } from '@mui/material'
import { IconArrowRight } from '@tabler/icons-react'

import Logo from '@/ui-component/extended/Logo'
import Mascot from '@/ui-component/extended/Mascot'
import GithubCard from '@/views/versionsettings/GithubCard'
import { nextAfterSetup, skipGithubStep } from '@/utils/firstRun'

export const GithubStepView = ({ connected, onDone, card }) => (
    <Box data-testid='setup-github' sx={{ width: '100%', maxWidth: 760, px: 3, py: 2 }}>
        <Stack spacing={3}>
            <Stack spacing={1.5} alignItems='center' textAlign='center'>
                <Mascot pose='wink' size={112} />
                <Logo height={36} />
                <Chip label='Optional last step' size='small' color='primary' variant='outlined' />
                <Typography variant='h1'>Keep a copy in GitHub</Typography>
                <Typography color='text.secondary' sx={{ maxWidth: 560 }}>
                    Your account is ready. Every version of every flow is already kept on this server. Connect GitHub to keep a second copy
                    in your own repository, or to move flows from a Dev server to a Prod server.
                </Typography>
            </Stack>
            {card}
            <Stack direction='row' spacing={2} alignItems='center' justifyContent='space-between'>
                <Typography variant='caption' color='text.secondary'>
                    You can change this any time in Version History.
                </Typography>
                {connected ? (
                    <Button
                        variant='contained'
                        size='large'
                        endIcon={<IconArrowRight size={18} />}
                        onClick={onDone}
                        data-testid='setup-continue'
                    >
                        Continue
                    </Button>
                ) : (
                    <Button color='inherit' size='large' onClick={onDone} data-testid='setup-skip'>
                        Skip for now
                    </Button>
                )}
            </Stack>
        </Stack>
    </Box>
)

GithubStepView.propTypes = {
    connected: PropTypes.bool,
    onDone: PropTypes.func.isRequired,
    card: PropTypes.node
}

const GithubStep = () => {
    const navigate = useNavigate()
    const location = useLocation()
    const [status, setStatus] = useState(null)
    const next = nextAfterSetup(location.state)
    const done = useCallback(() => navigate(next, { replace: true }), [navigate, next])

    // With version history off there is nothing to keep in GitHub, so the step steps aside.
    useEffect(() => {
        if (skipGithubStep(status)) done()
    }, [status, done])

    return <GithubStepView connected={Boolean(status?.connected)} onDone={done} card={<GithubCard onStatus={setStatus} />} />
}

export default GithubStep
