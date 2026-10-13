// DELETE /api/v1/document-store/chunks/:storeId/:loaderId/:chunkId accepts update or delete.
// delete-loader is the loader route, not the chunk route.
export const CHUNK_DELETE_PERMISSION = 'documentStores:update,documentStores:delete'
