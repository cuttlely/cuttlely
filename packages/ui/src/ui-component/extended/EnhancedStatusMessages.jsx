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
import { requestFailureMessage } from '@/utils/errorSummary'

const EnhancedStatusMessages = ({ dialogProps, onConfirm }) => {
    const dispatch = useDispatch()

    useNotifier()

    const enqueueSnackbar = (...args) => dispatch(enqueueSnackbarAction(...args))
    const closeSnackbar = (...args) => dispatch(closeSnackbarAction(...args))

    // On unless the flow turned it off.
    const [enhancedStatus, setEnhancedStatus] = useState(true)
    const [chatbotConfig, setChatbotConfig] = useState({})

    const handleChange = (value) => {
        setEnhancedStatus(value)
    }

    const onSave = async () => {
        try {
            chatbotConfig.enhancedStatusMessages = { status: enhancedStatus }
            const saveResp = await chatflowsApi.updateChatflow(dialogProps.chatflow.id, {
                chatbotConfig: JSON.stringify(chatbotConfig)
            })
            if (saveResp.data) {
                enqueueSnackbar({
                    message: 'Enhanced Status Messages Settings Saved',
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
                message: `Failed to save Enhanced Status Messages Settings: ${requestFailureMessage(error)}`,
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
        if (dialogProps.chatflow && dialogProps.chatflow.chatbotConfig) {
            let chatbotConfig = JSON.parse(dialogProps.chatflow.chatbotConfig)
            setChatbotConfig(chatbotConfig || {})
            setEnhancedStatus(chatbotConfig?.enhancedStatusMessages?.status !== false)
        }

        return () => {}
    }, [dialogProps])

    return (
        <Stack direction='column' spacing={2} sx={{ width: '100%' }}>
            <SwitchInput label='Enhanced status messages' onChange={handleChange} value={enhancedStatus} />
            <Typography variant='body2' color='text.secondary'>
                While a harness run is working on a long step, the run card adds a light, playful line under the live status. The live
                status itself always shows.
            </Typography>
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', width: '100%', mt: 2 }}>
                <StyledButton variant='contained' onClick={onSave} sx={{ minWidth: 100 }}>
                    Save
                </StyledButton>
            </Box>
        </Stack>
    )
}

EnhancedStatusMessages.propTypes = {
    dialogProps: PropTypes.object,
    onConfirm: PropTypes.func
}

export default EnhancedStatusMessages
