import PropTypes from 'prop-types'
import { useTheme } from '@mui/material/styles'
import { useContext } from 'react'
import * as ReactFlow from 'reactflow'

import { flowContext } from '@/store/context/ReactFlowContext'
import { POSTGRES_NODE, SPECIALIST_NODE, linkNote } from '@/utils/nodeDisplayNames'
import { ANALYST_OFF_HINT, ANALYST_OFF_NOTE, useAnalystOff, useConnectionPicks } from '@/utils/analystStatus'

const LINKED = [POSTGRES_NODE, SPECIALIST_NODE]
// Live node list so a specialist given a new name shows it at once. A test double of reactflow may not have useNodes, and then
// the notes read the flow's current nodes instead.
const useLiveNodes = typeof ReactFlow.useNodes === 'function' ? ReactFlow.useNodes : () => null

// "Used by: Analyst" on a Postgres tool and "Data: Postgres (MCP)" on a specialist, from the edges drawn right
// now. Nothing here is saved. The turned-off note shows only on a specialist, never on the Postgres tool.
const LinkNotesInner = ({ nodeId, name, dense }) => {
    const edges = ReactFlow.useEdges()
    const live = useLiveNodes()
    useConnectionPicks()
    const { reactFlowInstance } = useContext(flowContext)
    const nodes = live || reactFlowInstance?.getNodes?.() || []
    const note = linkNote(nodeId, nodes, edges)
    const off = useAnalystOff(name === SPECIALIST_NODE ? nodeId : null, nodes, edges)
    const theme = useTheme()
    if (!note && !off) return null
    // Dark enough to read on the light canvas, light enough on the dark one.
    const warnText = theme?.palette?.mode === 'dark' ? '#ffb74d' : '#8a4b00'
    const pad = dense ? '0 10px 6px 70px' : '4px 16px'
    return (
        <div style={{ padding: pad, fontSize: 12, lineHeight: 1.4 }}>
            {note && (
                <div data-testid='link-note' style={{ color: 'inherit', opacity: 0.75 }}>
                    {note}
                </div>
            )}
            {off && (
                <div
                    data-testid='analyst-off-note'
                    role='note'
                    title={ANALYST_OFF_HINT}
                    style={{ color: warnText, marginTop: note ? 2 : 0 }}
                >
                    {ANALYST_OFF_NOTE}
                    {dense ? null : <div style={{ opacity: 0.85, marginTop: 2 }}>{ANALYST_OFF_HINT}</div>}
                </div>
            )}
        </div>
    )
}

LinkNotesInner.propTypes = { nodeId: PropTypes.string, name: PropTypes.string, dense: PropTypes.bool }

const NodeLinkNotes = ({ data, dense = false }) =>
    LINKED.includes(data?.name) ? <LinkNotesInner nodeId={data.id} name={data.name} dense={dense} /> : null

NodeLinkNotes.propTypes = { data: PropTypes.object, dense: PropTypes.bool }

export default NodeLinkNotes
