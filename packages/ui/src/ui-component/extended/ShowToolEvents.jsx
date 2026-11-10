import { useDispatch } from 'react-redux'
import { useState, useEffect } from 'react'
import PropTypes from 'prop-types'

// material-ui
import { Button, Box, Stack, Typography } from '@mui/material'
import { IconX } from '@tabler/icons-react'

// Project import
import { StyledButton } from '@/ui-component/button/StyledButton'
import { SwitchInput } from '@/ui-component/switch/Switch'

// store
import { enqueueSnackbar as enqueueSnackbarAction, closeSnackbar as closeSnackbarAction, SET_CHATFLOW } from '@/store/actions'
import useNotifier from '@/utils/useNotifier'

// API
import chatflowsApi from '@/api/chatflows'
import { resolveShowToolEvents } from '@/utils/toolEvents'
import { safeJsonParse } from '@/utils/safeJsonParse'

const ShowToolEvents = ({ dialogProps, onConfirm }) => {
    const dispatch = useDispatch()

    useNotifier()

    const enqueueSnackbar = (...args) => dispatch(enqueueSnackbarAction(...args))
    const closeSnackbar = (...args) => dispatch(closeSnackbarAction(...args))

    // Resolve missing settings from this canvas type.
    const [showToolEvents, setShowToolEvents] = useState(false)
    const [chatbotConfig, setChatbotConfig] = useState({})

    const handleChange = (value) => {
        setShowToolEvents(value)
    }

    const onSave = async () => {
        try {
            const config = { ...chatbotConfig, showToolEvents: { status: showToolEvents } }
            const saveResp = await chatflowsApi.updateChatflow(dialogProps.chatflow.id, {
                chatbotConfig: JSON.stringify(config)
            })
            if (saveResp.data) {
                enqueueSnackbar({
                    message: 'Show tool events settings saved',
                    options: {
                        key: new Date().getTime() + Math.random(),
                        variant: 'success',
                        action: (key) => (
                            <Button style={{ color: 'white' }} onClick={() => closeSnackbar(key)}>
                                <IconX />
                            </Button>
                        )
                    }
                })
                dispatch({ type: SET_CHATFLOW, chatflow: saveResp.data })
                onConfirm?.()
            }
        } catch (error) {
            enqueueSnackbar({
                message: `Failed to save Show tool events settings: ${
                    typeof error.response?.data === 'object' ? error.response.data.message : error.response?.data || error.message
                }`,
                options: {
                    key: new Date().getTime() + Math.random(),
                    variant: 'error',
                    persist: true,
                    action: (key) => (
                        <Button style={{ color: 'white' }} onClick={() => closeSnackbar(key)}>
                            <IconX />
                        </Button>
                    )
                }
            })
        }
    }

    useEffect(() => {
        const flow = dialogProps.chatflow
        // A saved value that is not valid JSON, or one that is already an object, must not crash the dialog.
        const raw = flow?.chatbotConfig
        const parsed = raw && typeof raw === 'object' ? raw : safeJsonParse(raw, {})
        const config = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
        setChatbotConfig(config)
        setShowToolEvents(resolveShowToolEvents(config, flow?.type))
    }, [dialogProps])

    return (
        <Stack direction='column' spacing={2} sx={{ width: '100%' }}>
            <SwitchInput label='Show tool events' onChange={handleChange} value={showToolEvents} />
            <Typography variant='body2' color='text.secondary'>
                When on, chat shows live tool and step status while the flow works. When off, live tool and step status are hidden. Answers,
                sources and attachments still appear. A Harness run card still appears on a Harness canvas, and when this flow calls a
                Harness.
            </Typography>
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', width: '100%', mt: 2 }}>
                <StyledButton variant='contained' onClick={onSave} sx={{ minWidth: 100 }}>
                    Save
                </StyledButton>
            </Box>
        </Stack>
    )
}

ShowToolEvents.propTypes = {
    dialogProps: PropTypes.object,
    onConfirm: PropTypes.func
}

export default ShowToolEvents
