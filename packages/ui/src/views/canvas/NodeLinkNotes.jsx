import PropTypes from 'prop-types'
import { useContext } from 'react'
import { useEdges } from 'reactflow'

import { flowContext } from '@/store/context/ReactFlowContext'
import { POSTGRES_NODE, SPECIALIST_NODE, linkNote } from '@/utils/nodeDisplayNames'
import { ANALYST_OFF_HINT, ANALYST_OFF_NOTE, useAnalystOff } from '@/utils/analystStatus'

const LINKED = [POSTGRES_NODE, SPECIALIST_NODE]

// "Used by: Analyst" on a Postgres tool and "Data: Postgres (MCP)" on a specialist, from the edges drawn right
// now. Nothing here is saved. The turned-off note shows only on a specialist, never on the Postgres tool.
const LinkNotesInner = ({ nodeId, name, dense }) => {
    const edges = useEdges()
    const { reactFlowInstance } = useContext(flowContext)
    const nodes = reactFlowInstance?.getNodes?.() || []
    const note = linkNote(nodeId, nodes, edges)
    const off = useAnalystOff(name === SPECIALIST_NODE ? nodeId : null, nodes, edges)
    if (!note && !off) return null
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
                    style={{ color: '#b26a00', marginTop: note ? 2 : 0 }}
                >
                    {ANALYST_OFF_NOTE}
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
