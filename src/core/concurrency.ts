/**
 * Shared concurrency primitives used by profiler and bench orchestrator.
 */

import { createLogger } from "./logger.ts"

const log = createLogger("scheduler")

/**
 * Generic async pool: acquire / release with waiters queue.
 * Bounds concurrency by limiting how many items can be checked out simultaneously.
 */
export class Pool<T> {
  private available: T[]
  private waiters: ((item: T) => void)[] = []

  constructor(items: T[]) { this.available = [...items] }

  acquire(): Promise<T> {
    const item = this.available.pop()
    if (item !== undefined) return Promise.resolve(item)
    return new Promise(resolve => this.waiters.push(resolve))
  }

  release(item: T): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter(item)
    else this.available.push(item)
  }
}

/**
 * Build an N-slot `Pool<number>` for use as a plain counting semaphore,
 * where slot identity does not matter — callers only need a bound on how
 * many concurrent acquires may hold a slot at once.
 */
export function createSlotPool(n: number): Pool<number> {
  return new Pool(Array.from({ length: n }, (_, i) => i))
}

/**
 * Async mutex: serializes async operations so they execute one at a time.
 * Returns a `withLock` function that queues callers.
 */
export function createAsyncMutex() {
  let lock: Promise<void> = Promise.resolve()
  return function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = lock
    let resolve: () => void
    lock = new Promise<void>((r) => { resolve = r })
    return prev.then(fn).finally(() => resolve!())
  }
}

// ---------------------------------------------------------------------------
// Hierarchical Scheduler
// ---------------------------------------------------------------------------

/**
 * Work item tagged with adapter + model for hierarchical scheduling.
 */
export interface WorkItem<T> {
  adapter: string
  model: string
  payload: T
}

/**
 * Runner handle returned by createRunner. The scheduler calls teardown()
 * when it's done with the runner (optional cleanup).
 */
export interface RunnerHandle {
  teardown?: () => Promise<void>
}

export interface SchedulerOpts<T, R extends RunnerHandle = RunnerHandle> {
  /** Total concurrency slots */
  concurrency: number
  /** All work items (will be grouped by adapter then model internally) */
  items: WorkItem<T>[]
  /** Create a runner (e.g. adapter instance) for a given (adapter, model) combo */
  createRunner: (adapter: string, model: string) => Promise<R>
  /** Execute a single work item using its runner */
  execute: (runner: R, item: WorkItem<T>) => Promise<void>
  /** Optional callback when a work item completes (for progress reporting) */
  onComplete?: (item: WorkItem<T>) => void
  /**
   * Optional callback when a work item fails (item continues to next).
   * Called for execute failures AND for every item of a queue whose runner
   * could not be created. Awaited by the scheduler, so it may persist
   * failure records asynchronously. Without it, failures rethrow (fail-fast).
   * A throwing/rejecting onError rejects the whole run.
   */
  onError?: (item: WorkItem<T>, error: unknown) => void | Promise<void>
}

/**
 * Internal: groups work items by adapter, with ordered model sub-queues.
 */
interface AdapterGroup<T> {
  adapter: string
  modelQueues: Array<{
    model: string
    queue: WorkItem<T>[]
  }>
}

/**
 * Build adapter groups from flat work items. Preserves insertion order for
 * both adapters and models (first-occurrence ordering).
 */
function buildAdapterGroups<T>(items: WorkItem<T>[]): AdapterGroup<T>[] {
  const adapterMap = new Map<string, Map<string, WorkItem<T>[]>>()
  const adapterOrder: string[] = []

  for (const item of items) {
    let modelMap = adapterMap.get(item.adapter)
    if (!modelMap) {
      modelMap = new Map()
      adapterMap.set(item.adapter, modelMap)
      adapterOrder.push(item.adapter)
    }
    let queue = modelMap.get(item.model)
    if (!queue) {
      queue = []
      modelMap.set(item.model, queue)
    }
    queue.push(item)
  }

  return adapterOrder.map((adapter) => {
    const modelMap = adapterMap.get(adapter)!
    return {
      adapter,
      modelQueues: [...modelMap.entries()].map(([model, queue]) => ({ model, queue })),
    }
  })
}

/** Find the model queue with the most remaining items in a group. */
function modelQueueWithMostRemaining<T>(
  group: AdapterGroup<T>,
): { model: string; queue: WorkItem<T>[] } | undefined {
  let best: { model: string; queue: WorkItem<T>[] } | undefined
  let bestCount = 0
  for (const mq of group.modelQueues) {
    if (mq.queue.length > bestCount) {
      bestCount = mq.queue.length
      best = mq
    }
  }
  return best
}

/** Count total remaining items across all model queues. */
function remainingItems<T>(group: AdapterGroup<T>): number {
  let count = 0
  for (const mq of group.modelQueues) count += mq.queue.length
  return count
}

/** Find the adapter group with the most remaining tasks. */
function groupWithMostRemaining<T>(groups: AdapterGroup<T>[]): AdapterGroup<T> | undefined {
  let best: AdapterGroup<T> | undefined
  let bestCount = 0
  for (const g of groups) {
    const count = remainingItems(g)
    if (count > bestCount) {
      bestCount = count
      best = g
    }
  }
  return best
}

