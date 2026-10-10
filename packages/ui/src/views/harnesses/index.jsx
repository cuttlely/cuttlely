import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { Box, Stack, Typography } from '@mui/material'
import { alpha, useTheme } from '@mui/material/styles'

import harnessesApi from '@/api/harnesses'
import ViewHeader from '@/layout/MainLayout/ViewHeader'
import MainCard from '@/ui-component/cards/MainCard'
import ItemCard from '@/ui-component/cards/ItemCard'
import { PermissionButton, StyledPermissionButton } from '@/ui-component/button/RBACButtons'
import WhichFlow from '@/ui-component/flow/WhichFlow'
import { t } from '@/i18n'
import TryTheDemo from '@/ui-component/flow/TryTheDemo'
import { HARNESS_LABEL } from '@/ui-component/flow/buildChoices'
import useApi from '@/hooks/useApi'

import { IconPlus, IconTemplate } from '@tabler/icons-react'

const actionButtonSx = {
    height: 40,
    px: 1.75,
    borderRadius: 2,
    textTransform: 'none',
    fontWeight: 600,
    boxShadow: 'none'
}

const Harnesses = () => {
    const navigate = useNavigate()
    const theme = useTheme()
    const listApi = useApi(harnessesApi.listHarnesses)
    const [search, setSearch] = useState('')

    useEffect(() => {
        listApi.request()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const saved = listApi.data || []
    const harnesses = saved.filter((harness) => {
        if (!search) return true
        return harness.name.toLowerCase().includes(search.toLowerCase())
    })

    const renderActions = (justify) => (
        <Stack
            direction='row'
            alignItems='center'
            justifyContent={justify}
            sx={{ gap: 1, flexWrap: 'wrap', minWidth: 0, maxWidth: '100%' }}
        >
            <PermissionButton
                permissionId={'templates:marketplace,templates:custom'}
                variant='outlined'
                onClick={() => navigate('/marketplaces')}
                startIcon={<IconTemplate size={18} />}
                sx={{
                    ...actionButtonSx,
                    color: theme.palette.mode === 'dark' ? theme.palette.text.primary : theme.palette.primary.main,
                    borderColor: alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.55 : 0.4),
                    '&:hover': {
                        borderColor: theme.palette.primary.main,
                        backgroundColor: alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.14 : 0.06)
                    }
                }}
            >
                Start from template
            </PermissionButton>
            <StyledPermissionButton
                permissionId={'chatflows:create'}
                variant='contained'
                onClick={() => navigate('/harnesscanvas')}
                startIcon={<IconPlus size={18} />}
                sx={actionButtonSx}
            >
                New agent team
            </StyledPermissionButton>
        </Stack>
    )
    const empty = !listApi.loading && !listApi.error && saved.length === 0

    return (
        <MainCard>
            <Stack flexDirection='column' sx={{ gap: 3 }}>
                <ViewHeader
                    title={HARNESS_LABEL}
                    search={search}
                    onSearchChange={(value) => setSearch(value)}
                    searchPlaceholder='Search harnesses'
                    description='An agent team you can run from this page and call by name from a chatflow.'
                >
                    {renderActions('flex-end')}
                </ViewHeader>
                <TryTheDemo show={empty} />
                <WhichFlow pinned={empty} hero={empty} />
                {listApi.loading ? (
                    <Typography sx={{ px: 1 }}>Loading harnesses.</Typography>
                ) : listApi.error ? (
                    <Typography sx={{ px: 1 }} color='error'>
                        Could not load harnesses.
                    </Typography>
                ) : saved.length === 0 ? (
                    <Box
                        sx={{
                            px: 3,
                            py: { xs: 6, md: 8 },
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            textAlign: 'center',
                            borderRadius: 3,
                            border: '1px dashed',
                            borderColor: alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.4 : 0.28),
                            backgroundColor: alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.08 : 0.04)
                        }}
                    >
                        <Typography component='h2' sx={{ m: 0, fontSize: '1.125rem', fontWeight: 600, lineHeight: 1.3 }}>
                            {t('harnesses.empty.title')}
                        </Typography>
                        <Typography
                            sx={{
                                mt: 0.75,
                                mb: 2.5,
                                maxWidth: 420,
                                fontSize: '0.95rem',
                                color: alpha(theme.palette.text.primary, theme.palette.mode === 'dark' ? 0.62 : 0.68)
                            }}
                        >
                            {t('harnesses.empty.body')}
                        </Typography>
                        {renderActions('center')}
                    </Box>
                ) : harnesses.length === 0 ? (
                    <Typography color='text.secondary'>No agent team matches “{search}”.</Typography>
                ) : (
                    <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 2 }}>
                        {harnesses.map((harness) => (
                            <ItemCard
                                key={harness.name}
                                data={{
                                    name: harness.name,
                                    description: harness.description || `${harness.specialists?.length || 0} specialists`,
                                    type: 'HARNESS',
                                    updatedDate: harness.updatedAt || harness.updatedDate,
                                    iconSrc: undefined
                                }}
                                onClick={() => navigate(`/harnesses/${encodeURIComponent(harness.name)}`)}
                            />
                        ))}
                    </Box>
                )}
            </Stack>
        </MainCard>
    )
}

export default Harnesses
