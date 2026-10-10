import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

// material-ui
import { Alert, Box, Divider, Menu, MenuItem, Skeleton, Stack, ToggleButton, ToggleButtonGroup } from '@mui/material'
import { useTheme } from '@mui/material/styles'

// project imports
import ErrorBoundary from '@/ErrorBoundary'
import ViewHeader from '@/layout/MainLayout/ViewHeader'
import { cardGridColumns, gridSpacing } from '@/store/constant'
import { PermissionButton, StyledPermissionButton } from '@/ui-component/button/RBACButtons'
import FromDevBanner from '@/ui-component/flow/FromDevBanner'
import WhichFlow from '@/ui-component/flow/WhichFlow'
import TryTheDemo from '@/ui-component/flow/TryTheDemo'
import Mascot from '@/ui-component/extended/Mascot'
import { t } from '@/i18n'
import ItemCard from '@/ui-component/cards/ItemCard'
import MainCard from '@/ui-component/cards/MainCard'
import ConfirmDialog from '@/ui-component/dialog/ConfirmDialog'
import TablePagination, { DEFAULT_ITEMS_PER_PAGE } from '@/ui-component/pagination/TablePagination'
import { FlowListTable } from '@/ui-component/table/FlowListTable'

// API
import chatflowsApi from '@/api/chatflows'

// Hooks
import useApi from '@/hooks/useApi'

// const
import { baseURL } from '@/store/constant'
import { useError } from '@/store/context/ErrorContext'

// icons
import { IconChevronDown, IconFileImport, IconLayoutGrid, IconList, IconPlus, IconTemplate } from '@tabler/icons-react'
import FlowiseMigrationWizard from '@/ui-component/flow/FlowiseMigrationWizard'
import { flowiseCanvasJson } from '@/utils/flowiseImport'
import { isLangflowExport, langflowToFlowise } from '@/utils/langflowImport'
import { BRING_YOUR_FLOWS_URL } from '@/ui-component/flow/buildChoices'

const headerButtonSx = {
    borderRadius: 2,
    height: 40,
    px: 2,
    flexShrink: 0,
    whiteSpace: 'nowrap',
    textTransform: 'none',
    fontWeight: 600,
    boxShadow: 'none',
    '&:hover': { boxShadow: 'none' }
}

// ==============================|| CHATFLOWS ||============================== //

