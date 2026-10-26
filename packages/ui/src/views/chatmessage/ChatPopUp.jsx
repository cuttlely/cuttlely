import { memo, useState, useRef, useEffect, useContext } from 'react'
import { useDispatch } from 'react-redux'
import PropTypes from 'prop-types'

import { ClickAwayListener, Paper, Popper, Button } from '@mui/material'
import { useTheme } from '@mui/material/styles'
import { IconMessage, IconX, IconMessagePlus, IconArrowsMaximize } from '@tabler/icons-react'

// project import
import { StyledFab } from '@/ui-component/button/StyledFab'
import MainCard from '@/ui-component/cards/MainCard'
import Transitions from '@/ui-component/extended/Transitions'
import ChatMessage from './ChatMessage'
import ChatExpandDialog from './ChatExpandDialog'

// Hooks
import useConfirm from '@/hooks/useConfirm'
import useNotifier from '@/utils/useNotifier'
import { flowContext } from '@/store/context/ReactFlowContext'

// Const
import { enqueueSnackbar as enqueueSnackbarAction, closeSnackbar as closeSnackbarAction } from '@/store/actions'

// Utils
import { removeLocalStorageChatHistory } from '@/utils/genericHelper'

const ChatPopUp = ({ chatflowid, isAgentCanvas, onOpenChange, harnessBlock, harnessName, openOnLoad }) => {
    const theme = useTheme()
    const { confirm } = useConfirm()
    const dispatch = useDispatch()
    const { clearAgentflowNodeStatus } = useContext(flowContext)

    useNotifier()
    const enqueueSnackbar = (...args) => dispatch(enqueueSnackbarAction(...args))
    const closeSnackbar = (...args) => dispatch(closeSnackbarAction(...args))

    const [open, setOpen] = useState(false)
    const [showExpandDialog, setShowExpandDialog] = useState(false)
    const [expandDialogProps, setExpandDialogProps] = useState({})
    const [previews, setPreviews] = useState([])
    const [chatResetKey, setChatResetKey] = useState(0)

    const anchorRef = useRef(null)
    const prevOpen = useRef(open)

    // Try the demo lands here with the chat open, so the starter questions are the first thing on screen.
    useEffect(() => {
        if (!openOnLoad) return
        setOpen(true)
        if (onOpenChange) onOpenChange(true)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [openOnLoad])

    const handleClose = (event) => {
        if (anchorRef.current && anchorRef.current.contains(event.target)) {
            return
        }
        setOpen(false)
        if (onOpenChange) onOpenChange(false)
    }

    const handleToggle = () => {
        const newOpenState = !open
        setOpen(newOpenState)
        if (onOpenChange) onOpenChange(newOpenState)
    }

    const expandChat = () => {
        const props = {
            open: true,
            chatflowid: chatflowid
        }
        setExpandDialogProps(props)
        setShowExpandDialog(true)
    }

    const resetChatDialog = () => {
        const props = {
            ...expandDialogProps,
            open: false
        }
        setExpandDialogProps(props)
        clearAgentflowNodeStatus()
        setTimeout(() => {
            const resetProps = {
                ...expandDialogProps,
                open: true
            }
            setExpandDialogProps(resetProps)
        }, 500)
    }

    const clearChat = async () => {
        const confirmPayload = {
            title: `Start a new session`,
            description: `Start a new session? The chat on screen clears and your next message starts a new session. Past messages are kept.`,
            confirmButtonName: 'Start',
            cancelButtonName: 'Cancel'
        }
        const isConfirmed = await confirm(confirmPayload)
        if (!isConfirmed) return

        // Forget the saved chatId so the next message opens a new session. Stored messages are not deleted.
        removeLocalStorageChatHistory(chatflowid)
        // Remount the popup chat so its on-screen messages clear.
        setChatResetKey((key) => key + 1)
        resetChatDialog()
        enqueueSnackbar({
            message: 'Started a new session',
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
    }

    useEffect(() => {
        if (prevOpen.current === true && open === false) {
            anchorRef.current.focus()
            if (onOpenChange) onOpenChange(false)
        }
        prevOpen.current = open

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, chatflowid])

    return (
        <>
            <StyledFab
                sx={{ position: 'absolute', right: 20, top: 20 }}
                ref={anchorRef}
                size='small'
                color='secondary'
                aria-label='chat'
                title='Chat'
                onClick={handleToggle}
            >
                {open ? <IconX /> : <IconMessage />}
            </StyledFab>

            {open && (
                <StyledFab
                    sx={{ position: 'absolute', right: 80, top: 20 }}
                    onClick={clearChat}
                    size='small'
                    color='primary'
                    aria-label='clear'
                    title='Start a new session'
                >
                    <IconMessagePlus />
                </StyledFab>
            )}
            {open && (
                <StyledFab
                    sx={{ position: 'absolute', right: 140, top: 20 }}
                    onClick={expandChat}
                    size='small'
                    color='primary'
                    aria-label='expand'
                    title='Expand Chat'
                >
                    <IconArrowsMaximize />
                </StyledFab>
            )}
            <Popper
                placement='bottom-end'
                open={open}
                anchorEl={anchorRef.current}
                role={undefined}
                transition
                disablePortal
                popperOptions={{
                    modifiers: [
                        {
                            name: 'offset',
                            options: {
                                offset: [40, 14]
                            }
                        }
                    ]
                }}
                sx={{ zIndex: 1000 }}
            >
                {({ TransitionProps }) => (
                    <Transitions in={open} {...TransitionProps}>
                        <Paper>
                            <ClickAwayListener onClickAway={handleClose}>
                                <MainCard
                                    border={false}
                                    className='cloud-wrapper'
                                    elevation={16}
                                    content={false}
                                    boxShadow
                                    shadow={theme.shadows[16]}
                                >
                                    <ChatMessage
                                        key={chatResetKey}
                                        isAgentCanvas={isAgentCanvas}
                                        chatflowid={chatflowid}
                                        open={open}
                                        previews={previews}
                                        setPreviews={setPreviews}
                                        harnessBlock={harnessBlock}
                                        harnessName={harnessName}
                                    />
                                </MainCard>
                            </ClickAwayListener>
                        </Paper>
                    </Transitions>
                )}
            </Popper>
            <ChatExpandDialog
                show={showExpandDialog}
                dialogProps={expandDialogProps}
                isAgentCanvas={isAgentCanvas}
                onClear={clearChat}
                onCancel={() => setShowExpandDialog(false)}
                previews={previews}
                setPreviews={setPreviews}
                harnessBlock={harnessBlock}
                harnessName={harnessName}
            ></ChatExpandDialog>
        </>
    )
}

ChatPopUp.propTypes = {
    chatflowid: PropTypes.string,
    isAgentCanvas: PropTypes.bool,
    onOpenChange: PropTypes.func,
    harnessBlock: PropTypes.string,
    harnessName: PropTypes.string,
    openOnLoad: PropTypes.bool
}

export default memo(ChatPopUp)
