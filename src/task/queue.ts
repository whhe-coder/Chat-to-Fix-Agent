// The queue (work package B2, spec 3 sections 3.2 and 4.2).
// First come, first served by `queuedAt`; at most `maxConcurrent` tasks running.
// The state of a queued task lives in the task store; the queue only keeps the ids it has
// handed to the runner but that the store does not yet show as `running`.

const taskNo = (id) => Number(String(id).replace(/^\D+/, '')) || 0

/**
 * @param {{store: object, limits: object, runner: {start: Function}, notify: Function, now?: () => number}} deps
 *   `now()` returns epoch milliseconds. `notify(task, kind)` is the monitor's system-notice function.
 */
export function createQueue({ store, limits, runner, notify = (() => {}) as (...args: any[]) => any, now = () => Date.now() }) {
  const starting = new Set()
  let chain: Promise<any> = Promise.resolve()

  const byOrder = (a, b) => (Date.parse(a.queuedAt) - Date.parse(b.queuedAt)) || (taskNo(a.id) - taskNo(b.id))
  // A task handed to the runner may still read `queued` in the store until the runner calls startRun.
  const queued = async () => (await store.listTasks({ state: 'queued' })).filter((t) => !starting.has(t.id)).sort(byOrder)

  async function runningCount() {
    const ids = new Set((await store.listTasks({ state: 'running' })).map((t) => t.id))
    for (const id of starting) ids.add(id)
    return ids.size
  }

  /** Puts the task (back) in the queue: state `queued`, `queuedAt` now. Returns its position (1 = next), then dispatches. */
  async function enqueue(taskId) {
    starting.delete(taskId)
    await store.patchTask(taskId, { state: 'queued', queuedAt: new Date(now()).toISOString() })
    const position = (await queued()).findIndex((t) => t.id === taskId) + 1
    await dispatch()
    return { position }
  }

  /** Whether the queue has reached `queueMax` (checked by the listener before it creates a task). */
  async function full() {
    return (await queued()).length >= limits.queueMax
  }

  async function position(taskId) {
    return (await queued()).findIndex((t) => t.id === taskId) + 1
  }

  /** A slot is free again: the runner calls this when a run has ended, then `dispatch`. */
  function release(taskId) {
    starting.delete(taskId)
  }

  /** Expires the tasks that waited longer than `queueWaitHours`. Returns their ids. */
  async function expire() {
    const limit = limits.queueWaitHours * 3_600_000
    const out = []
    for (const task of await queued()) {
      if (now() - Date.parse(task.queuedAt) <= limit) continue
      const next = await store.patchTask(task.id, { state: 'expired', endReason: 'queue_expired' })
      out.push(task.id)
      try { await notify(next ?? task, 'expired') } catch { /* a notice that fails must not block the queue */ }
    }
    return out
  }

  async function dispatchNow() {
    await expire()
    let free = limits.maxConcurrent - await runningCount()
    if (free <= 0) return []
    const started = []
    for (const task of await queued()) {
      if (free <= 0) break
      free -= 1
      starting.add(task.id)
      started.push(task.id)
      // Not awaited: starting a run takes a while and the runner reports its own failures through `end`.
      let pending
      try { pending = Promise.resolve(runner.start(task.id)) } catch (error) { pending = Promise.reject(error) }
      pending.catch(async () => {
        starting.delete(task.id)
        try {
          const next = await store.patchTask(task.id, { state: 'failed', endReason: 'start_failed' })
          await notify(next, 'failed')
        } catch { /* nothing more can be done */ }
      })
    }
    return started
  }

  /** Gives free slots to the earliest queued tasks. Calls are serialised. Returns the ids started. */
  function dispatch() {
    const run = chain.then(dispatchNow, dispatchNow)
    chain = run.catch(() => {})
    return run
  }

  return { enqueue, dispatch, release, expire, full, position }
}