const Chatflows = () => {
    const navigate = useNavigate()
    const theme = useTheme()

    const [isLoading, setLoading] = useState(true)
    const [images, setImages] = useState({})
    const [search, setSearch] = useState('')
    const [importError, setImportError] = useState('')
    const [importMenu, setImportMenu] = useState(null)
    const [migrationOpen, setMigrationOpen] = useState(false)
    const importInput = useRef(null)
    const { error, setError } = useError()

    const getAllChatflowsApi = useApi(chatflowsApi.getAllChatflows)
    const [view, setView] = useState(localStorage.getItem('chatFlowDisplayStyle') || 'card')

    /* Table Pagination */
    const [currentPage, setCurrentPage] = useState(1)
    const [pageLimit, setPageLimit] = useState(() => Number(localStorage.getItem('chatFlowPageSize') || DEFAULT_ITEMS_PER_PAGE))
    const [total, setTotal] = useState(0)

    const onChange = (page, pageLimit) => {
        setCurrentPage(page)
        setPageLimit(pageLimit)
        localStorage.setItem('chatFlowPageSize', pageLimit)
        applyFilters(page, pageLimit)
    }

    const applyFilters = (page, limit) => {
        const params = {
            page: page || currentPage,
            limit: limit || pageLimit
        }
        getAllChatflowsApi.request(params)
    }

    const handleChange = (event, nextView) => {
        if (nextView === null) return
        localStorage.setItem('chatFlowDisplayStyle', nextView)
        setView(nextView)
    }

    const onSearchChange = (event) => {
        setSearch(event.target.value)
    }

    function filterFlows(data) {
        return (
            data?.name.toLowerCase().indexOf(search.toLowerCase()) > -1 ||
            (data.category && data.category.toLowerCase().indexOf(search.toLowerCase()) > -1) ||
            data?.id.toLowerCase().indexOf(search.toLowerCase()) > -1
        )
    }

    const addNew = () => {
        navigate('/canvas')
    }

    const openImport = (kind) => {
        setImportMenu(null)
        setImportError('')
        if (kind !== 'langflow') {
            setMigrationOpen(true)
            return
        }
        if (importInput.current) importInput.current.value = ''
        importInput.current?.click()
    }

    const goToTemplates = () => {
        navigate('/marketplaces')
    }

    const onImportFile = (event) => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (!file) return
        const reader = new FileReader()
        reader.onload = () => {
            let parsed
            try {
                parsed = JSON.parse(String(reader.result || ''))
            } catch {
                setImportError('That file is not a Langflow export.')
                return
            }
            const langflow = isLangflowExport(parsed)
            const canvas = langflow ? null : flowiseCanvasJson(parsed)
            if (!langflow) {
                setImportError(canvas ? 'That file is Flowise JSON. Use Import Flowise JSON.' : 'That file is not a Langflow export.')
                return
            }
            const result = langflowToFlowise(parsed)
            if (!result.ok) {
                setImportError(result.reason)
                return
            }
            localStorage.setItem('duplicatedFlowData', JSON.stringify({ cuttlelyLangflow: true, name: result.name, flow: result.flow }))
            navigate('/canvas')
        }
        reader.readAsText(file)
    }

    const goToCanvas = (selectedChatflow) => {
        navigate(`/canvas/${selectedChatflow.id}`)
    }

    useEffect(() => {
        applyFilters(currentPage, pageLimit)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => {
        setLoading(getAllChatflowsApi.loading)
    }, [getAllChatflowsApi.loading])

    useEffect(() => {
        if (getAllChatflowsApi.data) {
            try {
                const chatflows = getAllChatflowsApi.data?.data
                const total = getAllChatflowsApi.data?.total
                setTotal(total)
                const images = {}
                for (let i = 0; i < chatflows.length; i += 1) {
                    const flowDataStr = chatflows[i].flowData
                    const flowData = JSON.parse(flowDataStr)
                    const nodes = flowData.nodes || []
                    images[chatflows[i].id] = []
                    for (let j = 0; j < nodes.length; j += 1) {
                        if (nodes[j].data.name === 'stickyNote' || nodes[j].data.name === 'stickyNoteAgentflow') continue
                        const imageSrc = `${baseURL}/api/v1/node-icon/${nodes[j].data.name}`
                        if (!images[chatflows[i].id].some((img) => img.imageSrc === imageSrc)) {
                            images[chatflows[i].id].push({
                                imageSrc,
                                label: nodes[j].data.label
                            })
                        }
                    }
                }
                setImages(images)
            } catch (e) {
                console.error(e)
            }
        }
    }, [getAllChatflowsApi.data])

    return (
        <MainCard>
            {error ? (
                <ErrorBoundary error={error} />
            ) : (
                <Stack flexDirection='column' sx={{ gap: 3 }}>
                    <ViewHeader
                        onSearchChange={onSearchChange}
                        search={true}
                        searchPlaceholder='Search chatflows'
                        title='Chatflows'
                        description='Build single-agent systems, chatbots and simple LLM flows'
                    >
                        <ToggleButtonGroup
                            sx={{ borderRadius: 2, maxHeight: 40, flexShrink: 0 }}
                            value={view}
                            color='primary'
                            disabled={total === 0}
                            exclusive
                            onChange={handleChange}
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
                        <PermissionButton
                            permissionId={'chatflows:import'}
                            variant='outlined'
                            aria-haspopup='menu'
                            aria-controls={importMenu ? 'chatflows-import-menu' : undefined}
                            onClick={(event) => setImportMenu(event.currentTarget)}
                            startIcon={<IconFileImport size={18} />}
                            endIcon={<IconChevronDown size={16} />}
                            sx={headerButtonSx}
                        >
                            Import
                        </PermissionButton>
                        <Menu
                            id='chatflows-import-menu'
                            anchorEl={importMenu}
                            open={Boolean(importMenu)}
                            onClose={() => setImportMenu(null)}
                        >
                            <MenuItem onClick={() => openImport('flowise')}>Import Flowise JSON</MenuItem>
                            <MenuItem onClick={() => openImport('langflow')}>Import Langflow JSON</MenuItem>
                            <Divider />
                            <MenuItem
                                component='a'
                                href={BRING_YOUR_FLOWS_URL}
                                target='_blank'
                                rel='noopener noreferrer'
                                onClick={() => setImportMenu(null)}
                                sx={{ typography: 'body2', color: 'text.secondary' }}
                            >
                                What carries over
                            </MenuItem>
                        </Menu>
                        <PermissionButton
                            permissionId={'templates:marketplace,templates:custom'}
                            variant='outlined'
                            onClick={goToTemplates}
                            startIcon={<IconTemplate size={18} />}
                            sx={headerButtonSx}
                        >
                            Start from a template
                        </PermissionButton>
                        <StyledPermissionButton
                            permissionId={'chatflows:create'}
                            variant='contained'
                            onClick={addNew}
                            startIcon={<IconPlus size={18} />}
                            sx={headerButtonSx}
                        >
                            Add New
                        </StyledPermissionButton>
                    </ViewHeader>
                    <input ref={importInput} type='file' hidden accept='.json' onChange={onImportFile} />
                    {importError && <Alert severity='warning'>{importError}</Alert>}
                    <FromDevBanner types={['CHATFLOW']} />
                    <TryTheDemo show={!isLoading && total === 0} />
                    <WhichFlow pinned={!isLoading && total === 0} hero />

                    {isLoading && (
                        <Box sx={{ display: 'grid', gridTemplateColumns: cardGridColumns, gap: gridSpacing }}>
                            <Skeleton variant='rounded' height={160} />
                            <Skeleton variant='rounded' height={160} />
                            <Skeleton variant='rounded' height={160} />
                        </Box>
                    )}
                    {!isLoading && total > 0 && (
                        <>
                            {!view || view === 'card' ? (
                                <Box sx={{ display: 'grid', gridTemplateColumns: cardGridColumns, gap: gridSpacing }}>
                                    {getAllChatflowsApi.data?.data?.filter(filterFlows).map((data, index) => (
                                        <ItemCard key={index} onClick={() => goToCanvas(data)} data={data} images={images[data.id]} />
                                    ))}
                                </Box>
                            ) : (
                                <FlowListTable
                                    data={getAllChatflowsApi.data?.data}
                                    images={images}
                                    isLoading={isLoading}
                                    filterFunction={filterFlows}
                                    updateFlowsApi={getAllChatflowsApi}
                                    setError={setError}
                                    currentPage={currentPage}
                                    pageLimit={pageLimit}
                                />
                            )}
                            {/* Pagination and Page Size Controls */}
                            <TablePagination currentPage={currentPage} limit={pageLimit} total={total} onChange={onChange} />
                        </>
                    )}
                    {!isLoading && (!getAllChatflowsApi.data?.data || getAllChatflowsApi.data?.data.length === 0) && (
                        <Stack sx={{ alignItems: 'center', justifyContent: 'center' }} flexDirection='column'>
                            <Box sx={{ p: 2 }}>
                                <Mascot pose='lightbulb' size={112} />
                            </Box>
                            <div>{t('chatflows.empty.body')}</div>
                        </Stack>
                    )}
                </Stack>
            )}
            <ConfirmDialog />
            <FlowiseMigrationWizard
                open={migrationOpen}
                onClose={() => setMigrationOpen(false)}
                onOpen={({ canvas, name, route }) => {
                    localStorage.setItem('duplicatedFlowData', JSON.stringify({ cuttlelyMigration: true, name, flow: canvas }))
                    setMigrationOpen(false)
                    navigate(route || '/canvas')
                }}
            />
        </MainCard>
    )
}

export default Chatflows
