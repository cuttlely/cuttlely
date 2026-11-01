import { useState, useRef, useEffect, memo } from 'react'
import { useSelector, useDispatch } from 'react-redux'
import PropTypes from 'prop-types'

// material-ui
import { useTheme } from '@mui/material/styles'
import {
    Accordion,
    AccordionSummary,
    AccordionDetails,
    Box,
    ClickAwayListener,
    Divider,
    InputAdornment,
    List,
    ListItemButton,
    ListItem,
    ListItemAvatar,
    ListItemText,
    OutlinedInput,
    Paper,
    Popper,
    Stack,
    Typography,
    Chip,
    Tab,
    Tabs
} from '@mui/material'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'

// third-party
import PerfectScrollbar from 'react-perfect-scrollbar'

// project imports
import MainCard from '@/ui-component/cards/MainCard'
import Transitions from '@/ui-component/extended/Transitions'
import { StyledFab } from '@/ui-component/button/StyledFab'
import BuildWithAIDialog from '@/ui-component/dialog/BuildWithAIDialog'
import { BUILD_BUTTON } from '@/utils/buildWithAI'
import { visibleInPalette } from '@/utils/nodePalette'
import { searchNodes } from '@/utils/nodeSearch'
import { displayLabel, regroupForPalette } from '@/utils/nodeDisplayNames'

// icons
import { IconPlus, IconSearch, IconMinus, IconX, IconSparkles } from '@tabler/icons-react'
import LangChainPNG from '@/assets/images/langchain.png'
import utilNodesPNG from '@/assets/images/utilNodes.png'

// const
import { baseURL, AGENTFLOW_ICONS } from '@/store/constant'
import { SET_COMPONENT_NODES } from '@/store/actions'

// ==============================|| ADD NODES||============================== //
function a11yProps(index) {
    return {
        id: `attachment-tab-${index}`,
        'aria-controls': `attachment-tabpanel-${index}`
    }
}

const blacklistCategoriesForAgentCanvas = ['Agents', 'Memory', 'Record Manager', 'Utilities']

const agentMemoryNodes = ['agentMemory', 'sqliteAgentMemory', 'postgresAgentMemory', 'mySQLAgentMemory']

// Show blacklisted nodes (exceptions) for agent canvas
const exceptionsForAgentCanvas = {
    Memory: agentMemoryNodes,
    Utilities: ['getVariable', 'setVariable', 'stickyNote']
}

// Hide some nodes from the chatflow canvas
const blacklistForChatflowCanvas = {
    Memory: agentMemoryNodes
}

const ETL_CATEGORIES = new Set(['ETL', 'Document Loaders', 'Text Splitters', 'Embeddings', 'Vector Stores'])
const NOT_ETL_TARGETS = new Set(['vectorStoreToDocument'])
const ETL_PINNED = {
    'Vector Stores': ['etlLocalVectorStore', 'pinecone', 'Astra'],
    Embeddings: ['localHashEmbeddings'],
    'Text Splitters': ['recursiveCharacterTextSplitter']
}
const ETL_CATEGORY_NOTE = {
    'Vector Stores':
        'Local Vector Store needs no credential. Every other vector store uses the credential on its node. ETL upserts and deletes by chunk id, so a second run does not append duplicates.',
    Embeddings:
        'Local Hash Embeddings needs no key. Every other embeddings node uses the credential selected on that node. Nothing is read from the environment.',
    'Text Splitters': 'Every text splitter runs through its own init. A pipeline can use any of them.'
}
const ETL_ONLY_NODES = new Set(['etlFileSource', 'etlRepoSource'])

