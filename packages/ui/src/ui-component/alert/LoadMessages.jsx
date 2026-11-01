import PropTypes from 'prop-types'
import { Alert, AlertTitle, Button } from '@mui/material'

// Messages a list's load method sent instead of choices (options named "error"), shown as alerts with Retry.
export const LoadMessages = ({ messages = [], onRetry, retrying = false }) => {
    if (!messages.length) return null
    return messages.map((message, index) => (
        <Alert
            key={`${message.label || 'message'}-${index}`}
            severity='warning'
            variant='outlined'
            data-testid='load-message'
            sx={{ mt: 1, py: 0, '& .MuiAlert-message': { minWidth: 0, overflowWrap: 'anywhere' } }}
            action={
                onRetry ? (
                    <Button color='inherit' size='small' onClick={onRetry} disabled={retrying} data-testid='load-retry'>
                        {retrying ? 'Retrying…' : 'Retry'}
                    </Button>
                ) : null
            }
        >
            {message.label ? <AlertTitle sx={{ mb: message.description ? 0.25 : 0, fontSize: 13 }}>{message.label}</AlertTitle> : null}
            {message.description || null}
        </Alert>
    ))
}

LoadMessages.propTypes = {
    messages: PropTypes.array,
    onRetry: PropTypes.func,
    retrying: PropTypes.bool
}

export const LOAD_FAILED = { name: 'error', label: 'Could not load this list', description: 'The server did not answer. Try again.' }