/**
 * Hierarchical scheduler: adapter → model → tasks (all levels parallel).
 *
 * Scheduling rules:
 * 1. Workers are distributed across adapter groups (L1: adapter-level).
 * 2. Within an adapter group, workers are further distributed across model
 *    queues (L2: model-level). Models run in parallel.
 * 3. Within a model queue, multiple workers drain tasks concurrently
 *    (L3: task-level).
 * 4. When a model queue is drained, its workers steal to the model queue
 *    with the most remaining tasks in the same adapter group (intra-group).
 * 5. When an adapter group is fully drained, its workers steal to the adapter
 *    group with the most remaining tasks (cross-group).
 */
export async function runScheduled<T, R extends RunnerHandle = RunnerHandle>(
  opts: SchedulerOpts<T, R>,
): Promise<void> {
  const { concurrency, items, createRunner, execute, onComplete, onError } = opts
  if (items.length === 0) return

  const groups = buildAdapterGroups(items)
  const totalSlots = Math.min(concurrency, items.length)
  const adapterSlots = distributeSlots(totalSlots, groups.length)

  const workers: Promise<void>[] = []
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi]!
    const groupSlots = adapterSlots[gi]!
    // L2: distribute adapter slots across model queues within this group
    const modelSlots = distributeSlots(groupSlots, group.modelQueues.length)
    for (let mi = 0; mi < group.modelQueues.length; mi++) {
      const mSlots = modelSlots[mi]!
      for (let s = 0; s < mSlots; s++) {
        workers.push(schedulerWorker(group, mi, groups, createRunner, execute, onComplete, onError))
      }
    }
  }

  await Promise.all(workers)
}

async function schedulerWorker<T, R extends RunnerHandle>(
  initialGroup: AdapterGroup<T>,
  initialModelIndex: number,
  allGroups: AdapterGroup<T>[],
  createRunner: (adapter: string, model: string) => Promise<R>,
  execute: (runner: R, item: WorkItem<T>) => Promise<void>,
  onComplete?: (item: WorkItem<T>) => void,
  onError?: (item: WorkItem<T>, error: unknown) => void | Promise<void>,
): Promise<void> {
  let currentGroup = initialGroup
  let runner: R | null = null
  let runnerAdapter = ""
  let runnerModel = ""

  // Cleanup failure must not kill scheduling or detach this worker — the
  // runner is being discarded anyway, so warn and continue (#86).
  const discardRunner = async () => {
    if (!runner) return
    try {
      await runner.teardown?.()
    } catch (err) {
      log.warn(`runner teardown failed for ${runnerAdapter}/${runnerModel} (discarding anyway): ${err}`)
    }
    runner = null
  }

  // Start with assigned model queue
  let mq: { model: string; queue: WorkItem<T>[] } | undefined =
    currentGroup.modelQueues[initialModelIndex]

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // If current model queue is empty, intra-group steal (busiest model queue)
    if (!mq || mq.queue.length === 0) {
      mq = modelQueueWithMostRemaining(currentGroup)
    }

    if (!mq) {
      // Adapter group fully drained — cross-group steal
      await discardRunner()
      const target = groupWithMostRemaining(allGroups)
      if (!target) break // all work done
      currentGroup = target
      mq = modelQueueWithMostRemaining(currentGroup)
      if (!mq) break
    }

    // Create or switch runner if adapter/model changed
    if (!runner || runnerAdapter !== currentGroup.adapter || runnerModel !== mq.model) {
      await discardRunner()
      try {
        runner = await createRunner(currentGroup.adapter, mq.model)
      } catch (err) {
        if (!onError) throw err // fail-fast contract preserved for callers without onError
        // Runner creation failed — this queue cannot execute at all. Drain it,
        // reporting each remaining item as failed, then steal other work.
        // Sibling workers and queues are unaffected (#86).
        runner = null
        runnerAdapter = ""
        runnerModel = ""
        // Another worker hitting the same failure may drain concurrently while
        // this onError awaits — safe: shift() hands each item to exactly one.
        while (mq.queue.length > 0) {
          const item = mq.queue.shift()!
          await onError(item, err)
        }
        mq = undefined
        continue
      }
      runnerAdapter = currentGroup.adapter
      runnerModel = mq.model
    }

    // Drain this model queue (other workers may share it — shift is sync-atomic)
    while (mq.queue.length > 0) {
      const item = mq.queue.shift()!
      try {
        await execute(runner, item)
        onComplete?.(item)
      } catch (err) {
        if (onError) await onError(item, err)
        else throw err
      }
    }

    // Model queue drained → loop back to steal
    mq = undefined
  }
}

/**
 * Distribute N slots across K groups: integer division with remainder to first groups.
 * Returns array of length K.
 */
export function distributeSlots(total: number, groups: number): number[] {
  const base = Math.floor(total / groups)
  const remainder = total % groups
  return Array.from({ length: groups }, (_, i) => base + (i < remainder ? 1 : 0))
}
