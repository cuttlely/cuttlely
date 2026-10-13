// DELETE /api/v1/document-store/chunks/:storeId/:loaderId/:chunkId accepts update or delete.
// delete-loader is the loader route, not the chunk route.
export const CHUNK_DELETE_PERMISSION = 'documentStores:update,documentStores:delete'

// PUT /api/v1/document-store/chunks/:storeId/:loaderId/:chunkId requires update.
export const CHUNK_EDIT_PERMISSION = 'documentStores:update'
