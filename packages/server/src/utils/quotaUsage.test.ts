import { UsageCacheManager } from '../UsageCacheManager'
import { checkPredictions, checkStorage, checkUsageLimit, getCurrentUsage, updatePredictionsUsage, updateStorageUsage } from './quotaUsage'

describe('open source quotas', () => {
    it('does not read a usage manager', async () => {
        const usage = {
            get: jest.fn(),
            getQuotas: jest.fn(),
            getSubscriptionDetails: jest.fn(),
            set: jest.fn()
        }
        const manager = usage as unknown as UsageCacheManager
        await expect(checkPredictions('org', 'sub', manager)).resolves.toBeUndefined()
        await expect(checkStorage('org', 'sub', manager)).resolves.toBeUndefined()
        await expect(checkUsageLimit('users', 'sub', manager, 100000)).resolves.toBeUndefined()
        await expect(updatePredictionsUsage('org', 'sub', 'ws', manager)).resolves.toBeUndefined()
        expect(updateStorageUsage('org', 'ws', 10, manager)).toBeUndefined()
        await expect(getCurrentUsage('org', 'sub', manager)).resolves.toEqual({
            predictions: { usage: 0, limit: -1 },
            storage: { usage: 0, limit: -1 }
        })
        expect(usage.get).not.toHaveBeenCalled()
        expect(usage.getQuotas).not.toHaveBeenCalled()
        expect(usage.getSubscriptionDetails).not.toHaveBeenCalled()
        expect(usage.set).not.toHaveBeenCalled()
    })

    it('returns unlimited quotas without a subscription product', async () => {
        const manager = await UsageCacheManager.getInstance()
        await expect(manager.getQuotas('missing-subscription')).resolves.toEqual({
            'quota:predictions': -1,
            'quota:storage': -1,
            'quota:flows': -1,
            'quota:users': -1,
            'quota:additionalSeats': -1
        })
    })
})
