/**
 * 并发小工具（v12 提速）：
 *
 *  - runPool：受限并发地跑一批任务。任一任务抛错就停止「派发新任务」
 *    （已在飞的任务自然结束），然后把错误抛给调用方——因此配合
 *    BatchRunner.tick() 时，用户点「取消」能迅速收敛退出。
 *
 *  - createLazyPool：惰性资源池。用于 tesseract——单个 worker 不能并发
 *    recognize（会串行化甚至报错），开 N 个 worker 才能真正并行；
 *    资源按需创建，空闲者被复用，避免为小任务白建 worker。
 *
 *  - createSerialQueue：把异步调用串成一条链（同一时刻只有一个在跑），
 *    用于必须串行的场景（如复用单个 worker 连续识别）。
 */

/** 受限并发执行：concurrency 个「工人」从同一队列里取任务，取完即退出 */
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return
  const requested = Math.floor(concurrency)
  const size = Math.max(1, Math.min(Number.isFinite(requested) && requested > 0 ? requested : 1, items.length))
  let cursor = 0
  let failure: unknown = null
  const workers = Array.from({ length: size }, async () => {
    while (failure === null) {
      const i = cursor++
      if (i >= items.length) return
      try {
        await task(items[i], i)
      } catch (e) {
        failure = e
        return
      }
    }
  })
  await Promise.all(workers)
  if (failure !== null) throw failure
}

/** 惰性资源池：最多创建 size 个资源，同时最多 size 个任务持有资源 */
export function createLazyPool<T>(size: number, factory: () => Promise<T>) {
  const max = Math.max(1, Math.floor(size) || 1)
  const idle: T[] = []
  const all: T[] = []
  const waiters: Array<(v: T) => void> = []
  let creating = 0

  async function acquire(): Promise<T> {
    const free = idle.pop()
    if (free !== undefined) return free
    if (all.length + creating < max) {
      creating++
      try {
        const created = await factory()
        all.push(created)
        return created
      } finally {
        creating--
      }
    }
    return new Promise<T>((resolve) => waiters.push(resolve))
  }

  function release(v: T): void {
    const w = waiters.shift()
    if (w) w(v)
    else idle.push(v)
  }

  /** 释放全部已创建资源（未创建的不处理） */
  async function dispose(fn: (v: T) => Promise<void> | void): Promise<void> {
    const list = all.splice(0, all.length)
    idle.length = 0
    await Promise.all(list.map((v) => Promise.resolve(fn(v)).catch(() => undefined)))
  }

  return { acquire, release, dispose, createdCount: () => all.length }
}

/** 串行队列：保证同一时刻只有一个任务在跑，前一个结束才启动下一个 */
export function createSerialQueue() {
  let tail: Promise<unknown> = Promise.resolve()
  return function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(fn, fn)
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}
