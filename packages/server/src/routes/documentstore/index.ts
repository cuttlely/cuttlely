import express from 'express'
import { requirePermission, requireAnyPermission } from '../../identity/rbac'
import documentStoreController from '../../controllers/documentstore'
import { getMulterStorage } from '../../utils'
import { authorizeDocumentStoreUpsert } from '../../utils/authorizeUpsert'

const router = express.Router()

// API-4c: permission and workspace checks run before multer, which writes each file as it streams in.
router.post(
    ['/upsert/', '/upsert/:id'],
    requirePermission('documentStores:upsert-config'),
    authorizeDocumentStoreUpsert,
    getMulterStorage().array('files'),
    documentStoreController.upsertDocStoreMiddleware
)

router.post(['/refresh/', '/refresh/:id'], documentStoreController.refreshDocStoreMiddleware)

/** Document Store Routes */
// Create document store
router.post('/store', requirePermission('documentStores:create'), documentStoreController.createDocumentStore)
// List all stores
router.get('/store', requirePermission('documentStores:view'), documentStoreController.getAllDocumentStores)
// Get specific store
router.get(
    '/store/:id',
    requireAnyPermission('documentStores:view,documentStores:update,documentStores:delete'),
    documentStoreController.getDocumentStoreById
)
// Update documentStore
router.put('/store/:id', requireAnyPermission('documentStores:create,documentStores:update'), documentStoreController.updateDocumentStore)
// Delete documentStore
router.delete('/store/:id', requirePermission('documentStores:delete'), documentStoreController.deleteDocumentStore)
// Get document store configs
router.get('/store-configs/:id/:loaderId', requireAnyPermission('documentStores:view'), documentStoreController.getDocStoreConfigs)

/** Component Nodes = Document Store - Loaders */
// Get all loaders
router.get('/components/loaders', requirePermission('documentStores:add-loader'), documentStoreController.getDocumentLoaders)

// delete loader from document store
router.delete(
    '/loader/:id/:loaderId',
    requirePermission('documentStores:delete-loader'),
    documentStoreController.deleteLoaderFromDocumentStore
)
// chunking preview
router.post('/loader/preview', requirePermission('documentStores:preview-process'), documentStoreController.previewFileChunks)
// saving process
router.post('/loader/save', requirePermission('documentStores:preview-process'), documentStoreController.saveProcessingLoader)
// chunking process
router.post('/loader/process/:loaderId', requirePermission('documentStores:preview-process'), documentStoreController.processLoader)

/** Document Store - Loaders - Chunks */
// delete specific file chunk from the store
router.delete(
    '/chunks/:storeId/:loaderId/:chunkId',
    requireAnyPermission('documentStores:update,documentStores:delete'),
    documentStoreController.deleteDocumentStoreFileChunk
)
// edit specific file chunk from the store
router.put(
    '/chunks/:storeId/:loaderId/:chunkId',
    requirePermission('documentStores:update'),
    documentStoreController.editDocumentStoreFileChunk
)
// Get all file chunks from the store
router.get('/chunks/:storeId/:fileId/:pageNo', requirePermission('documentStores:view'), documentStoreController.getDocumentStoreFileChunks)

// add chunks to the selected vector store
router.post('/vectorstore/insert', requirePermission('documentStores:upsert-config'), documentStoreController.insertIntoVectorStore)
// save the selected vector store
router.post('/vectorstore/save', requirePermission('documentStores:upsert-config'), documentStoreController.saveVectorStoreConfig)
// delete data from the selected vector store
router.delete(
    '/vectorstore/:storeId',
    requirePermission('documentStores:upsert-config'),
    documentStoreController.deleteVectorStoreFromStore
)
// query the vector store
router.post('/vectorstore/query', requirePermission('documentStores:view'), documentStoreController.queryVectorStore)
// Get all embedding providers
router.get('/components/embeddings', requirePermission('documentStores:upsert-config'), documentStoreController.getEmbeddingProviders)
// Get all vector store providers
router.get('/components/vectorstore', requirePermission('documentStores:upsert-config'), documentStoreController.getVectorStoreProviders)
// Get all Record Manager providers
router.get(
    '/components/recordmanager',
    requirePermission('documentStores:upsert-config'),
    documentStoreController.getRecordManagerProviders
)

// update the selected vector store from the playground
router.post('/vectorstore/update', requirePermission('documentStores:upsert-config'), documentStoreController.updateVectorStoreConfigOnly)

// generate docstore tool description
router.post('/generate-tool-desc/:id', requirePermission('documentStores:view'), documentStoreController.generateDocStoreToolDesc)

export default router
