import { Link } from 'react-router-dom'

import { Button, Stack, Typography } from '@mui/material'

import MainCard from '@/ui-component/cards/MainCard'

const NotFound = () => (
    <MainCard>
        <Stack sx={{ alignItems: 'flex-start', gap: 2, py: 4 }}>
            <Typography variant='h1'>Page not found</Typography>
            <Typography>That address is not in Cuttlely.</Typography>
            <Stack direction='row' sx={{ gap: 1, flexWrap: 'wrap' }}>
                <Button component={Link} to='/chatflows' variant='contained' sx={{ textTransform: 'none' }}>
                    Chatflows
                </Button>
                <Button component={Link} to='/marketplaces' variant='outlined' sx={{ textTransform: 'none' }}>
                    Templates
                </Button>
            </Stack>
        </Stack>
    </MainCard>
)

export default NotFound
