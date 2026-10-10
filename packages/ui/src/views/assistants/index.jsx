import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSelector } from 'react-redux'

// material-ui
import { Button, Card, CardContent, Chip, Stack } from '@mui/material'
import { useTheme, styled } from '@mui/material/styles'

// project imports
import MainCard from '@/ui-component/cards/MainCard'
import ViewHeader from '@/layout/MainLayout/ViewHeader'

// icons
import { IconRobotFace, IconBrandOpenai } from '@tabler/icons-react'

const cards = [
    {
        title: 'Custom Assistant',
        description: 'Create custom assistant using your choice of LLMs',
        icon: <IconRobotFace />,
        iconText: 'Custom',
        gradient: 'linear-gradient(135deg, #fff8e14e 0%, #ffcc802f 100%)'
    },
    {
        title: 'OpenAI Assistant',
        description:
            'Create assistant using OpenAI Assistant API. This option is being deprecated; consider using Custom Assistant instead.',
        icon: <IconBrandOpenai />,
        iconText: 'OpenAI',
        gradient: 'linear-gradient(135deg, #c9ffd85f 0%, #a0f0b567 100%)',
        deprecating: true
    }
]

const StyledCard = styled(Card)(({ gradient }) => ({
    height: '300px',
    background: gradient,
    position: 'relative',
    overflow: 'hidden',
    transition: 'transform 0.3s ease-in-out, box-shadow 0.3s ease-in-out',
    cursor: 'pointer'
}))

const FeatureIcon = styled('div')(() => ({
    display: 'inline-flex',
    padding: '4px 8px',
    backgroundColor: 'rgba(0, 0, 0, 0.05)',
    borderRadius: '4px',
    marginBottom: '16px',
    '& svg': {
        width: '1.2rem',
        height: '1.2rem',
        marginRight: '8px'
    }
}))

const FeatureCards = () => {
    const navigate = useNavigate()
    const theme = useTheme()
    const customization = useSelector((state) => state.customization)
    const [showAdvanced, setShowAdvanced] = useState(false)
    const visibleCards = cards.filter((card) => showAdvanced || !card.deprecating)

    const onCardClick = (card) => {
        if (card.deprecating) navigate('/assistants/openai')
        else navigate('/assistants/custom')
    }

    return (
        <Stack spacing={2}>
            <Stack
                spacing={3}
                direction='row'
                sx={{
                    width: '100%',
                    justifyContent: 'flex-start'
                }}
            >
                {visibleCards.map((card) => (
                    <StyledCard
                        key={card.title}
                        gradient={card.gradient}
                        sx={{
                            flex: 1,
                            maxWidth: visibleCards.length === 1 ? 480 : 'calc((100% - 16px) / 2)',
                            height: 'auto',
                            display: 'flex',
                            flexDirection: 'column',
                            justifyContent: 'space-between',
                            border: 1,
                            borderColor: theme.palette.grey[900] + 25,
                            borderRadius: 2,
                            color: customization.isDarkMode ? theme.palette.common.white : '#333333',
                            cursor: 'pointer',
                            '&:hover': {
                                boxShadow: '0 4px 20px rgba(0, 0, 0, 0.1)'
                            }
                        }}
                        onClick={() => onCardClick(card)}
                    >
                        <CardContent className='h-full relative z-10'>
                            <Stack direction='row' alignItems='center' justifyContent='space-between' sx={{ mb: 1 }}>
                                <FeatureIcon>
                                    {card.icon}
                                    <span className='text-xs uppercase'>{card.iconText}</span>
                                </FeatureIcon>
                                {card.deprecating && <Chip label='Deprecating' size='small' color='warning' sx={{ fontWeight: 600 }} />}
                            </Stack>
                            <h2 className='text-2xl font-bold mb-2'>{card.title}</h2>
                            <p className='text-gray-600'>{card.description}</p>
                        </CardContent>
                    </StyledCard>
                ))}
            </Stack>
            <Button onClick={() => setShowAdvanced((open) => !open)} sx={{ alignSelf: 'flex-start', textTransform: 'none' }}>
                {showAdvanced ? 'Hide advanced' : 'Advanced'}
            </Button>
        </Stack>
    )
}

// ==============================|| ASSISTANTS ||============================== //

const Assistants = () => {
    return (
        <>
            <MainCard>
                <Stack flexDirection='column' sx={{ gap: 3 }}>
                    <ViewHeader
                        title='Assistants'
                        description='Chat assistants with instructions, tools, and files to respond to user queries'
                    />
                    <FeatureCards />
                </Stack>
            </MainCard>
        </>
    )
}

export default Assistants
