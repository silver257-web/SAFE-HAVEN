import { useEffect, useState } from 'react'
import { getInsurancePool } from '../lib/stellar'
import type { InsurancePool } from '../types'

export function useInsurancePool(): InsurancePool | null {
  const [pool, setPool] = useState<InsurancePool | null>(null)

  useEffect(() => {
    let active = true
    void getInsurancePool().then((result) => {
      if (active) setPool(result)
    })
    return () => {
      active = false
    }
  }, [])

  return pool
}