export const DEPOSIT_TEMPLATES_STORAGE_KEY = 'safe_haven_deposit_templates'

export interface DepositTemplate {
  id: string
  name: string
  tokenAddress: string
  amount: string
  unlockDate: string
  penaltyBps: string
  createdAt: string
}

export interface ExportedSettings {
  version: 1
  exportedAt: string
  depositTemplates: DepositTemplate[]
}

export function loadDepositTemplates(): DepositTemplate[] {
  if (typeof localStorage === 'undefined') return []

  try {
    const saved = localStorage.getItem(DEPOSIT_TEMPLATES_STORAGE_KEY)
    if (!saved) return []
    const templates = JSON.parse(saved)
    return Array.isArray(templates) ? templates : []
  } catch {
    return []
  }
}

export function saveDepositTemplates(templates: DepositTemplate[]) {
  localStorage.setItem(DEPOSIT_TEMPLATES_STORAGE_KEY, JSON.stringify(templates))
}

export function createSettingsExport(templates = loadDepositTemplates()): ExportedSettings {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    depositTemplates: templates,
  }
}

export function downloadSettingsExport(templates = loadDepositTemplates()) {
  const blob = new Blob([JSON.stringify(createSettingsExport(templates), null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `safe-haven-settings-${new Date().toISOString().slice(0, 10)}.json`
  link.click()
  URL.revokeObjectURL(url)
}