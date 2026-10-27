import { num } from './util'

export function seconds(ms: number): string {
  const secs = Math.max(0, Math.round(num(ms) / 1000))
  if (secs < 60) return secs + 's'
  return Math.floor(secs / 60) + 'm' + String(secs % 60).padStart(2, '0') + 's'
}

// 1234 -> 1.2k, 56789 -> 57k, 1234567 -> 1.2M; anything unusable -> a dash
export function fmt(n: number): string {
  if (typeof n !== 'number' || !isFinite(n)) return '–'
  if (n < 1000) return String(Math.round(n))
  if (n < 10000) return (n / 1000).toFixed(1) + 'k'
  if (n < 1000000) return Math.round(n / 1000) + 'k'
  return (n / 1000000).toFixed(1) + 'M'
}

// "in 12k · out 3.1k · total 15k", or dashes while nothing has been reported
export function tokenLine(tokIn: number, tokOut: number): string {
  const i = num(tokIn)
  const o = num(tokOut)
  if (i + o === 0) return 'in – · out – · total –'
  return 'in ' + fmt(i) + ' · out ' + fmt(o) + ' · total ' + fmt(i + o)
}

export function money(usd: number): string {
  return '$' + (usd < 10 ? usd.toFixed(2) : usd.toFixed(1))
}

export function cut(text: string, width: number): string {
  if (width <= 1) return ''
  return text.length <= width ? text : text.slice(0, width - 1) + '…'
}

export function two(n: number): string {
  return n < 10 ? '0' + n : String(n)
}

export const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// Time left until a moment, as short as it can be: 2d3h, 1h42m, 7m
export function untilText(ms: number): string {
  const mins = Math.max(0, Math.round(num(ms) / 60000))
  if (mins >= 1440) return Math.floor(mins / 1440) + 'd' + Math.floor((mins % 1440) / 60) + 'h'
  if (mins >= 60) return Math.floor(mins / 60) + 'h' + two(mins % 60) + 'm'
  return mins + 'm'
}

// The local clock time of a moment: 6:30am, and the weekday when it is not today
export function clockText(at: number): string {
  const d = new Date(at)
  const h = d.getHours()
  const time = (h % 12 === 0 ? 12 : h % 12) + ':' + two(d.getMinutes()) + (h < 12 ? 'am' : 'pm')
  return d.toDateString() === new Date().toDateString() ? time : DAYS[d.getDay()] + ' ' + time
}

// 14:05
export function clock(ms: number): string {
  const d = new Date(ms)
  return two(d.getHours()) + ':' + two(d.getMinutes())
}

// 20261007-140532, for file names
export function fileStamp(ms: number): string {
  const d = new Date(ms)
  return (
    String(d.getFullYear()) +
    two(d.getMonth() + 1) +
    two(d.getDate()) +
    '-' +
    two(d.getHours()) +
    two(d.getMinutes()) +
    two(d.getSeconds())
  )
}

export function bar(percent: number, width: number): { filled: string; empty: string } {
  const n = Math.max(0, Math.min(width, Math.round((num(percent) / 100) * width)))
  return { filled: '█'.repeat(n), empty: '░'.repeat(width - n) }
}

export function costText(usd: number | undefined): string {
  return usd === undefined ? '–' : '~' + money(usd)
}
