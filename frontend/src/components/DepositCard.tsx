import { useState } from 'react'
import type { Deposit } from '../types'
import type { InsurancePool } from '../types'
import { stroopsToXlm, formatUnlockDate, formatCountdown, formatBps, shortAddr, explorerAddrUrl } from '../lib/format'
import { CONFIG } from '../config'

interface DepositCardProps {
  deposit: Deposit
  onWithdraw: (depositId: number) => void
  onCancel: (depositId: number) => void
  txPending: boolean
  insurancePool: InsurancePool | null
}

export function DepositCard({ deposit, onWithdraw, onCancel, txPending, insurancePool }: DepositCardProps) {
  const [showDetails, setShowDetails] = useState(false)

  const isXlm   = deposit.token === CONFIG.NATIVE_TOKEN
  const isUnlocked = deposit.timeRemaining !== null && deposit.timeRemaining === 0 && deposit.unlockVerified
  const isPendingVerification = deposit.timeRemaining === 0 && !deposit.unlockVerified
  const hasPenalty = deposit.penaltyBps > 0
  const isInsured = !!insurancePool?.enabled && insurancePool.token === deposit.token && insurancePool.reserve > 0n
  const coverageBps = isInsured ? insurancePool.coverageBps : 0
  const coverageLimit = isInsured
    ? [deposit.amount * BigInt(coverageBps) / 10_000n, insurancePool.maxCoverage, insurancePool.reserve].reduce((lowest, value) => value < lowest ? value : lowest)
    : 0n
  const formattedCoverageLimit = isXlm ? stroopsToXlm(coverageLimit) : coverageLimit.toString()

  const penaltyAmount = isUnlocked
    ? 0n
    : (deposit.amount * BigInt(deposit.penaltyBps)) / 10_000n

  const refundAmount = deposit.amount - penaltyAmount

  return (
    <div className="card p-5 hover:border-slate-600/80 transition-colors">
      {/* Top row */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          {/* Token icon placeholder */}
          <div className="w-10 h-10 rounded-full bg-stellar-900/60 border border-stellar-700/40 flex items-center justify-center flex-shrink-0 text-stellar-400 font-bold text-sm">
            {isXlm ? 'XLM' : '?'}
          </div>
          <div className="min-w-0">
            <p className="font-semibold text-base">{stroopsToXlm(deposit.amount)} {isXlm ? 'XLM' : 'tokens'}</p>
            <p className="text-xs text-slate-400 truncate">Deposit #{deposit.depositId}</p>
          </div>
        </div>

        {/* Status badge */}
        {isUnlocked ? (
          <span className="badge-green flex-shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
            Unlocked
          </span>
        ) : isPendingVerification ? (
          <span className="badge-yellow flex-shrink-0">
            <span className="w-3 h-3 border-2 border-yellow-400/40 border-t-yellow-400 rounded-full animate-spin" />
            Verifying…
          </span>
        ) : (
          <span className="badge-yellow flex-shrink-0 countdown-active">
            <span className="w-1.5 h-1.5 rounded-full bg-yellow-400" />
            {formatCountdown(deposit.timeRemaining)}
          </span>
        )}
      </div>

      {/* Unlock date */}
      <div className="mt-3 text-sm text-slate-400">
        {isUnlocked ? (
          <span className="text-green-400">Ready to withdraw</span>
        ) : isPendingVerification ? (
          <span className="text-yellow-400/80">Confirming unlock on-chain…</span>
        ) : (
          <>Unlocks <span className="text-slate-200">{formatUnlockDate(deposit.unlockTime)}</span></>
        )}
      </div>

      {/* Penalty info (if any) */}
      {hasPenalty && !isUnlocked && (
        <div className="mt-2 text-xs text-orange-400 bg-orange-900/20 rounded-lg px-3 py-2 border border-orange-800/30">
          Early exit penalty: {formatBps(deposit.penaltyBps)} — you'd receive ~{stroopsToXlm(refundAmount)} {isXlm ? 'XLM' : 'tokens'}
        </div>
      )}

      <div className={`mt-2 rounded-lg px-3 py-2 text-xs border ${isInsured ? 'border-green-700/40 bg-green-900/20 text-green-300' : 'border-slate-700/60 bg-slate-800/30 text-slate-500'}`}>
        {isInsured
          ? `${(coverageBps / 100).toFixed(2)}% covered up to ${formattedCoverageLimit} ${isXlm ? 'XLM' : 'base units'}`
          : 'Insurance unavailable for this deposit'}
      </div>

      {/* Expandable details */}
      {showDetails && (
        <div className="mt-4 pt-4 border-t border-slate-700/60 grid grid-cols-2 gap-y-2 gap-x-4 text-xs">
          <span className="text-slate-500">Token</span>
          <a
            href={explorerAddrUrl(deposit.token)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-stellar-400 hover:text-stellar-300 font-mono truncate"
          >
            {shortAddr(deposit.token)}
          </a>
          <span className="text-slate-500">Depositor</span>
          <a
            href={explorerAddrUrl(deposit.depositor)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-stellar-400 hover:text-stellar-300 font-mono truncate"
          >
            {shortAddr(deposit.depositor)}
          </a>
          <span className="text-slate-500">Penalty BPS</span>
          <span className="text-slate-300">{deposit.penaltyBps} ({formatBps(deposit.penaltyBps)})</span>
          <span className="text-slate-500">Unlock time</span>
          <span className="text-slate-300 font-mono">{deposit.unlockTime}</span>
        </div>
      )}

      {/* Actions */}
      <div className="mt-4 flex items-center gap-2 flex-wrap">
        {isUnlocked ? (
          <button
            className="btn-primary flex-1"
            onClick={() => onWithdraw(deposit.depositId)}
            disabled={txPending}
          >
            {txPending ? (
              <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                <path fillRule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
            )}
            Withdraw
          </button>
        ) : isPendingVerification ? (
          // Chain confirmation in-flight — disabled button keeps layout stable.
          <button className="btn-primary flex-1" disabled>
            <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            Verifying unlock…
          </button>
        ) : (
          <button
            className={hasPenalty ? 'btn-danger flex-1' : 'btn-secondary flex-1'}
            onClick={() => onCancel(deposit.depositId)}
            disabled={txPending}
          >
            Cancel {hasPenalty ? `(${formatBps(deposit.penaltyBps)} penalty)` : ''}
          </button>
        )}

        <button
          className="btn-secondary text-xs px-3"
          onClick={() => setShowDetails((v) => !v)}
        >
          {showDetails ? 'Less' : 'Details'}
        </button>
      </div>
    </div>
  )
}
