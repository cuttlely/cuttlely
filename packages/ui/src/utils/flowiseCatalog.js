// Node names the migration scan checks against. The live canvas uses the same catalog.
import catalog from '../../../components/nodes/module-catalog.json'

export const flowiseNodeCatalog = Array.isArray(catalog.nodes) ? catalog.nodes : []
