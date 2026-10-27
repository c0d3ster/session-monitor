export const LIMIT_NAMES: { [kind: string]: string } = { five_hour: '5h limit', seven_day: 'week limit', spend_limit: 'spend limit' }

// What the last scan of every transcript on this machine put each usage window
// at, in dollars at list prices. Worked out by scripts/window-cost.cjs, which
// streams the files, so a transcript over the 4 MiB read limit counts too.
export const PLAN_COST_EVERY_MS = 60 * 1000
export const planCost: { usd: { [kind: string]: number }; at: number; running: boolean; error: string } = { usd: {}, at: 0, running: false, error: '' }
