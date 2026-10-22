import PropTypes from 'prop-types'
import { useNavigate } from 'react-router-dom'

// material-ui
import { useTheme } from '@mui/material/styles'
import { Avatar, Box, ButtonBase, Typography, Stack } from '@mui/material'
import { StyledButton } from '@/ui-component/button/StyledButton'

// icons
import { IconCopy, IconChevronLeft } from '@tabler/icons-react'
import { Available } from '@/ui-component/rbac/available'
import { templateUsePermission } from './templateUsePermission'
import { templateSettingsMessage } from '@/utils/templateSettingsNote'

// ==============================|| CANVAS HEADER ||============================== //

const MarketplaceCanvasHeader = ({ flowName, flowData, legacy, templateType, onChatflowCopy }) => {
    const theme = useTheme()
    const navigate = useNavigate()
    const settingsNote = templateSettingsMessage(flowData)

    return (
        <>
            <Box>
                <ButtonBase title='Back' sx={{ borderRadius: '50%' }}>
                    <Avatar
                        variant='rounded'
                        sx={{
                            ...theme.typography.commonAvatar,
                            ...theme.typography.mediumAvatar,
                            transition: 'all .2s ease-in-out',
                            background: theme.palette.secondary.light,
                            color: theme.palette.secondary.dark,
                            '&:hover': {
                                background: theme.palette.secondary.dark,
                                color: theme.palette.secondary.light
                            }
                        }}
                        color='inherit'
                        onClick={() => navigate(-1)}
                    >
                        <IconChevronLeft stroke={1.5} size='1.3rem' />
                    </Avatar>
                </ButtonBase>
            </Box>
            <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                <Stack flexDirection='column' sx={{ ml: 2, minWidth: 0 }}>
                    <Typography
                        sx={{
                            fontSize: '1.5rem',
                            fontWeight: 600
                        }}
                    >
                        {flowName}
                    </Typography>
                    {settingsNote ? (
                        <Typography
                            variant='body2'
                            role='status'
                            sx={{ color: theme.palette.text.secondary, whiteSpace: 'normal', maxWidth: 720 }}
                        >
                            {settingsNote}
                        </Typography>
                    ) : null}
                </Stack>
            </Box>
            {legacy ? (
                <Typography variant='body2' sx={{ color: theme.palette.text.secondary, maxWidth: 360, textAlign: 'right' }}>
                    Legacy agentflow template. You can look at it, but new flows can&apos;t be made from it.
                </Typography>
            ) : (
                <Available permission={templateUsePermission(templateType)}>
                    <Box>
                        <StyledButton
                            color='secondary'
                            variant='contained'
                            title='Use Template'
                            onClick={() => onChatflowCopy(flowData)}
                            startIcon={<IconCopy />}
                        >
                            Use Template
                        </StyledButton>
                    </Box>
                </Available>
            )}
        </>
    )
}

MarketplaceCanvasHeader.propTypes = {
    flowName: PropTypes.string,
    flowData: PropTypes.object,
    legacy: PropTypes.bool,
    templateType: PropTypes.string,
    onChatflowCopy: PropTypes.func
}

export default MarketplaceCanvasHeader
