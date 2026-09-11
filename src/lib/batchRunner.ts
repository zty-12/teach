/**
 * 分批任务控制器：让「识别全部页」这种长任务可以被暂停 / 继续 / 取消。
 *
 * 用法：在每处理一个小单元（一页 / 一批）之前调用 `await runner.tick()`，
 * 控制器会在「暂停」时阻塞当前任务，在「取消」时抛错中断整个流程。
 *
 * 设计要点：
 *  - pause/resume 通过 Promise 队列实现——暂停时 tick() 返回一个挂起的 Promise，
 *    resume() 时一次性全部 resolve，任务从挂起点继续。
 *  - cancel() 内部先 resume()（避免任务永远卡在暂停态），再让下一次 tick() 抛错。
 *  - 正在执行的「单个单元」（如某一页的 API 调用）无法被强制中断，
 *    但会在该单元结束后立即抛错退出，不会继续处理后续单元。
 */

/** 任务被取消时由 tick() 抛出的错误，调用方据此判断是否用户主动取消。 */
export class BatchCancelledError extends Error {
  constructor() {
    super('已取消')
    this.name = 'BatchCancelledError'
  }
}

export class BatchRunner {
  private _paused = false
  private _cancelled = false
  private _waiters: Array<() => void> = []

  get paused(): boolean {
    return this._paused
  }

  get cancelled(): boolean {
    return this._cancelled
  }

  /** 暂停：之后的 tick() 会阻塞，直到 resume()。 */
  pause(): void {
    this._paused = true
  }

  /** 继续：解除暂停，唤醒所有因 pause 而阻塞的 tick()。 */
  resume(): void {
    if (!this._paused) return
    this._paused = false
    const waiters = this._waiters
    this._waiters = []
    waiters.forEach((r) => r())
  }

  /** 取消：解除暂停并标记取消，下一次 tick() 会抛 BatchCancelledError。 */
  cancel(): void {
    this._cancelled = true
    this.resume()
  }

  /**
   * 每处理一个小单元前调用：
   *  - 已取消 → 抛错中断整个流程；
   *  - 处于暂停 → 阻塞直到 resume()；
   *  - 否则立即返回。
   */
  async tick(): Promise<void> {
    if (this._cancelled) throw new BatchCancelledError()
    if (this._paused) {
      await new Promise<void>((resolve) => this._waiters.push(resolve))
    }
    if (this._cancelled) throw new BatchCancelledError()
  }
}
