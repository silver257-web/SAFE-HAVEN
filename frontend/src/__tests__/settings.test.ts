import { describe, expect, it } from 'vitest'
import { createSettingsExport, type DepositTemplate } from '../lib/settings'

describe('settings export', () => {
  it('creates a versioned export containing deposit templates', () => {
    const template: DepositTemplate = {
      id: 'template-1',
      name: 'Monthly savings',
      tokenAddress: 'CABC',
      amount: '10',
      unlockDate: '2030-01-01T12:00',
      penaltyBps: '0',
      createdAt: '2026-08-26T12:00:00.000Z',
    }

    expect(createSettingsExport([template])).toMatchObject({
      version: 1,
      depositTemplates: [template],
    })
    expect(createSettingsExport([template]).exportedAt).toEqual(expect.any(String))
  })
})