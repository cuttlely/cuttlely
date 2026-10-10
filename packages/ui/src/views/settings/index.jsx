import { useState, useEffect, useRef } from 'react'
import PropTypes from 'prop-types'
import { useSelector } from 'react-redux'

// material-ui
import { useTheme } from '@mui/material/styles'
import { ListItemButton, ListItemIcon, ListItemText, Typography, Box, List, Paper, Popper, ClickAwayListener } from '@mui/material'
import FiberManualRecordIcon from '@mui/icons-material/FiberManualRecord'

// third-party
import PerfectScrollbar from 'react-perfect-scrollbar'

// project imports
import MainCard from '@/ui-component/cards/MainCard'
import Transitions from '@/ui-component/extended/Transitions'
import settings, { settingsForCanvas } from '@/menu-items/settings'
import agentsettings from '@/menu-items/agentsettings'
import customAssistantSettings from '@/menu-items/customassistant'
import { legacySafeSettings } from '@/utils/legacyAgentflows'
import { useAuth } from '@/hooks/useAuth'

// ==============================|| SETTINGS ||============================== //

const Settings = ({
    chatflow,
    isSettingsOpen,
    isCustomAssistant,
    anchorEl,
    isAgentCanvas,
    isHarnessCanvas,
    onSettingsItemClick,
    onUploadFile,
    onOpenFlowiseMigration,
    onClose,
    allowLangflowImport
}) => {
    const theme = useTheme()
    const [settingsMenu, setSettingsMenu] = useState([])
    const customization = useSelector((state) => state.customization)
    const inputFile = useRef(null)
    const importExpect = useRef('flowise')
    const [open, setOpen] = useState(false)
    const { hasPermission } = useAuth()

    const handleFileUpload = (e) => {
        if (!e.target.files) return

        const file = e.target.files[0]

        const reader = new FileReader()
        reader.onload = (evt) => {
            if (!evt?.target?.result) {
                return
            }
            const { result } = evt.target
            onUploadFile(result, importExpect.current)
        }
        reader.readAsText(file)
        e.target.value = ''
    }

    useEffect(() => {
        if (!chatflow) return
        if (isCustomAssistant && chatflow.id) {
            setSettingsMenu(customAssistantSettings.children)
            return
        }
        const menus = isHarnessCanvas ? settingsForCanvas(true) : isAgentCanvas ? agentsettings : settings
        let children = legacySafeSettings(menus.children, chatflow.type)
        if (!allowLangflowImport) children = children.filter((menu) => menu.id !== 'loadLangflow')
        if (!chatflow.id) {
            setSettingsMenu(
                children.filter((menu) => menu.id === 'loadChatflow' || menu.id === 'loadLangflow' || menu.id === 'exportChatflow')
            )
            return
        }
        setSettingsMenu(children)
    }, [chatflow, isAgentCanvas, isHarnessCanvas, isCustomAssistant, allowLangflowImport])

    useEffect(() => {
        setOpen(isSettingsOpen)
    }, [isSettingsOpen])

    // settings list items
    const items = settingsMenu.map((menu) => {
        if (menu.permission && !hasPermission(menu.permission)) {
            return null
        }
        const Icon = menu.icon
        const itemIcon = menu?.icon ? (
            <Icon stroke={1.5} size='1.3rem' />
        ) : (
            <FiberManualRecordIcon
                sx={{
                    width: customization.isOpen.findIndex((id) => id === menu?.id) > -1 ? 8 : 6,
                    height: customization.isOpen.findIndex((id) => id === menu?.id) > -1 ? 8 : 6
                }}
                fontSize={'inherit'}
            />
        )
        const exportLocked = menu.id === 'exportChatflow' && !chatflow?.id
        return (
            <ListItemButton
                key={menu.id}
                disabled={exportLocked}
                sx={{
                    borderRadius: `${customization.borderRadius}px`,
                    mb: 0.5,
                    alignItems: 'flex-start',
                    py: 1.25,
                    pl: `24px`
                }}
                onClick={() => {
                    if (exportLocked) return
                    if (menu.id === 'loadChatflow' && onOpenFlowiseMigration) {
                        onOpenFlowiseMigration()
                    } else if ((menu.id === 'loadChatflow' || menu.id === 'loadLangflow') && inputFile.current) {
                        importExpect.current = menu.id === 'loadLangflow' ? 'langflow' : 'flowise'
                        inputFile.current.value = ''
                        inputFile.current.click()
                    } else {
                        onSettingsItemClick(menu.id)
                    }
                }}
            >
                <ListItemIcon sx={{ my: 'auto', minWidth: !menu?.icon ? 18 : 36 }}>{itemIcon}</ListItemIcon>
                <ListItemText
                    primary={<Typography color='inherit'>{exportLocked ? 'Export' : menu.title}</Typography>}
                    secondary={
                        exportLocked ? (
                            <Typography variant='caption' color='text.secondary'>
                                Save first
                            </Typography>
                        ) : null
                    }
                />
            </ListItemButton>
        )
    })

    return (
        <>
            <Popper
                placement='bottom-end'
                open={open}
                anchorEl={anchorEl}
                role={undefined}
                transition
                disablePortal
                popperOptions={{
                    modifiers: [
                        {
                            name: 'offset',
                            options: {
                                offset: [170, 20]
                            }
                        }
                    ]
                }}
                sx={{ zIndex: 1000 }}
            >
                {({ TransitionProps }) => (
                    <Transitions in={open} {...TransitionProps}>
                        <Paper>
                            <ClickAwayListener onClickAway={onClose}>
                                <MainCard border={false} elevation={16} content={false} boxShadow shadow={theme.shadows[16]}>
                                    <PerfectScrollbar style={{ height: '100%', maxHeight: 'calc(100vh - 250px)', overflowX: 'hidden' }}>
                                        <Box sx={{ p: 2 }}>
                                            <List>{items}</List>
                                        </Box>
                                    </PerfectScrollbar>
                                    <input
                                        type='file'
                                        hidden
                                        accept='.json'
                                        ref={inputFile}
                                        style={{ display: 'none' }}
                                        onChange={(e) => handleFileUpload(e)}
                                    />
                                </MainCard>
                            </ClickAwayListener>
                        </Paper>
                    </Transitions>
                )}
            </Popper>
        </>
    )
}

Settings.propTypes = {
    chatflow: PropTypes.object,
    isSettingsOpen: PropTypes.bool,
    isCustomAssistant: PropTypes.bool,
    anchorEl: PropTypes.any,
    onSettingsItemClick: PropTypes.func,
    onUploadFile: PropTypes.func,
    onOpenFlowiseMigration: PropTypes.func,
    onClose: PropTypes.func,
    isAgentCanvas: PropTypes.bool,
    isHarnessCanvas: PropTypes.bool,
    allowLangflowImport: PropTypes.bool
}

export default Settings
