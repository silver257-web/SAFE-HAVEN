import { useState } from 'react'
import {
  addDays,
  addMonths,
  format,
  fromUnixTime,
  isSameDay,
  isSameMonth,
  isToday,
  startOfMonth,
  startOfWeek,
  subMonths,
} from 'date-fns'
import type { Deposit } from '../types'
import { formatUnlockDate, stroopsToXlm } from '../lib/format'
import { CONFIG } from '../config'

interface DepositCalendarProps {
  deposits: Deposit[]
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function DepositCalendar({ deposits }: DepositCalendarProps) {
  const [visibleMonth, setVisibleMonth] = useState(() => startOfMonth(new Date()))
  const calendarStart = startOfWeek(startOfMonth(visibleMonth))
  const days = Array.from({ length: 42 }, (_, index) => addDays(calendarStart, index))

  function depositsForDay(day: Date) {
    return deposits.filter((deposit) => isSameDay(fromUnixTime(deposit.unlockTime), day))
  }

  return (
    <section className="card p-4 sm:p-5" aria-labelledby="deposit-calendar-heading">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h2 id="deposit-calendar-heading" className="font-semibold text-lg">Unlock calendar</h2>
          <p className="text-xs text-slate-500 mt-1">Your deposits by unlock date</p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setVisibleMonth((month) => subMonths(month, 1))}
            className="btn-secondary w-9 h-9 p-0"
            aria-label="Previous month"
            title="Previous month"
          >
            ‹
          </button>
          <button
            type="button"
            onClick={() => setVisibleMonth(startOfMonth(new Date()))}
            className="btn-secondary text-xs px-3 h-9"
          >
            Today
          </button>
          <button
            type="button"
            onClick={() => setVisibleMonth((month) => addMonths(month, 1))}
            className="btn-secondary w-9 h-9 p-0"
            aria-label="Next month"
            title="Next month"
          >
            ›
          </button>
        </div>
      </div>

      <p className="text-center font-medium text-slate-200 mb-3">{format(visibleMonth, 'MMMM yyyy')}</p>

      <div className="grid grid-cols-7 border-l border-t border-slate-700/60" role="grid" aria-label={format(visibleMonth, 'MMMM yyyy')}>
        {WEEKDAYS.map((weekday) => (
          <div key={weekday} className="border-r border-b border-slate-700/60 py-2 text-center text-[11px] font-medium uppercase tracking-wide text-slate-500" role="columnheader">
            {weekday}
          </div>
        ))}
        {days.map((day) => {
          const dayDeposits = depositsForDay(day)
          const inMonth = isSameMonth(day, visibleMonth)
          return (
            <div
              key={day.toISOString()}
              className={`min-h-24 border-r border-b border-slate-700/60 p-1.5 sm:p-2 ${inMonth ? 'bg-slate-900/30' : 'bg-slate-950/30 text-slate-700'}`}
              role="gridcell"
              aria-label={`${format(day, 'MMMM d, yyyy')}${dayDeposits.length ? `, ${dayDeposits.length} deposit${dayDeposits.length === 1 ? '' : 's'} unlock` : ''}`}
            >
              <div className={`mb-1 flex h-6 w-6 items-center justify-center rounded-full text-xs ${isToday(day) ? 'bg-stellar-600 font-semibold text-white' : inMonth ? 'text-slate-400' : 'text-slate-700'}`}>
                {format(day, 'd')}
              </div>
              <div className="space-y-1">
                {dayDeposits.map((deposit) => {
                  const isUnlocked = deposit.timeRemaining === 0 && deposit.unlockVerified
                  const isXlm = deposit.token === CONFIG.NATIVE_TOKEN
                  return (
                    <div
                      key={deposit.depositId}
                      className={`truncate rounded border px-1.5 py-1 text-[11px] ${isUnlocked ? 'border-green-700/50 bg-green-900/30 text-green-300' : 'border-stellar-700/50 bg-stellar-900/40 text-stellar-300'}`}
                      title={`Deposit #${deposit.depositId} unlocks ${formatUnlockDate(deposit.unlockTime)}`}
                    >
                      <span className="font-medium">#{deposit.depositId}</span> {stroopsToXlm(deposit.amount)} {isXlm ? 'XLM' : 'tokens'}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs text-slate-500">
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-stellar-500" />Locked</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-green-400" />Unlocked</span>
      </div>
    </section>
  )
}