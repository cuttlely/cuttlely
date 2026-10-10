import { useState } from 'react'
import PropTypes from 'prop-types'
import { useDispatch } from 'react-redux'

import { Alert, Box } from '@mui/material'

import flowDraftsApi from '@/api/flowDrafts'
import { SwitchInput } from '@/ui-component/switch/Switch'
import { apiErrorMessage, PUBLISH_INSTANTLY_LOCKED, publishInstantlyLocked } from '@/utils/flowDrafts'
import { enqueueSnackbar as enqueueSnackbarAction } from '@/store/actions'

const PublishInstantly = ({ dialogProps }) => {
    const dispatch = useDispatch()
    const chatflow = dialogProps?.chatflow
    const draftStatus = dialogProps?.draftStatus
    const locked = publishInstantlyLocked(draftStatus)
    const [on, setOn] = useState(Boolean(draftStatus?.publishInstantly))
    const [error, setError] = useState('')

    const onChange = async (next) => {
        if (!chatflow?.id || locked) return
        setError('')
        setOn(next)
        try {
            const res = await flowDraftsApi.updateSettings(chatflow.id, next)
            if (res.data) dialogProps.onDraftStatus?.(res.data)
            dispatch(
                enqueueSnackbarAction({
                    message: next
                        ? 'Publish instantly is on. Every save goes live.'
                        : 'Publish instantly is off. Saves stay in your draft until you publish.',
                    options: { key: new Date().getTime() + Math.random(), variant: 'success' }
                })
            )
        } catch (err) {
            setOn(Boolean(draftStatus?.publishInstantly))
            setError(apiErrorMessage(err, 'That setting could not be saved.'))
        }
    }

    return (
        <Box data-testid='publish-instantly'>
            {locked && (
                <Alert severity='info' sx={{ mb: 1 }}>
                    {PUBLISH_INSTANTLY_LOCKED}
                </Alert>
            )}
            <SwitchInput label='Publish instantly' value={on} disabled={locked} onChange={onChange} />
            {error && (
                <Alert severity='error' sx={{ mt: 1 }}>
                    {error}
                </Alert>
            )}
        </Box>
    )
}

PublishInstantly.propTypes = {
    dialogProps: PropTypes.object
}

export default PublishInstantly
