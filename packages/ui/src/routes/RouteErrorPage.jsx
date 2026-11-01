import { useState } from 'react'
import { isRouteErrorResponse, useNavigate, useRouteError } from 'react-router-dom'

import { Box, Button, Collapse, Stack, Typography } from '@mui/material'

// Kept to plain MUI with the default theme: this page shows when part of the app failed to render,
// so it should not depend on the store, the theme, or the providers in the app shell.

const errorDetails = (error) => {
    if (isRouteErrorResponse(error)) {
        const data = typeof error.data === 'string' ? error.data : ''
        return [`${error.status} ${error.statusText || ''}`.trim(), data].filter(Boolean).join('\n')
    }
    if (error instanceof Error) {
        const summary = `${error.name}: ${error.message}`
        // Some browsers leave the message out of the stack.
        if (!error.stack) return summary
        return error.stack.includes(error.message) ? error.stack : `${summary}\n${error.stack}`
    }
    if (typeof error === 'string') return error
    try {
        return JSON.stringify(error, null, 2) ?? String(error)
    } catch {
        return String(error)
    }
}

const RouteErrorPage = () => {
    const error = useRouteError()
    const navigate = useNavigate()
    const [showDetails, setShowDetails] = useState(false)
    const notFound = isRouteErrorResponse(error) && error.status === 404

    return (
        <Box role='alert' sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', p: 3 }}>
            <Stack sx={{ maxWidth: 640, width: '100%', gap: 2, alignItems: 'center', textAlign: 'center' }}>
                <Typography variant='h4' component='h1'>
                    {notFound ? 'Page not found' : 'Something went wrong'}
                </Typography>
                <Typography variant='body1'>
                    {notFound
                        ? 'This page does not exist.'
                        : 'This page could not be shown. Reload to try again, or go back to the home page.'}
                </Typography>
                <Stack direction='row' sx={{ gap: 1 }}>
                    <Button variant='contained' onClick={() => window.location.reload()}>
                        Reload
                    </Button>
                    <Button variant='outlined' onClick={() => navigate('/')}>
                        Go home
                    </Button>
                </Stack>
                <Button
                    size='small'
                    aria-expanded={showDetails}
                    aria-controls='route-error-details'
                    onClick={() => setShowDetails((v) => !v)}
                >
                    {showDetails ? 'Hide details' : 'Show details'}
                </Button>
                <Collapse in={showDetails} sx={{ width: '100%' }}>
                    <Box
                        component='pre'
                        id='route-error-details'
                        sx={{
                            m: 0,
                            p: 2,
                            textAlign: 'left',
                            whiteSpace: 'pre-wrap',
                            overflowWrap: 'anywhere',
                            maxHeight: 320,
                            overflow: 'auto',
                            borderRadius: 1,
                            bgcolor: 'grey.100',
                            fontSize: '0.8rem'
                        }}
                    >
                        {errorDetails(error)}
                    </Box>
                </Collapse>
            </Stack>
        </Box>
    )
}

export default RouteErrorPage
