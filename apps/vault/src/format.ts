export const short = (s: string, head = 6, tail = 4) => (s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s)

export function relative(ms: number, now = Date.now()): string {
  const diff = ms - now
  const abs = Math.abs(diff)
  const unit = abs < 60_000 ? ['second', 1000] : abs < 3_600_000 ? ['minute', 60_000] : abs < 86_400_000 ? ['hour', 3_600_000] : ['day', 86_400_000]
  return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(Math.round(diff / (unit[1] as number)), unit[0] as Intl.RelativeTimeFormatUnit)
}

export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))