const AddNodes = ({ nodesData, isAgentCanvas, isHarnessCanvas, isEtlCanvas, buildKind, onBuilt, onPlaceNode, onOpenChange }) => {
    const theme = useTheme()
    const customization = useSelector((state) => state.customization)
    const dispatch = useDispatch()

    const [searchValue, setSearchValue] = useState('')
    const [nodes, setNodes] = useState({})
    const [open, setOpen] = useState(false)
    const [categoryExpanded, setCategoryExpanded] = useState({})
    const [tabValue, setTabValue] = useState(0)

    const [openDialog, setOpenDialog] = useState(false)

    const isAgentCanvasV2 = window.location.pathname.includes('/v2/agentcanvas')

    const anchorRef = useRef(null)
    const prevOpen = useRef(open)
    const ps = useRef()

    const scrollTop = () => {
        const curr = ps.current
        if (curr) {
            curr.scrollTop = 0
        }
    }

    const handleTabChange = (event, newValue) => {
        setTabValue(newValue)
        filterSearch(searchValue, newValue)
    }

    const addException = (category) => {
        let nodes = []
        if (category) {
            const nodeNames = exceptionsForAgentCanvas[category] || []
            nodes = nodesData.filter((nd) => nd.category === category && nodeNames.includes(nd.name))
        } else {
            for (const category in exceptionsForAgentCanvas) {
                const nodeNames = exceptionsForAgentCanvas[category]
                nodes.push(...nodesData.filter((nd) => nd.category === category && nodeNames.includes(nd.name)))
            }
        }
        return nodes
    }

    const scoreAndSortNodes = (nodes, value) => searchNodes(nodes, value)

    const getSearchedNodes = (value) => {
        if (isEtlCanvas) {
            const nodes = nodesData.filter((nd) => ETL_CATEGORIES.has(nd.category) && !NOT_ETL_TARGETS.has(nd.name))
            return scoreAndSortNodes(nodes, value)
        }
        if (isHarnessCanvas) {
            const allowed = new Set([
                'Harness',
                'Chat Models',
                'Retrievers',
                'Tools',
                'Tools (MCP)',
                'Vector Stores',
                'Document Loaders',
                'Embeddings',
                'Text Splitters'
            ])
            const nodes = nodesData.filter((nd) => allowed.has(nd.category) && nd.name !== 'harness')
            return scoreAndSortNodes(nodes, value)
        }
        if (isAgentCanvas) {
            const nodes = nodesData.filter(
                (nd) =>
                    !blacklistCategoriesForAgentCanvas.includes(nd.category) &&
                    nd.name !== 'harnessChief' &&
                    nd.name !== 'harnessSpecialist'
            )
            nodes.push(...addException())
            return scoreAndSortNodes(nodes, value)
        }
        let nodes = nodesData.filter(
            (nd) =>
                !ETL_ONLY_NODES.has(nd.name) &&
                nd.category !== 'Multi Agents' &&
                nd.category !== 'Sequential Agents' &&
                nd.name !== 'harnessChief' &&
                nd.name !== 'harnessSpecialist'
        )

        for (const category in blacklistForChatflowCanvas) {
            const nodeNames = blacklistForChatflowCanvas[category]
            nodes = nodes.filter((nd) => !nodeNames.includes(nd.name))
        }

        return scoreAndSortNodes(nodes, value)
    }

    const filterSearch = (value, newTabValue) => {
        setSearchValue(value)
        setTimeout(() => {
            if (value) {
                const returnData = getSearchedNodes(value)
                groupByCategory(returnData, newTabValue ?? tabValue, true, value)
                scrollTop()
            } else if (value === '') {
                groupByCategory(nodesData, newTabValue ?? tabValue)
                scrollTop()
            }
        }, 500)
    }

    const groupByTags = (nodes, newTabValue = 0) => {
        if (newTabValue === 0) return nodes.filter((nd) => !nd.tags)
        return nodes.filter((nd) => nd.tags && nd.tags.includes('Utilities'))
    }

    // query is the search as typed: searchValue in this closure can still be the previous one.
    const groupByCategory = (incoming, newTabValue, isFilter, query = searchValue) => {
        const nodes = (incoming || []).filter((nd) => visibleInPalette(nd, isFilter ? query : ''))
        if (isEtlCanvas) {
            const order = ['ETL', 'Document Loaders', 'Text Splitters', 'Embeddings', 'Vector Stores']
            const grouped = {}
            const expanded = {}
            for (const category of order) {
                const list = nodes.filter((nd) => nd.category === category && !NOT_ETL_TARGETS.has(nd.name))
                if (!list.length) continue
                const pinned = ETL_PINNED[category] || []
                list.sort((a, b) => {
                    const ia = pinned.indexOf(a.name)
                    const ib = pinned.indexOf(b.name)
                    if (ia === -1 && ib === -1) return String(a.label).localeCompare(String(b.label))
                    if (ia === -1) return 1
                    if (ib === -1) return -1
                    return ia - ib
                })
                grouped[category] = list
                expanded[category] = isFilter ? true : category === 'ETL'
            }
            setNodes(grouped)
            setCategoryExpanded(expanded)
            return
        }
        if (isAgentCanvas || isHarnessCanvas) {
            const accordianCategories = {}
            const result = nodes.reduce(function (r, a) {
                r[a.category] = r[a.category] || []
                r[a.category].push(a)
                accordianCategories[a.category] = isFilter ? true : false
                return r
            }, Object.create(null))

            const filteredResult = {}
            for (const category in result) {
                if (isHarnessCanvas) {
                    const allowed = new Set([
                        'Harness',
                        'Chat Models',
                        'Retrievers',
                        'Tools',
                        'Tools (MCP)',
                        'Vector Stores',
                        'Document Loaders',
                        'Embeddings',
                        'Text Splitters'
                    ])
                    if (!allowed.has(category)) continue
                } else if (isAgentCanvasV2) {
                    if (category !== 'Agent Flows' && category !== 'Harness') {
                        continue
                    }
                } else {
                    if (category === 'Agent Flows') {
                        continue
                    }
                }
                // Filter out blacklisted categories
                if (!blacklistCategoriesForAgentCanvas.includes(category)) {
                    const nodes = result[category]
                        .filter((nd) => !isHarnessCanvas || nd.name !== 'harness')
                        .filter((nd) => isHarnessCanvas || (nd.name !== 'harnessChief' && nd.name !== 'harnessSpecialist'))
                    if (!nodes.length) continue

                    filteredResult[category] = nodes
                }

                // Allow exceptionsForAgentCanvas
                if (Object.keys(exceptionsForAgentCanvas).includes(category)) {
                    filteredResult[category] = addException(category)
                }
            }
            accordianCategories['Multi Agents'] = true
            accordianCategories['Sequential Agents'] = true
            accordianCategories['Memory'] = true
            accordianCategories['Agent Flows'] = true
            if (isHarnessCanvas) accordianCategories['Harness'] = true
            const regrouped = regroupForPalette(filteredResult, accordianCategories)
            setNodes(regrouped.nodes)
            setCategoryExpanded(regrouped.expanded)
        } else {
            const taggedNodes = groupByTags(nodes, newTabValue)
            const accordianCategories = {}
            const result = taggedNodes.reduce(function (r, a) {
                r[a.category] = r[a.category] || []
                r[a.category].push(a)
                accordianCategories[a.category] = isFilter ? true : false
                return r
            }, Object.create(null))

            const filteredResult = {}
            for (const category in result) {
                if (category === 'Agent Flows' || category === 'Multi Agents' || category === 'Sequential Agents') {
                    continue
                }
                if (category === 'Harness') {
                    result[category] = result[category].filter((nd) => nd.name === 'harness')
                }
                if (category === 'ETL') {
                    result[category] = result[category].filter((nd) => !ETL_ONLY_NODES.has(nd.name))
                }
                if (Object.keys(blacklistForChatflowCanvas).includes(category)) {
                    const nodes = blacklistForChatflowCanvas[category]
                    result[category] = result[category].filter((nd) => !nodes.includes(nd.name))
                }
                filteredResult[category] = result[category]
            }

            const regrouped = regroupForPalette(filteredResult, accordianCategories)
            setNodes(regrouped.nodes)
            setCategoryExpanded(regrouped.expanded)
        }
    }

    const handleAccordionChange = (category) => (event, isExpanded) => {
        const accordianCategories = { ...categoryExpanded }
        accordianCategories[category] = isExpanded
        setCategoryExpanded(accordianCategories)
    }

    const handleClose = (event) => {
        if (anchorRef.current && anchorRef.current.contains(event.target)) {
            return
        }
        setOpen(false)
    }

    const handleToggle = () => {
        setOpen((prevOpen) => !prevOpen)
    }

    const pointerStart = useRef(null)

    const onDragStart = (event, node) => {
        event.dataTransfer.setData('application/reactflow', JSON.stringify(node))
        event.dataTransfer.effectAllowed = 'move'
    }

    const onPaletteClick = (event, paletteNode) => {
        const start = pointerStart.current
        pointerStart.current = null
        if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return
        onPlaceNode?.(paletteNode)
    }

    const getImage = (tabValue) => {
        return tabValue === 0 ? LangChainPNG : utilNodesPNG
    }

    const renderIcon = (node) => {
        const foundIcon = AGENTFLOW_ICONS.find((icon) => icon.name === node.name)

        if (!foundIcon) return null
        return <foundIcon.icon size={30} color={node.color} />
    }

    useEffect(() => {
        if (prevOpen.current === true && open === false) {
            anchorRef.current.focus()
        }

        prevOpen.current = open
        onOpenChange?.(open)
    }, [open, onOpenChange])

    useEffect(() => {
        if (nodesData) {
            groupByCategory(nodesData)
            dispatch({ type: SET_COMPONENT_NODES, componentNodes: nodesData })
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [nodesData, dispatch])

    // Build with AI open/close
    const handleOpenDialog = () => setOpenDialog(true)

    const handleCloseDialog = () => setOpenDialog(false)

    const handleBuilt = (result) => {
        setOpenDialog(false)
        onBuilt(result)
    }

    return (
        <>
            <StyledFab
                sx={{ left: 20, top: 20 }}
                ref={anchorRef}
                size='small'
                color='primary'
                aria-label='add'
                title='Add Node'
                onClick={handleToggle}
            >
                {open ? <IconMinus /> : <IconPlus />}
            </StyledFab>
            {buildKind && (
                <StyledFab
                    sx={{
                        left: 40,
                        top: 20,
                        background: 'linear-gradient(45deg, #FF6B6B 30%, #FF8E53 90%)',
                        '&:hover': {
                            background: 'linear-gradient(45deg, #FF8E53 30%, #FF6B6B 90%)'
                        }
                    }}
                    onClick={handleOpenDialog}
                    size='small'
                    color='primary'
                    aria-label={BUILD_BUTTON}
                    title={BUILD_BUTTON}
                >
                    <IconSparkles />
                </StyledFab>
            )}

            {buildKind && <BuildWithAIDialog show={openDialog} kind={buildKind} onCancel={handleCloseDialog} onBuilt={handleBuilt} />}

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
                                offset: [-40, 14]
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
                                <MainCard border={false} elevation={16} content={false} boxShadow shadow={theme.shadows[16]}>
                                    <Box sx={{ p: 2 }}>
                                        <Stack>
                                            <Typography variant='h4'>Add Nodes</Typography>
                                        </Stack>
                                        <OutlinedInput
                                            // eslint-disable-next-line
                                            autoFocus
                                            sx={{ width: '100%', pr: 2, pl: 2, my: 2 }}
                                            id='input-search-node'
                                            value={searchValue}
                                            onChange={(e) => filterSearch(e.target.value)}
                                            placeholder='Search nodes'
                                            startAdornment={
                                                <InputAdornment position='start'>
                                                    <IconSearch stroke={1.5} size='1rem' color={theme.palette.grey[500]} />
                                                </InputAdornment>
                                            }
                                            endAdornment={
                                                <InputAdornment
                                                    position='end'
                                                    sx={{
                                                        cursor: 'pointer',
                                                        color: theme.palette.grey[500],
                                                        '&:hover': {
                                                            color: theme.palette.grey[900]
                                                        }
                                                    }}
                                                    title='Clear Search'
                                                >
                                                    <IconX
                                                        stroke={1.5}
                                                        size='1rem'
                                                        onClick={() => filterSearch('')}
                                                        style={{
                                                            cursor: 'pointer'
                                                        }}
                                                    />
                                                </InputAdornment>
                                            }
                                            aria-describedby='search-helper-text'
                                            inputProps={{
                                                'aria-label': 'weight'
                                            }}
                                        />
                                        {!isAgentCanvas && !isHarnessCanvas && !isEtlCanvas && (
                                            <Tabs
                                                sx={{ position: 'relative', minHeight: '50px', height: '50px' }}
                                                variant='fullWidth'
                                                value={tabValue}
                                                onChange={handleTabChange}
                                                aria-label='tabs'
                                            >
                                                {['LangChain', 'Utilities'].map((item, index) => (
                                                    <Tab
                                                        icon={
                                                            <div
                                                                style={{
                                                                    borderRadius: '50%',
                                                                    position: 'relative'
                                                                }}
                                                            >
                                                                <img
                                                                    style={{
                                                                        width: '20px',
                                                                        height: '20px',
                                                                        borderRadius: '50%',
                                                                        objectFit: 'contain'
                                                                    }}
                                                                    src={getImage(index)}
                                                                    alt={item}
                                                                />
                                                            </div>
                                                        }
                                                        iconPosition='start'
                                                        sx={{ minHeight: '50px', height: '50px' }}
                                                        key={index}
                                                        label={item}
                                                        {...a11yProps(index)}
                                                    ></Tab>
                                                ))}
                                            </Tabs>
                                        )}

                                        <Divider />
                                    </Box>
                                    <PerfectScrollbar
                                        containerRef={(el) => {
                                            ps.current = el
                                        }}
                                        style={{
                                            height: '100%',
                                            maxHeight: `calc(100vh - ${isAgentCanvas || isHarnessCanvas || isEtlCanvas ? '300' : '380'}px)`,
                                            overflowX: 'hidden'
                                        }}
                                    >
                                        <Box sx={{ p: 2, pt: 0 }}>
                                            <List
                                                sx={{
                                                    width: '100%',
                                                    maxWidth: 370,
                                                    py: 0,
                                                    borderRadius: '10px',
                                                    [theme.breakpoints.down('md')]: {
                                                        maxWidth: 370
                                                    },
                                                    '& .MuiListItemSecondaryAction-root': {
                                                        top: 22
                                                    },
                                                    '& .MuiDivider-root': {
                                                        my: 0
                                                    },
                                                    '& .list-container': {
                                                        pl: 7
                                                    }
                                                }}
                                            >
                                                {Object.keys(nodes)
                                                    .sort()
                                                    .map((category) => (
                                                        <Accordion
                                                            expanded={categoryExpanded[category] || false}
                                                            onChange={handleAccordionChange(category)}
                                                            key={category}
                                                            disableGutters
                                                        >
                                                            <AccordionSummary
                                                                expandIcon={<ExpandMoreIcon />}
                                                                aria-controls={`nodes-accordian-${category}`}
                                                                id={`nodes-accordian-header-${category}`}
                                                            >
                                                                {category.split(';').length > 1 ? (
                                                                    <div
                                                                        style={{
                                                                            display: 'flex',
                                                                            flexDirection: 'row',
                                                                            alignItems: 'center'
                                                                        }}
                                                                    >
                                                                        <Typography variant='h5'>{category.split(';')[0]}</Typography>
                                                                        &nbsp;
                                                                        <Chip
                                                                            sx={{
                                                                                width: 'max-content',
                                                                                fontWeight: 700,
                                                                                fontSize: '0.65rem',
                                                                                background:
                                                                                    category.split(';')[1] === 'DEPRECATING'
                                                                                        ? theme.palette.warning.main
                                                                                        : theme.palette.teal.main,
                                                                                color:
                                                                                    category.split(';')[1] !== 'DEPRECATING'
                                                                                        ? 'white'
                                                                                        : 'inherit'
                                                                            }}
                                                                            size='small'
                                                                            label={category.split(';')[1]}
                                                                        />
                                                                    </div>
                                                                ) : (
                                                                    <Typography variant='h5'>{category}</Typography>
                                                                )}
                                                            </AccordionSummary>
                                                            <AccordionDetails>
                                                                {isEtlCanvas && ETL_CATEGORY_NOTE[category] && (
                                                                    <Typography
                                                                        variant='caption'
                                                                        color='text.secondary'
                                                                        sx={{ display: 'block', px: 1, pb: 1 }}
                                                                    >
                                                                        {ETL_CATEGORY_NOTE[category]}
                                                                    </Typography>
                                                                )}
                                                                {nodes[category].map((node, index) => (
                                                                    <div
                                                                        key={node.name}
                                                                        onDragStart={(event) => onDragStart(event, node)}
                                                                        draggable
                                                                    >
                                                                        <ListItemButton
                                                                            sx={{
                                                                                p: 0,
                                                                                borderRadius: `${customization.borderRadius}px`,
                                                                                cursor: 'pointer'
                                                                            }}
                                                                            onPointerDown={(event) => {
                                                                                pointerStart.current = {
                                                                                    x: event.clientX,
                                                                                    y: event.clientY
                                                                                }
                                                                            }}
                                                                            onClick={(event) => onPaletteClick(event, node)}
                                                                        >
                                                                            <ListItem alignItems='center'>
                                                                                {node.color && !node.icon ? (
                                                                                    <ListItemAvatar>
                                                                                        <div
                                                                                            style={{
                                                                                                width: 50,
                                                                                                height: 'auto',
                                                                                                display: 'flex',
                                                                                                alignItems: 'center',
                                                                                                justifyContent: 'center'
                                                                                            }}
                                                                                        >
                                                                                            {renderIcon(node)}
                                                                                        </div>
                                                                                    </ListItemAvatar>
                                                                                ) : (
                                                                                    <ListItemAvatar>
                                                                                        <div
                                                                                            style={{
                                                                                                width: 50,
                                                                                                height: 50,
                                                                                                borderRadius: '50%',
                                                                                                backgroundColor: 'white'
                                                                                            }}
                                                                                        >
                                                                                            <img
                                                                                                style={{
                                                                                                    width: '100%',
                                                                                                    height: '100%',
                                                                                                    padding: 10,
                                                                                                    objectFit: 'contain'
                                                                                                }}
                                                                                                alt={node.name}
                                                                                                src={`${baseURL}/api/v1/node-icon/${node.name}`}
                                                                                            />
                                                                                        </div>
                                                                                    </ListItemAvatar>
                                                                                )}
                                                                                <ListItemText
                                                                                    sx={{ ml: 1 }}
                                                                                    primary={
                                                                                        <>
                                                                                            <div
                                                                                                style={{
                                                                                                    display: 'flex',
                                                                                                    flexDirection: 'row',
                                                                                                    alignItems: 'center'
                                                                                                }}
                                                                                            >
                                                                                                <span>{displayLabel(node)}</span>
                                                                                                &nbsp;
                                                                                                {node.badge && (
                                                                                                    <Chip
                                                                                                        sx={{
                                                                                                            width: 'max-content',
                                                                                                            fontWeight: 700,
                                                                                                            fontSize: '0.65rem',
                                                                                                            background:
                                                                                                                node.badge === 'DEPRECATING'
                                                                                                                    ? theme.palette.warning
                                                                                                                          .main
                                                                                                                    : theme.palette.teal
                                                                                                                          .main,
                                                                                                            color:
                                                                                                                node.badge !== 'DEPRECATING'
                                                                                                                    ? 'white'
                                                                                                                    : 'inherit'
                                                                                                        }}
                                                                                                        size='small'
                                                                                                        label={node.badge}
                                                                                                    />
                                                                                                )}
                                                                                            </div>
                                                                                            {node.author && (
                                                                                                <span
                                                                                                    style={{
                                                                                                        fontSize: '0.65rem',
                                                                                                        fontWeight: 700
                                                                                                    }}
                                                                                                >
                                                                                                    By {node.author}
                                                                                                </span>
                                                                                            )}
                                                                                        </>
                                                                                    }
                                                                                    secondary={node.description}
                                                                                    secondaryTypographyProps={{
                                                                                        sx: { whiteSpace: 'normal' }
                                                                                    }}
                                                                                />
                                                                            </ListItem>
                                                                        </ListItemButton>
                                                                        {index === nodes[category].length - 1 ? null : <Divider />}
                                                                    </div>
                                                                ))}
                                                            </AccordionDetails>
                                                        </Accordion>
                                                    ))}
                                            </List>
                                        </Box>
                                    </PerfectScrollbar>
                                </MainCard>
                            </ClickAwayListener>
                        </Paper>
                    </Transitions>
                )}
            </Popper>
        </>
    )
}

AddNodes.propTypes = {
    nodesData: PropTypes.array,
    buildKind: PropTypes.string,
    onBuilt: PropTypes.func,
    isAgentCanvas: PropTypes.bool,
    isHarnessCanvas: PropTypes.bool,
    isEtlCanvas: PropTypes.bool,
    isAgentflowv2: PropTypes.bool,
    onPlaceNode: PropTypes.func,
    onOpenChange: PropTypes.func
}

export default memo(AddNodes)
