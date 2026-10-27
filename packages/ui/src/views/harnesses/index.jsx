import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import {
    Box,
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogContentText,
    DialogTitle,
    Stack,
    ToggleButton,
    ToggleButtonGroup,
    Typography
} from '@mui/material'
import { alpha, useTheme } from '@mui/material/styles'

import harnessesApi from '@/api/harnesses'
import ViewHeader from '@/layout/MainLayout/ViewHeader'
import MainCard from '@/ui-component/cards/MainCard'
import ItemCard from '@/ui-component/cards/ItemCard'
import { FlowListTable } from '@/ui-component/table/FlowListTable'
import TagDialog from '@/ui-component/dialog/TagDialog'
import { useError } from '@/store/context/ErrorContext'
import { PermissionButton, PermissionIconButton, StyledPermissionButton } from '@/ui-component/button/RBACButtons'
import WhichFlow from '@/ui-component/flow/WhichFlow'
import { t } from '@/i18n'
import TryTheDemo from '@/ui-component/flow/TryTheDemo'
import { HARNESS_LABEL } from '@/ui-component/flow/buildChoices'
import useApi from '@/hooks/useApi'
import {
    HARNESS_DELETE_PERMISSION,
    harnessCardDescription,
    harnessCategories,
    harnessDeleteBody,
    harnessDeleteTitle,
    harnessNodeImages
} from '@/utils/harnessCard'
import { CHATFLOW_CATEGORY_PERMISSION } from '@/utils/flowCategoryPermission'
import { baseURL } from '@/store/constant'

