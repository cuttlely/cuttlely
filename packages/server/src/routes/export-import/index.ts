import express from 'express'

const router = express.Router()

// Workspace export and import stay unimplemented (D50). Closed for every caller, including an owner.
// Reopening import means running the harness checks a save runs on each imported canvas (see importData, D91).
router.use((_req, res) => {
    res.status(404).json({ message: 'Not Found' })
})

export default router
