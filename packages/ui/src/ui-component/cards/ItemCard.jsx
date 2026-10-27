import PropTypes from 'prop-types'
import { useSelector } from 'react-redux'

// material-ui
import { styled } from '@mui/material/styles'
import { Box, Chip, Grid, Tooltip, Typography, useTheme } from '@mui/material'

// project imports
import MainCard from '@/ui-component/cards/MainCard'
import MoreItemsTooltip from '../tooltip/MoreItemsTooltip'
import ScheduleStatusBadge from '@/ui-component/extended/ScheduleStatusBadge'
import { formatListDateTime } from '@/utils/formatDate'
import { HARNESS_LABEL } from '@/ui-component/flow/buildChoices'
import { LEGACY_AGENTFLOW_LABEL } from '@/utils/legacyAgentflows'

const CardWrapper = styled(MainCard)(({ theme }) => ({
    background: theme.palette.card.main,
    color: theme.darkTextPrimary,
    overflow: 'auto',
    position: 'relative',
    boxShadow: '0 2px 14px 0 rgb(32 40 45 / 8%)',
    cursor: 'pointer',
    '&:hover': {
        background: theme.palette.card.hover,
        boxShadow: '0 2px 14px 0 rgb(32 40 45 / 20%)'
    },
    height: '100%',
    minHeight: '160px',
    maxHeight: '300px',
    width: '100%',
    overflowWrap: 'break-word',
    whiteSpace: 'pre-line'
}))

// ===========================|| CONTRACT CARD ||=========================== //

const TYPE_LABELS = {
    CHATFLOW: 'Chatflow',
    Chatflow: 'Chatflow',
    MULTIAGENT: LEGACY_AGENTFLOW_LABEL,
    AGENTFLOW: 'Agentflow',
    Agentflow: LEGACY_AGENTFLOW_LABEL,
    AgentflowV2: 'Agentflow',
    ASSISTANT: 'Assistant',
    HARNESS: HARNESS_LABEL,
    Harness: HARNESS_LABEL,
    ETL: 'ETL',
    Tool: 'Tool'
}

