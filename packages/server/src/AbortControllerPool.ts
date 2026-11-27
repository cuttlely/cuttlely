/**
 * This pool is to keep track of abort controllers mapped to chatflowid_chatid
 */
export class AbortControllerPool {
    private pausedForStorage = false
    abortControllers: Record<string, AbortController> = {}

    /**
     * Add to the pool
     * @param {string} id
     * @param {AbortController} abortController
     */
    add(id: string, abortController: AbortController) {
        if (this.pausedForStorage) {
            abortController.abort()
            return
        }
        this.abortControllers[id] = abortController
    }

    /**
     * Remove from the pool
     * @param {string} id
     */
    remove(id: string) {
        if (Object.prototype.hasOwnProperty.call(this.abortControllers, id)) {
            delete this.abortControllers[id]
        }
    }

    /**
     * Get the abort controller
     * @param {string} id
     */
    get(id: string) {
        return this.abortControllers[id]
    }

    /**
     * Abort
     * @param {string} id
     */
    abort(id: string) {
        const abortController = this.abortControllers[id]
        if (abortController) {
            abortController.abort()
            this.remove(id)
        }
    }
    pauseForStorage(paused: boolean) {
        this.pausedForStorage = paused
        if (!paused) return
        for (const id of Object.keys(this.abortControllers)) this.abort(id)
    }
}
