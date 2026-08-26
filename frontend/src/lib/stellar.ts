// ============================================================
//  Stellar / Soroban contract interaction helpers
// ============================================================

import {
  Contract,
  Networks,
  rpc as StellarRpc,
  TransactionBuilder,
  BASE_FEE,
  xdr,
  Address,
  nativeToScVal,
  scValToNative,
  type SorobanDataBuilder,
} from '@stellar/stellar-sdk'
import { CONFIG } from '../config'
import type { VaultEntry, ContractResult, InsurancePool } from '../types'

// ----------------------------------------------------------------
//  RPC client (singleton)
// ----------------------------------------------------------------

let _rpc: StellarRpc.Server | null = null

export function getRpc(): StellarRpc.Server {
  if (!_rpc) {
    _rpc = new StellarRpc.Server(CONFIG.RPC_URL, { allowHttp: CONFIG.RPC_URL.startsWith('http://') })
  }
  return _rpc
}

// ----------------------------------------------------------------
//  Address helpers
// ----------------------------------------------------------------

export function shortAddress(addr: string): string {
  if (addr.length < 12) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

// ----------------------------------------------------------------
//  scVal parsing helpers
// ----------------------------------------------------------------

function parseVaultEntry(scVal: xdr.ScVal): VaultEntry | null {
  try {
    const raw = scValToNative(scVal) as Record<string, unknown>
    return {
      token:      raw['token']       as string,
      amount:     BigInt(raw['amount'] as string | number),
      unlockTime: Number(raw['unlock_time']),
      depositor:  raw['depositor']   as string,
      penaltyBps: Number(raw['penalty_bps']),
    }
  } catch {
    return null
  }
}

// ----------------------------------------------------------------
//  Read-only contract queries (no signing needed)
// ----------------------------------------------------------------

/**
 * Source account for simulation transactions.
 *
 * Priority:
 *  1. Connected wallet address passed in (best – always exists on-chain)
 *  2. VITE_SIMULATION_ACCOUNT env var (operator-configured per-network)
 *  3. The contract ID itself as a last-resort fallback (Soroban simulation
 *     does not validate the source account's on-chain existence for read-only
 *     calls, so this works even when the account isn't funded)
 */
function getSimulationAccount(): string {
  return (import.meta.env.VITE_SIMULATION_ACCOUNT as string | undefined) ?? CONFIG.CONTRACT_ID
}

async function simulateReadOnly<T>(
  method: string,
  args: xdr.ScVal[],
  parser: (v: xdr.ScVal) => T,
  /** Optional connected wallet address — used as the source account when provided */
  walletAddress?: string,
): Promise<T | null> {
  try {
    const rpc = getRpc()
    const contract = new Contract(CONFIG.CONTRACT_ID)

    // Resolve the source account: wallet > env config > contract ID as fallback
    const sourceAddress = walletAddress ?? getSimulationAccount()

    let account: Awaited<ReturnType<typeof rpc.getAccount>>
    try {
      account = await rpc.getAccount(sourceAddress)
    } catch {
      // Account not found on-chain — build a minimal synthetic account.
      // Soroban ignores the sequence number for read-only simulations.
      const { Account } = await import('@stellar/stellar-sdk')
      account = new Account(sourceAddress, '0') as unknown as Awaited<ReturnType<typeof rpc.getAccount>>
    }

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: CONFIG.NETWORK_PASSPHRASE,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(30)
      .build()

    const result = await rpc.simulateTransaction(tx)
    if (StellarRpc.Api.isSimulationError(result)) {
      console.error('Simulation error:', result.error)
      return null
    }
    if (!result.result) return null
    return parser(result.result.retval)
  } catch (e) {
    console.error(`simulateReadOnly(${method}) failed:`, e)
    return null
  }
}

/** Fetch a single vault entry */
export async function getVault(depositor: string, depositId: number): Promise<VaultEntry | null> {
  return simulateReadOnly(
    'get_vault',
    [
      new Address(depositor).toScVal(),
      nativeToScVal(depositId, { type: 'u32' }),
    ],
    (v) => {
      if (v.switch() === xdr.ScValType.scvVoid()) return null
      return parseVaultEntry(v)
    },
  )
}

/** Fetch multiple deposits for a single depositor in one RPC call (batch fetch) */
export async function getDepositBatch(
  depositor: string,
  depositIds: number[],
): Promise<{ id: number; entry: VaultEntry | null }[]> {
  return simulateReadOnly(
    'get_deposit_batch',
    [
      new Address(depositor).toScVal(),
      nativeToScVal(depositIds, { type: 'Vec<u32>' }),
    ],
    (v) => {
      const result = scValToNative(v) as Array<Record<string, unknown>>
      return result.map((item) => {
        const id = Number(item[0] ?? item.id ?? 0) as number
        const entryRaw = item[1] ?? item.entry
        let entry: VaultEntry | null = null
        if (entryRaw) {
          try {
            const raw = entryRaw as Record<string, unknown>
            entry = {
              token: raw['token'] as string,
              amount: BigInt(raw['amount'] as string | number),
              unlockTime: Number(raw['unlock_time']),
              depositor: raw['depositor'] as string,
              penaltyBps: Number(raw['penalty_bps']),
            }
          } catch {
            entry = null
          }
        }
        return { id, entry }
      })
    },
  ).then((result) => result ?? [])
}

/** Fetch all deposit IDs for an address */
export async function getDepositIds(depositor: string): Promise<number[]> {
  const result = await simulateReadOnly(
    'get_deposit_ids',
    [new Address(depositor).toScVal()],
    (v) => scValToNative(v) as number[],
  )
  return result ?? []
}

/** Fetch time remaining in seconds */
export async function getTimeRemaining(depositor: string, depositId: number): Promise<number> {
  const result = await simulateReadOnly(
    'time_remaining',
    [
      new Address(depositor).toScVal(),
      nativeToScVal(depositId, { type: 'u32' }),
    ],
    (v) => Number(scValToNative(v)),
  )
  return result ?? 0
}

/** Fetch current ledger time */
export async function getLedgerTime(): Promise<number> {
  const result = await simulateReadOnly(
    'get_time',
    [],
    (v) => Number(scValToNative(v)),
  )
  return result ?? Math.floor(Date.now() / 1000)
}

/** Fetch contract version */
export async function getContractVersion(): Promise<string> {
  const result = await simulateReadOnly(
    'version',
    [],
    (v) => scValToNative(v) as string,
  )
  return result ?? 'unknown'
}

/** Fetch admin address */
export async function getAdmin(): Promise<string | null> {
  const result = await simulateReadOnly(
    'get_admin',
    [],
    (v) => {
      if (v.switch() === xdr.ScValType.scvVoid()) return null
      return scValToNative(v) as string
    },
  )
  return result ?? null
}

/** Check if contract is paused */
export async function isPaused(): Promise<boolean> {
  const result = await simulateReadOnly(
    'is_paused',
    [],
    (v) => scValToNative(v) as boolean,
  )
  return result ?? false
}

/** Fetch fee recipient */
export async function getFeeRecipient(): Promise<string | null> {
  const result = await simulateReadOnly(
    'get_fee_recipient',
    [],
    (v) => {
      if (v.switch() === xdr.ScValType.scvVoid()) return null
      return scValToNative(v) as string
    },
  )
  return result ?? null
}

/** Fetch the configured insurance pool and its current token reserve. */
export async function getInsurancePool(): Promise<InsurancePool | null> {
  return simulateReadOnly(
    'get_insurance_pool',
    [],
    (v) => {
      if (v.switch() === xdr.ScValType.scvVoid()) return null
      const raw = scValToNative(v) as Record<string, unknown> | null
      if (!raw) return null
      return {
        enabled: Boolean(raw['enabled']),
        token: raw['token'] as string,
        coverageBps: Number(raw['coverage_bps']),
        maxCoverage: BigInt(raw['max_coverage'] as string | number | bigint),
        reserve: BigInt(raw['reserve'] as string | number | bigint),
      }
    },
  )
}

/** Fetch contract constants */
export async function getConstants(): Promise<{ maxDeposit: bigint; maxLockSecs: number } | null> {
  return simulateReadOnly(
    'get_constants',
    [],
    (v) => {
      const [maxDeposit, maxLockSecs] = scValToNative(v) as [string, string]
      return { maxDeposit: BigInt(maxDeposit), maxLockSecs: Number(maxLockSecs) }
    },
  )
}

/** Fetch depositor count */
export async function getDepositorCount(): Promise<number> {
  const result = await simulateReadOnly(
    'get_depositor_count',
    [],
    (v) => Number(scValToNative(v)),
  )
  return result ?? 0
}

// ----------------------------------------------------------------
//  Transaction building helpers (for wallet signing)
// ----------------------------------------------------------------

/**
 * Build an unsigned transaction for a mutating contract call.
 * The caller must sign it with their wallet, then submit via submitTx().
 */
export async function buildTx(
  callerAddress: string,
  method: string,
  args: xdr.ScVal[],
): Promise<string | null> {
  try {
    const rpc = getRpc()
    const contract = new Contract(CONFIG.CONTRACT_ID)
    const account = await rpc.getAccount(callerAddress)

    const tx = new TransactionBuilder(account, {
      fee: (Number(BASE_FEE) * 10).toString(), // bump fee for Soroban
      networkPassphrase: CONFIG.NETWORK_PASSPHRASE,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(300)
      .build()

    // Simulate to get resource requirements
    const sim = await rpc.simulateTransaction(tx)
    if (StellarRpc.Api.isSimulationError(sim)) {
      console.error('Simulation error:', sim.error)
      return null
    }

    // Assemble with proper resource data
    const assembled = StellarRpc.assembleTransaction(tx, sim).build()
    return assembled.toXDR()
  } catch (e) {
    console.error(`buildTx(${method}) failed:`, e)
    return null
  }
}

/** Submit a signed transaction XDR and wait for confirmation */
export async function submitTx(signedXdr: string): Promise<ContractResult<string>> {
  try {
    const rpc = getRpc()
    const tx = TransactionBuilder.fromXDR(signedXdr, CONFIG.NETWORK_PASSPHRASE)
    const response = await rpc.sendTransaction(tx)

    if (response.status === 'ERROR') {
      return { success: false, error: response.errorResult?.toXDR('base64') ?? 'Transaction failed' }
    }

    // Poll for confirmation
    let attempts = 0
    while (attempts < 30) {
      await new Promise((r) => setTimeout(r, 2000))
      const status = await rpc.getTransaction(response.hash)
      if (status.status === StellarRpc.Api.GetTransactionStatus.SUCCESS) {
        return { success: true, txHash: response.hash }
      }
      if (status.status === StellarRpc.Api.GetTransactionStatus.FAILED) {
        return { success: false, error: 'Transaction failed on-chain', txHash: response.hash }
      }
      attempts++
    }
    return { success: false, error: 'Transaction confirmation timeout', txHash: response.hash }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { success: false, error: msg }
  }
}

// ----------------------------------------------------------------
//  Contract call builders (return unsigned XDR)
// ----------------------------------------------------------------

export async function buildDeposit(
  depositor: string,
  tokenAddress: string,
  amount: bigint,
  unlockTime: number,
  penaltyBps: number,
): Promise<string | null> {
  return buildTx(depositor, 'deposit', [
    new Address(depositor).toScVal(),
    new Address(tokenAddress).toScVal(),
    nativeToScVal(amount, { type: 'i128' }),
    nativeToScVal(unlockTime, { type: 'u64' }),
    nativeToScVal(penaltyBps, { type: 'u32' }),
  ])
}

export async function buildRegisterRecoveryContact(depositor: string, recoveryContact: string): Promise<string | null> {
  return buildTx(depositor, 'register_recovery_contact', [
    new Address(depositor).toScVal(),
    new Address(recoveryContact).toScVal(),
  ])
}

export async function buildRecoverAccount(recoveryContact: string, newWallet: string): Promise<string | null> {
  return buildTx(recoveryContact, 'recover_account', [
    new Address(recoveryContact).toScVal(),
    new Address(newWallet).toScVal(),
  ])
}

export async function buildWithdraw(
  depositor: string,
  depositId: number,
): Promise<string | null> {
  return buildTx(depositor, 'withdraw', [
    new Address(depositor).toScVal(),
    nativeToScVal(depositId, { type: 'u32' }),
  ])
}

export async function buildCancelDeposit(
  depositor: string,
  depositId: number,
): Promise<string | null> {
  return buildTx(depositor, 'cancel_deposit', [
    new Address(depositor).toScVal(),
    nativeToScVal(depositId, { type: 'u32' }),
  ])
}

export async function buildPause(admin: string): Promise<string | null> {
  return buildTx(admin, 'pause', [new Address(admin).toScVal()])
}

export async function buildUnpause(admin: string): Promise<string | null> {
  return buildTx(admin, 'unpause', [new Address(admin).toScVal()])
}

export async function buildEmergencyWithdraw(
  admin: string,
  depositor: string,
  depositId: number,
): Promise<string | null> {
  return buildTx(admin, 'emergency_withdraw', [
    new Address(admin).toScVal(),
    new Address(depositor).toScVal(),
    nativeToScVal(depositId, { type: 'u32' }),
  ])
}

export async function buildTransferAdmin(
  admin: string,
  newAdmin: string,
): Promise<string | null> {
  return buildTx(admin, 'transfer_admin', [
    new Address(admin).toScVal(),
    new Address(newAdmin).toScVal(),
  ])
}

export async function buildAcceptAdmin(
  newAdmin: string,
): Promise<string | null> {
  return buildTx(newAdmin, 'accept_admin', [
    new Address(newAdmin).toScVal(),
  ])
}

export async function buildCancelTransferAdmin(
  admin: string,
): Promise<string | null> {
  return buildTx(admin, 'cancel_transfer_admin', [
    new Address(admin).toScVal(),
  ])
}

export async function buildRenounceAdmin(
  admin: string,
): Promise<string | null> {
  return buildTx(admin, 'renounce_admin', [
    new Address(admin).toScVal(),
  ])
}

/** Fetch pending admin address */
export async function getPendingAdmin(): Promise<string | null> {
  const result = await simulateReadOnly(
    'get_pending_admin',
    [],
    (v) => {
      if (v.switch() === xdr.ScValType.scvVoid()) return null
      return scValToNative(v) as string
    },
  )
  return result ?? null
}

// ----------------------------------------------------------------
//  Token utilities
// ----------------------------------------------------------------

/**
 * Fetch the decimal precision of a Stellar token.
 *
 * For native XLM, returns 7 (hardcoded, as native.decimals() is not callable).
 * For other tokens (SAC tokens), calls the contract's decimals() method.
 *
 * @param tokenAddress - Stellar token contract address
 * @returns Number of decimal places, or null if fetch fails
 */
export async function getTokenDecimals(tokenAddress: string): Promise<number | null> {
  // XLM always has 7 decimals (Stellar standard for native token)
  if (tokenAddress === CONFIG.NATIVE_TOKEN) {
    return 7
  }

  try {
    const rpc = getRpc()
    const contract = new Contract(tokenAddress)

    // Create a minimal synthetic account for read-only simulation
    const sourceAddress = CONFIG.CONTRACT_ID
    const { Account } = await import('@stellar/stellar-sdk')
    const account = new Account(sourceAddress, '0') as unknown as Awaited<ReturnType<typeof rpc.getAccount>>

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: CONFIG.NETWORK_PASSPHRASE,
    })
      .addOperation(contract.call('decimals'))
      .setTimeout(30)
      .build()

    const result = await rpc.simulateTransaction(tx)
    if (StellarRpc.Api.isSimulationError(result)) {
      console.warn(`Failed to fetch decimals for ${tokenAddress}: simulation error`)
      return null
    }
    if (!result.result) return null

    const decimals = Number(scValToNative(result.result.retval))
    return decimals
  } catch (e) {
    console.warn(`Failed to fetch decimals for ${tokenAddress}:`, e)
    return null
  }
}

/**
 * Fetch token metadata: name and symbol.
 * Works for SAC tokens that implement SEP-41 metadata.
 *
 * @param tokenAddress - Stellar token contract address
 * @returns object with name and symbol, or null if fetch fails
 */
export async function getTokenMetadata(
  tokenAddress: string,
): Promise<{ name: string; symbol: string } | null> {
  // Native XLM metadata is well-known
  if (tokenAddress === CONFIG.NATIVE_TOKEN) {
    return { name: 'Stellar Lumens', symbol: 'XLM' }
  }

  try {
    const rpc = getRpc()
    const contract = new Contract(tokenAddress)

    const sourceAddress = CONFIG.CONTRACT_ID
    const { Account } = await import('@stellar/stellar-sdk')
    const account = new Account(sourceAddress, '0') as unknown as Awaited<ReturnType<typeof rpc.getAccount>>

    // Try to fetch name
    const nameTx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: CONFIG.NETWORK_PASSPHRASE,
    })
      .addOperation(contract.call('name'))
      .setTimeout(30)
      .build()

    const nameResult = await rpc.simulateTransaction(nameTx)
    const name =
      !StellarRpc.Api.isSimulationError(nameResult) && nameResult.result
        ? String(scValToNative(nameResult.result.retval))
        : 'Unknown Token'

    // Try to fetch symbol
    const symbolTx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: CONFIG.NETWORK_PASSPHRASE,
    })
      .addOperation(contract.call('symbol'))
      .setTimeout(30)
      .build()

    const symbolResult = await rpc.simulateTransaction(symbolTx)
    const symbol =
      !StellarRpc.Api.isSimulationError(symbolResult) && symbolResult.result
        ? String(scValToNative(symbolResult.result.retval))
        : 'UNKNOWN'

    return { name, symbol }
  } catch (e) {
    console.warn(`Failed to fetch token metadata for ${tokenAddress}:`, e)
    return null
  }
}
