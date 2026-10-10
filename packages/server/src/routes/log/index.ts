import express from 'express'

const router = express.Router()

// Login activity and logs stay off (D50). This router is not mounted; a mount still answers 404.
router.use((_req, res) => {
    res.status(404).json({ message: 'Not Found' })
})

export default router
