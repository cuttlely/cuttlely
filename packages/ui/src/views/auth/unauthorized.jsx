import MainCard from '@/ui-component/cards/MainCard'
import { Box, Stack, Typography } from '@mui/material'
import unauthorizedSVG from '@/assets/images/unauthorized.svg'
import { StyledButton } from '@/ui-component/button/StyledButton'
import { Link, useLocation } from 'react-router-dom'
import { useSelector } from 'react-redux'

// ==============================|| UnauthorizedPage ||============================== //

const UnauthorizedPage = () => {
    const currentUser = useSelector((state) => state.auth.user)
    const location = useLocation()

    return (
        <>
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
                            justifyContent: 'center'
                        }}
                        flexDirection='column'
                    >
                        <Box sx={{ p: 2, height: 'auto' }}>
                            <img
                                style={{ objectFit: 'cover', height: '20vh', width: 'auto' }}
                                src={unauthorizedSVG}
                                alt='unauthorizedSVG'
                            />
                        </Box>
                        <Typography sx={{ mb: 2 }} variant='h4' component='div' fontWeight='bold'>
                            You do not have access to this operation (403)
                        </Typography>
                        <Typography variant='body1' component='div' sx={{ mb: 2 }}>
                            {location.state?.message ||
                                'Ask your workspace admin to grant the permissions and resources needed for this operation.'}
                        </Typography>
                        <a href='https://cuttlely.com/docs/how-to/access-keys/'>How to fix access-key errors</a>
                        {currentUser ? (
                            <Link to='/'>
                                <StyledButton sx={{ px: 2, py: 1 }}>Back to Home</StyledButton>
                            </Link>
                        ) : (
                            <Link to='/login'>
                                <StyledButton sx={{ px: 2, py: 1 }}>Back to Login</StyledButton>
                            </Link>
                        )}
                    </Stack>
                </Box>
            </MainCard>
        </>
    )
}

export default UnauthorizedPage
