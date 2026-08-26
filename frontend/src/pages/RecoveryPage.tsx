import { useState } from 'react'
import toast from 'react-hot-toast'
import { useWallet } from '../context/WalletContext'
import { buildRecoverAccount, buildRegisterRecoveryContact, submitTx } from '../lib/stellar'
import { isValidStellarAddress } from '../lib/format'

export function RecoveryPage() {
  const { wallet, signTransaction } = useWallet()
  const [contact, setContact] = useState('')
  const [newWallet, setNewWallet] = useState('')
  const [code, setCode] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function registerContact() {
    if (!wallet || !isValidStellarAddress(contact)) return
    setPending(true)
    try {
      const xdr = await buildRegisterRecoveryContact(wallet.address, contact)
      if (!xdr) throw new Error('Failed to build registration transaction')
      const result = await signTransaction(xdr)
      if (!result.signed) return
      const submitted = await submitTx(result.xdr)
      if (!submitted.success) throw new Error(submitted.error ?? 'Registration failed')
      setCode(String(Math.floor(100000 + Math.random() * 900000)))
      toast.success('Recovery wallet registered')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Registration failed')
    } finally {
      setPending(false)
    }
  }

  async function recoverAccount() {
    if (!wallet || !isValidStellarAddress(newWallet)) return
    setPending(true)
    try {
      const xdr = await buildRecoverAccount(wallet.address, newWallet)
      if (!xdr) throw new Error('Failed to build recovery transaction')
      const result = await signTransaction(xdr)
      if (!result.signed) return
      const submitted = await submitTx(result.xdr)
      if (!submitted.success) throw new Error(submitted.error ?? 'Recovery failed')
      toast.success('Account recovered to the new wallet')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Recovery failed')
    } finally {
      setPending(false)
    }
  }

  if (!wallet) return <div className="card p-8 text-center text-slate-400">Connect the wallet you want to protect or use as recovery contact.</div>

  return (
    <div className="max-w-lg card p-6 space-y-7">
      <div>
        <h2 className="text-lg font-semibold">Account recovery</h2>
        <p className="text-sm text-slate-400 mt-1">Register a trusted wallet before you need to recover access.</p>
      </div>

      <section className="space-y-3">
        <h3 className="font-medium">Register recovery wallet</h3>
        <input className="input" value={contact} onChange={(event) => setContact(event.target.value.trim())} placeholder="Recovery wallet address" aria-label="Recovery wallet address" />
        <button type="button" className="btn-primary w-full" onClick={registerContact} disabled={pending || !isValidStellarAddress(contact)}>Register contact</button>
        {code && <p className="rounded-lg border border-green-700/40 bg-green-900/20 p-3 text-sm text-green-300">Verification code: <strong className="font-mono tracking-widest">{code}</strong><br /><span className="text-xs text-green-400/80">Show this code to the recovery wallet owner. The wallet signature remains the on-chain authorization.</span></p>}
      </section>

      <section className="border-t border-slate-700/60 pt-6 space-y-3">
        <h3 className="font-medium">Recover to a new wallet</h3>
        <p className="text-xs text-slate-500">Connect the registered recovery wallet to authorize moving all active vaults.</p>
        <input className="input" value={newWallet} onChange={(event) => setNewWallet(event.target.value.trim())} placeholder="New wallet address" aria-label="New wallet address" />
        <button type="button" className="btn-primary w-full" onClick={recoverAccount} disabled={pending || !isValidStellarAddress(newWallet)}>Recover account</button>
      </section>

      <p className="text-xs leading-relaxed text-slate-500">Email contacts are not supported for fund recovery: this app has no trusted email delivery or signer. Only a pre-authorized Stellar wallet can authorize recovery.</p>
    </div>
  )
}