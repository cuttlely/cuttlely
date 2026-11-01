// Starting values for a card the user just added to the canvas. Applied only when a card is placed, never when
// a saved flow loads, so a saved node keeps exactly the values it was saved with.

import { POSTGRES_NODE } from './nodeDisplayNames'

// A new Postgres (MCP) card starts with the query tool ticked, saved the same way the picker saves it.
export const NEW_POSTGRES_ACTIONS = JSON.stringify(['query'])

const empty = (value) => value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)

export function withNewNodeDefaults(data) {
    if (data?.name !== POSTGRES_NODE || !data.inputs || !empty(data.inputs.mcpActions)) return data
    return { ...data, inputs: { ...data.inputs, mcpActions: NEW_POSTGRES_ACTIONS } }
}
