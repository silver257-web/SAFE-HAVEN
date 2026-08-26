import { useState, useEffect } from 'react'
import toast from 'react-hot-toast'
import { useWallet } from '../context/WalletContext'
import { TxStatusBadge } from '../components/TxStatusBadge'
import { buildDeposit, submitTx, getTokenDecimals, getTokenMetadata } from '../lib/stellar'
import { xlmToStroops, stroopsToXlm, formatBps, formatDuration, dateTimeLocalToUnixSeconds, getMinDateTimeLocal, formatUnlockTimestampWithTimezone, getTimezoneOffsetString, amountToBaseUnits, baseUnitsToAmount, isValidContractAddress, validateTokenAddress } from '../lib/format'
import type { TxStatus } from '../types'
import type { ContractInfo } from '../App'
import { CONFIG } from '../config'
import { loadDepositTemplates, saveDepositTemplates, type DepositTemplate } from '../lib/settings'

interface DepositPageProps {
  contractInfo: ContractInfo
  onSuccess: () => void
}

export function DepositPage({ contractInfo, onSuccess }: DepositPageProps) {
  const { wallet, isRestoringSession, signTransaction } = useWallet()

  const [tokenAddress, setTokenAddress] = useState(CONFIG.NATIVE_TOKEN)
  const [amount,       setAmount]       = useState('')
  const [unlockDate,   setUnlockDate]   = useState('')
  const [penaltyBps,   setPenaltyBps]   = useState('0')
  const [templateName, setTemplateName] = useState('')
  const [templates, setTemplates] = useState<DepositTemplate[]>(loadDepositTemplates)

  const [txStatus, setTxStatus] = useState<TxStatus>('idle')
  const [txHash,   setTxHash]   = useState<string | undefined>()
  const [txError,  setTxError]  = useState<string | undefined>()

  // Token decimals state — defaults to 7 (XLM) but updates when token changes
  const [tokenDecimals, setTokenDecimals] = useState<number>(7)
  const [decimalsLoading, setDecimalsLoading] = useState(false)

  // Token metadata state for verification
  const [tokenMetadata, setTokenMetadata] = useState<{ name: string; symbol: string } | null>(null)
  const [tokenAddressError, setTokenAddressError] = useState<string>('')

  // Fetch token decimals when token address changes
  useEffect(() => {
    if (!tokenAddress || tokenAddress === CONFIG.NATIVE_TOKEN) {
      setTokenDecimals(7)
      setDecimalsLoading(false)
      setTokenMetadata(null)
      setTokenAddressError('')
      return
    }

    // Validate format first
    const validation = validateTokenAddress(tokenAddress)
    if (!validation.valid) {
      setTokenAddressError(validation.message)
      setTokenDecimals(7)
      setTokenMetadata(null)
      setDecimalsLoading(false)
      return
    }

    setTokenAddressError('')
    setDecimalsLoading(true)

    // Fetch both decimals and metadata in parallel
    Promise.all([getTokenDecimals(tokenAddress), getTokenMetadata(tokenAddress)]).then(
      ([decimals, metadata]) => {
        if (decimals !== null) {
          setTokenDecimals(decimals)
        } else {
          setTokenDecimals(7)
        }
        if (metadata) {
          setTokenMetadata(metadata)
        }
        setDecimalsLoading(false)
      },
    ).catch(() => {
      setTokenDecimals(7)
      setTokenMetadata(null)
      setDecimalsLoading(false)
    })
  }, [tokenAddress])

  // Derived validation
  const amountNum       = parseFloat(amount)
  const penaltyBpsNum   = parseInt(penaltyBps, 10)
  const unlockTimestamp = unlockDate ? dateTimeLocalToUnixSeconds(unlockDate) : 0
  const nowSecs         = Math.floor(Date.now() / 1000)
  const lockDuration    = unlockTimestamp - nowSecs

  // Convert amount to base units using the token's decimal precision
  const amountInBaseUnits = amount ? amountToBaseUnits(amount, tokenDecimals) : 0n

  const errors = {
    amount:    !amount ? '' : isNaN(amountNum) || amountNum <= 0 ? 'Amount must be > 0' :
               amountInBaseUnits > contractInfo.maxDeposit ? `Max: ${baseUnitsToAmount(contractInfo.maxDeposit, tokenDecimals)} tokens` : '',
    unlock:    !unlockDate ? '' : unlockTimestamp <= nowSecs ? 'Must be in the future' :
               lockDuration < CONFIG.MIN_LOCK_DURATION_SECS ? `Minimum lock: ${formatDuration(CONFIG.MIN_LOCK_DURATION_SECS)}` :
               lockDuration > contractInfo.maxLockSecs ? `Max lock: ${formatDuration(contractInfo.maxLockSecs)}` : '',
    penalty:   isNaN(penaltyBpsNum) || penaltyBpsNum < 0 || penaltyBpsNum > 10_000 ? '0–10000 only' : '',
  }
  const isValid = amount && unlockDate && !errors.amount && !errors.unlock && !errors.penalty && !contractInfo.paused && !decimalsLoading

  function handleSaveTemplate() {
    const name = templateName.trim()
    if (!name || !amount || !unlockDate) return

    const nextTemplates = [
      ...templates,
      {
        id: crypto.randomUUID(),
        name,
        tokenAddress,
        amount,
        unlockDate,
        penaltyBps,
        createdAt: new Date().toISOString(),
      },
    ]
    saveDepositTemplates(nextTemplates)
    setTemplates(nextTemplates)
    setTemplateName('')
    toast.success('Deposit template saved')
  }

  function handleLoadTemplate(template: DepositTemplate) {
    setTokenAddress(template.tokenAddress)
    setAmount(template.amount)
    setUnlockDate(template.unlockDate)
    setPenaltyBps(template.penaltyBps)
  }

  function handleDeleteTemplate(id: string) {
    const nextTemplates = templates.filter((template) => template.id !== id)
    saveDepositTemplates(nextTemplates)
    setTemplates(nextTemplates)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!wallet || !isValid) return

    setTxStatus('signing')
    setTxError(undefined)
    setTxHash(undefined)

    try {
      const amountBaseUnits = amountToBaseUnits(amount, tokenDecimals)
      const xdr = await buildDeposit(wallet.address, tokenAddress, amountBaseUnits, unlockTimestamp, penaltyBpsNum)
      if (!xdr) throw new Error('Failed to build transaction')

      const sigResult = await signTransaction(xdr)
      
      // Handle the three signing outcomes
      if (sigResult.signed) {
        // Success: proceed with submission
        setTxStatus('submitting')
        const result = await submitTx(sigResult.xdr)
        
        if (result.success) {
          setTxStatus('success')
          setTxHash(result.txHash)
          toast.success('Deposit successful! Your tokens are locked.')
          setAmount('')
          setUnlockDate('')
          setPenaltyBps('0')
          setTimeout(onSuccess, 1500)
        } else {
          setTxStatus('error')
          setTxError(result.error)
          toast.error(result.error ?? 'Deposit failed')
        }
      } else if (sigResult.rejected) {
        // User rejected: silently reset state
        setTxStatus('idle')
        return
      } else {
        // Signing error: already toasted, but still reset state
        setTxStatus('idle')
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unexpected error'
      setTxStatus('error')
      setTxError(msg)
      toast.error(msg)
    }
  }

  const isPending = txStatus === 'signing' || txStatus === 'submitting' || txStatus === 'confirming'

  if (!wallet && !isRestoringSession) {
    return (
      <div className="card p-10 text-center">
        <p className="text-slate-400">Connect your wallet to deposit tokens.</p>
      </div>
    )
  }

  return (
    <div className="max-w-lg">
      <div className="card p-6">
        <h2 className="font-semibold text-lg mb-1">Lock tokens in a vault</h2>
        <p className="text-sm text-slate-400 mb-6">
          Tokens will be transferred to the contract and locked until your chosen date.
        </p>

        {templates.length > 0 && (
          <div className="mb-6 border-b border-slate-700/60 pb-5">
            <label className="label">Saved templates</label>
            <div className="space-y-2">
              {templates.map((template) => (
                <div key={template.id} className="flex items-center gap-2">
                  <button type="button" onClick={() => handleLoadTemplate(template)} className="btn-secondary text-xs px-3 py-1.5 flex-1 justify-start truncate">
                    {template.name}
                  </button>
                  <button type="button" onClick={() => handleDeleteTemplate(template.id)} className="text-xs text-slate-500 hover:text-red-400 px-2" aria-label={`Delete ${template.name} template`}>
                    Delete
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {contractInfo.paused && (
          <div className="mb-5 p-3 rounded-xl bg-red-900/30 border border-red-700/40 text-red-400 text-sm">
            ⚠️ Contract is currently paused. Deposits are disabled.
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5" noValidate>
          {/* Token */}
          <div>
            <label className="label">Token contract address</label>
            <div className="relative">
              <input
                className={`input ${
                  tokenAddressError
                    ? 'border-red-500 focus:ring-red-500/50 focus:border-red-500'
                    : tokenAddress && isValidContractAddress(tokenAddress) && !decimalsLoading
                      ? 'border-green-500/50 focus:ring-green-500/30 focus:border-green-500'
                      : ''
                }`}
                type="text"
                value={tokenAddress}
                onChange={(e) => setTokenAddress(e.target.value.trim())}
                placeholder="CDLZFC3…"
                disabled={isPending}
              />
              {decimalsLoading && (
                <span className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 text-xs">
                  Verifying…
                </span>
              )}
              {!decimalsLoading && tokenAddress && isValidContractAddress(tokenAddress) && !tokenAddressError && (
                <span className="absolute right-4 top-1/2 -translate-y-1/2 text-green-400 text-xs">
                  ✓
                </span>
              )}
            </div>
            {tokenAddressError ? (
              <p className="text-xs text-red-400 mt-1">{tokenAddressError}</p>
            ) : (
              <p className="text-xs text-slate-500 mt-1">
                {tokenAddress === CONFIG.NATIVE_TOKEN
                  ? 'Native XLM token (7 decimals)'
                  : tokenMetadata
                    ? `${tokenMetadata.symbol} - ${tokenMetadata.name} (${tokenDecimals} decimals)`
                    : `Custom token (${tokenDecimals} decimals${decimalsLoading ? ', verifying…' : ''})`}
              </p>
            )}
          </div>

          {/* Amount */}
          <div>
            <label className="label">Amount</label>
            <div className="relative">
              <input
                className={`input pr-14 ${errors.amount ? 'border-red-500 focus:ring-red-500/50 focus:border-red-500' : ''}`}
                type="number"
                min="0"
                step={`0.${'0'.repeat(Math.max(0, tokenDecimals - 1))}1`}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0"
                disabled={isPending || decimalsLoading}
              />
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-500 text-sm font-medium pointer-events-none">
                {tokenAddress === CONFIG.NATIVE_TOKEN ? 'XLM' : 'tokens'}
              </span>
            </div>
            {errors.amount && <p className="text-xs text-red-400 mt-1">{errors.amount}</p>}
          </div>

          {/* Unlock date */}
          <div>
            <label className="label">
              Unlock date & time
              <span className="ml-1 text-slate-500 normal-case">— {getTimezoneOffsetString()}</span>
            </label>
            <input
              className={`input ${errors.unlock ? 'border-red-500 focus:ring-red-500/50 focus:border-red-500' : ''}`}
              type="datetime-local"
              value={unlockDate}
              onChange={(e) => setUnlockDate(e.target.value)}
              min={getMinDateTimeLocal()}
              disabled={isPending}
            />
            {errors.unlock && <p className="text-xs text-red-400 mt-1">{errors.unlock}</p>}
          </div>

          {/* Penalty BPS */}
          <div>
            <label className="label">
              Early exit penalty (basis points)
              <span className="ml-1 text-slate-500 normal-case">— 0 = no penalty, 10000 = 100%</span>
            </label>
            <div className="relative">
              <input
                className={`input pr-20 ${errors.penalty ? 'border-red-500 focus:ring-red-500/50 focus:border-red-500' : ''}`}
                type="number"
                min="0"
                max="10000"
                step="1"
                value={penaltyBps}
                onChange={(e) => setPenaltyBps(e.target.value)}
                disabled={isPending}
              />
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-500 text-sm pointer-events-none">
                {isNaN(penaltyBpsNum) ? '—' : formatBps(penaltyBpsNum)}
              </span>
            </div>
            {errors.penalty && <p className="text-xs text-red-400 mt-1">{errors.penalty}</p>}
          </div>

          <div className="border-t border-slate-700/60 pt-5">
            <label className="label" htmlFor="template-name">Save current settings as template</label>
            <div className="flex gap-2">
              <input
                id="template-name"
                className="input"
                type="text"
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                placeholder="Monthly savings"
                disabled={isPending}
              />
              <button type="button" onClick={handleSaveTemplate} disabled={!templateName.trim() || !amount || !unlockDate || isPending} className="btn-secondary whitespace-nowrap px-3">
                Save
              </button>
            </div>
          </div>

          {/* Summary */}
          {amount && unlockDate && !errors.amount && !errors.unlock && (
            <div className="bg-slate-800/60 rounded-xl p-4 text-sm space-y-1.5">
              <p className="text-slate-400 text-xs uppercase tracking-wide font-medium mb-2">Summary</p>
              <Row label="Locking" value={`${amount} XLM`} />
              {(() => {
                const ts = formatUnlockTimestampWithTimezone(unlockTimestamp)
                return (
                  <>
                    <Row label="Unlock (local)" value={ts.local} />
                    <Row label="Unlock (UTC)" value={ts.utc} />
                  </>
                )
              })()}
              {penaltyBpsNum > 0 && <Row label="Early exit penalty" value={formatBps(penaltyBpsNum)} accent="orange" />}
            </div>
          )}

          <TxStatusBadge status={txStatus} txHash={txHash} error={txError} />

          <button
            type="submit"
            className="btn-primary w-full"
            disabled={!isValid || isPending}
          >
            {isPending ? (
              <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
              </svg>
            )}
            {isPending ? 'Processing…' : 'Lock Tokens'}
          </button>
        </form>
      </div>
    </div>
  )
}

function Row({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-slate-500">{label}</span>
      <span className={`font-medium ${accent === 'orange' ? 'text-orange-400' : 'text-slate-200'}`}>{value}</span>
    </div>
  )
}