const ItemCard = ({ data, images, icons, categories, scheduleStatus, onClick }) => {
    const theme = useTheme()
    const customization = useSelector((state) => state.customization)
    const typeLabel = TYPE_LABELS[data.type] || data.typeLabel || ''
    const updatedLabel = formatListDateTime(data.updatedDate)

    return (
        <CardWrapper content={false} onClick={onClick} sx={{ border: 1, borderColor: theme.palette.grey[900] + 25, borderRadius: 2 }}>
            <Box sx={{ height: '100%', p: 2.25 }}>
                <Grid container justifyContent='space-between' direction='column' sx={{ height: '100%', gap: 3 }}>
                    <Box display='flex' flexDirection='column' sx={{ width: '100%' }}>
                        <div
                            style={{
                                width: '100%',
                                display: 'flex',
                                flexDirection: 'row',
                                alignItems: 'center',
                                overflow: 'hidden'
                            }}
                        >
                            {data.iconSrc && (
                                <div
                                    style={{
                                        width: 35,
                                        height: 35,
                                        display: 'flex',
                                        flexShrink: 0,
                                        marginRight: 10,
                                        borderRadius: '50%',
                                        backgroundImage: `url(${data.iconSrc})`,
                                        backgroundSize: 'contain',
                                        backgroundRepeat: 'no-repeat',
                                        backgroundPosition: 'center center'
                                    }}
                                ></div>
                            )}
                            {!data.iconSrc && data.color && (
                                <div
                                    style={{
                                        width: 35,
                                        height: 35,
                                        display: 'flex',
                                        flexShrink: 0,
                                        marginRight: 10,
                                        borderRadius: '50%',
                                        background: data.color
                                    }}
                                ></div>
                            )}
                            <Typography
                                sx={{
                                    display: '-webkit-box',
                                    fontSize: '1.25rem',
                                    fontWeight: 500,
                                    WebkitLineClamp: 2,
                                    WebkitBoxOrient: 'vertical',
                                    textOverflow: 'ellipsis',
                                    overflow: 'hidden'
                                }}
                            >
                                {data.templateName || data.name}
                            </Typography>
                        </div>
                        {(typeLabel || updatedLabel) && (
                            <Typography variant='caption' color='text.secondary' sx={{ display: 'block', mt: 0.5 }}>
                                {[typeLabel, updatedLabel && `Updated ${updatedLabel}`].filter(Boolean).join(' · ')}
                            </Typography>
                        )}
                        {data.description && (
                            <span
                                style={{
                                    display: '-webkit-box',
                                    marginTop: 10,
                                    overflowWrap: 'break-word',
                                    WebkitLineClamp: 3,
                                    WebkitBoxOrient: 'vertical',
                                    textOverflow: 'ellipsis',
                                    overflow: 'hidden'
                                }}
                            >
                                {data.description}
                            </span>
                        )}
                        {categories?.length > 0 && (
                            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 1.25 }}>
                                {categories.map((tag, index) => (
                                    <Chip key={`${tag}-${index}`} label={tag} size='small' />
                                ))}
                            </Box>
                        )}
                    </Box>
                    {(images?.length > 0 || icons?.length > 0 || scheduleStatus?.isScheduled) && (
                        <Box
                            sx={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: 1
                            }}
                        >
                            <Box
                                sx={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 1,
                                    flex: 1,
                                    minWidth: 0,
                                    overflow: 'hidden'
                                }}
                            >
                                {[
                                    ...(images || []).map((img) => ({ type: 'image', src: img.imageSrc, label: img.label })),
                                    ...(icons || []).map((ic) => ({ type: 'icon', icon: ic.icon, color: ic.color, label: ic.name }))
                                ]
                                    .slice(0, 3)
                                    .map((item, index) => (
                                        <Tooltip key={item.src || index} title={item.label} placement='top'>
                                            {item.type === 'image' ? (
                                                <Box
                                                    sx={{
                                                        width: 30,
                                                        height: 30,
                                                        borderRadius: '50%',
                                                        backgroundColor: customization.isDarkMode
                                                            ? theme.palette.common.white
                                                            : theme.palette.grey[300] + 75
                                                    }}
                                                >
                                                    <img
                                                        style={{ width: '100%', height: '100%', padding: 5, objectFit: 'contain' }}
                                                        alt=''
                                                        src={item.src}
                                                    />
                                                </Box>
                                            ) : (
                                                <div
                                                    style={{
                                                        width: 30,
                                                        height: 30,
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        justifyContent: 'center'
                                                    }}
                                                >
                                                    <item.icon size={25} color={item.color} />
                                                </div>
                                            )}
                                        </Tooltip>
                                    ))}

                                {(images?.length || 0) + (icons?.length || 0) > 3 && (
                                    <MoreItemsTooltip
                                        images={[
                                            ...(images?.slice(3) || []),
                                            ...(icons?.slice(Math.max(0, 3 - (images?.length || 0))) || []).map((ic) => ({
                                                label: ic.name
                                            }))
                                        ]}
                                    >
                                        <Typography
                                            sx={{
                                                alignItems: 'center',
                                                display: 'flex',
                                                fontSize: '.9rem',
                                                fontWeight: 200
                                            }}
                                        >
                                            + {(images?.length || 0) + (icons?.length || 0) - 3} More
                                        </Typography>
                                    </MoreItemsTooltip>
                                )}
                            </Box>
                            <ScheduleStatusBadge scheduleStatus={scheduleStatus} />
                        </Box>
                    )}
                </Grid>
            </Box>
        </CardWrapper>
    )
}

ItemCard.propTypes = {
    data: PropTypes.object,
    images: PropTypes.array,
    icons: PropTypes.array,
    categories: PropTypes.arrayOf(PropTypes.string),
    scheduleStatus: PropTypes.object,
    onClick: PropTypes.func
}

export default ItemCard
