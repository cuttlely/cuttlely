import express from 'express'

const router = express.Router()

// Workspace export and import stay unimplemented (D50). Closed for every caller, including an owner.
router.use((_req, res) => {
    res.status(404).json({ message: 'Not Found' })
})

export default router
