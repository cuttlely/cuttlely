import { Box, Button, Stack, Typography } from '@mui/material'
import { Link, useLocation } from 'react-router-dom'
import unauthorizedSVG from '@/assets/images/unauthorized.svg'
import MainCard from '@/ui-component/cards/MainCard'

// ==============================|| RateLimitedPage ||============================== //

const RateLimitedPage = () => {
    const location = useLocation()

    const retryAfter = location.state?.retryAfter || 60

    return (
        <MainCard>
            <Box
                sx={{
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'center',
                    height: 'calc(100vh - 210px)'
                }}
            >
                <Stack
                    sx={{
                        alignItems: 'center',
                        justifyContent: 'center',
                        maxWidth: '500px'
                    }}
                    flexDirection='column'
                >
                    <Box sx={{ p: 2, height: 'auto' }}>
                        <img style={{ objectFit: 'cover', height: '20vh', width: 'auto' }} src={unauthorizedSVG} alt='rateLimitedSVG' />
                    </Box>
                    <Typography sx={{ mb: 2 }} variant='h4' component='div' fontWeight='bold'>
                        Request limit reached (429)
                    </Typography>
                    <Typography variant='body1' component='div' sx={{ mb: 2, textAlign: 'center' }}>
                        {`You have made too many requests in a short period of time. Please wait ${retryAfter}s before trying again.`}
                    </Typography>
                    {location.state?.message && <Typography sx={{ mb: 2 }}>{location.state.message}</Typography>}
                    <Typography sx={{ mb: 2 }}>
                        Daily and monthly access-key quotas reset at their UTC boundary. The key owner can also raise the limit.
                    </Typography>
                    <a href='https://cuttlely.com/docs/how-to/access-keys/'>How to fix access-key errors</a>
                    <Link to='/'>
                        <Button variant='contained' color='primary'>
                            Back to Home
                        </Button>
                    </Link>
                </Stack>
            </Box>
        </MainCard>
    )
}

export default RateLimitedPage
