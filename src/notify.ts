/** The learner's local calendar date, YYYY-MM-DD. */
export const localDate = (now: Date) => now.toLocaleDateString("sv")

/** Whether to send today's "cards are due" notification. */
export function shouldNotify(input: { due: number; last: string; today: string; enabled: boolean; reviewing: boolean }) {
  return input.enabled && input.due > 0 && input.last !== input.today && !input.reviewing
}

/**
 * Whether the day counts as notified after an attempt. A notification skipped because the terminal is focused (or
 * the host does not know the focus) is not counted, so a later check the same day tries again.
 */
export function countsAsNotified(result: { notification: boolean; skipped?: string }) {
  return result.notification
}