import { IconLayoutGrid, IconList, IconPlus, IconTag, IconTemplate, IconTrash } from '@tabler/icons-react'

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
    const [view, setView] = useState(localStorage.getItem('harnessDisplayStyle') || 'card')
    const [pendingCategory, setPendingCategory] = useState(null)
    const [categoryDialogProps, setCategoryDialogProps] = useState({})
    const { handleError } = useError()
    const [pendingDelete, setPendingDelete] = useState(null)
    const [deleting, setDeleting] = useState(false)
    const [deleteError, setDeleteError] = useState('')

    const saveCategory = async (categories) => {
        const harness = pendingCategory
        setPendingCategory(null)
        try {
            await harnessesApi.updateHarnessCategory(harness.name, categories.join(';'))
            listApi.request()
        } catch (error) {
            handleError(error)
        }
    }

    const renderRowActions = (harness) => (
        <>
            <PermissionIconButton
                permissionId={CHATFLOW_CATEGORY_PERMISSION}
                aria-label={`Update Category ${harness.name}`}
                title='Update Category'
                size='small'
                onClick={(event) => {
                    event.stopPropagation()
                    setCategoryDialogProps(harness.category ? { category: harness.category.split(';') } : {})
                    setPendingCategory(harness)
                }}
            >
                <IconTag size={18} />
            </PermissionIconButton>
            <PermissionIconButton
                permissionId={HARNESS_DELETE_PERMISSION}
                aria-label={`Delete ${harness.name}`}
                title='Delete'
                size='small'
                color='error'
                onClick={(event) => {
                    event.stopPropagation()
                    setDeleteError('')
                    setPendingDelete(harness)
                }}
            >
                <IconTrash size={18} />
            </PermissionIconButton>
        </>
    )

    const confirmDelete = async () => {
        if (!pendingDelete) return
        setDeleting(true)
        setDeleteError('')
        try {
            await harnessesApi.deleteHarness(pendingDelete.name)
            setPendingDelete(null)
            listApi.request()
        } catch (error) {
            const status = error?.response?.status
            setDeleteError(
                status === 403
                    ? 'You do not have permission to delete this agent team.'
                    : error?.response?.data?.message || 'The agent team was not deleted. Try again.'
            )
        } finally {
            setDeleting(false)
        }
    }

    useEffect(() => {
        listApi.request()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const saved = listApi.data || []
    const harnesses = saved.filter((harness) => {
        if (!search) return true
        return (
            harness.name.toLowerCase().includes(search.toLowerCase()) ||
            (harness.category || '').toLowerCase().includes(search.toLowerCase())
        )
    })

    const images = Object.fromEntries(saved.map((harness) => [harness.name, harnessNodeImages(harness, baseURL)]))

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
                    <ToggleButtonGroup
                        sx={{ borderRadius: 2, maxHeight: 40, flexShrink: 0 }}
                        value={view}
                        color='primary'
                        disabled={saved.length === 0}
                        exclusive
                        onChange={(_, nextView) => {
                            if (!nextView) return
                            setView(nextView)
                            localStorage.setItem('harnessDisplayStyle', nextView)
                        }}
                    >
                        <ToggleButton
                            sx={{
                                borderColor: theme.palette.grey[900] + 25,
                                borderRadius: 2,
                                color: theme?.customization?.isDarkMode ? 'white' : 'inherit'
                            }}
                            variant='contained'
                            value='card'
                            title='Card View'
                        >
                            <IconLayoutGrid />
                        </ToggleButton>
                        <ToggleButton
                            sx={{
                                borderColor: theme.palette.grey[900] + 25,
                                borderRadius: 2,
                                color: theme?.customization?.isDarkMode ? 'white' : 'inherit'
                            }}
                            variant='contained'
                            value='list'
                            title='List View'
                        >
                            <IconList />
                        </ToggleButton>
                    </ToggleButtonGroup>
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
                ) : view === 'list' ? (
                    <FlowListTable
                        data={harnesses.map((harness) => ({
                            ...harness,
                            id: harness.name,
                            name: harness.name,
                            category: harness.category || '',
                            updatedDate: harness.updatedAt
                        }))}
                        images={images}
                        filterFunction={() => true}
                        getRowLink={(row) => `/harnesses/${encodeURIComponent(row.name)}`}
                        renderActions={renderRowActions}
                        sortStorageKeyPrefix='harness'
                    />
                ) : (
                    <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 2 }}>
                        {harnesses.map((harness) => (
                            <Box key={harness.name} sx={{ position: 'relative' }}>
                                <ItemCard
                                    data={{
                                        name: harness.name,
                                        description: harnessCardDescription(harness),
                                        type: 'HARNESS',
                                        updatedDate: harness.updatedAt || harness.updatedDate
                                    }}
                                    images={images[harness.name]}
                                    categories={harnessCategories(harness)}
                                    onClick={() => navigate(`/harnesses/${encodeURIComponent(harness.name)}`)}
                                />
                                <Stack direction='row' sx={{ position: 'absolute', top: 8, right: 8 }}>
                                    {renderRowActions(harness)}
                                </Stack>
                            </Box>
                        ))}
                    </Box>
                )}
            </Stack>
            <TagDialog
                isOpen={Boolean(pendingCategory)}
                dialogProps={categoryDialogProps}
                onClose={() => setPendingCategory(null)}
                onSubmit={saveCategory}
            />
            <Dialog
                open={Boolean(pendingDelete)}
                onClose={() => !deleting && setPendingDelete(null)}
                aria-labelledby='harness-delete-title'
            >
                <DialogTitle id='harness-delete-title'>{pendingDelete ? harnessDeleteTitle(pendingDelete.name) : ''}</DialogTitle>
                <DialogContent>
                    <DialogContentText>{pendingDelete ? harnessDeleteBody(pendingDelete) : ''}</DialogContentText>
                    {deleteError && (
                        <Typography color='error' sx={{ mt: 1.5 }}>
                            {deleteError}
                        </Typography>
                    )}
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setPendingDelete(null)} disabled={deleting}>
                        Cancel
                    </Button>
                    <Button color='error' variant='contained' onClick={confirmDelete} disabled={deleting}>
                        {deleting ? 'Deleting' : 'Delete'}
                    </Button>
                </DialogActions>
            </Dialog>
        </MainCard>
    )
}

export default Harnesses
