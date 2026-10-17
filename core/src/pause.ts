/**
 * 刷课暂停闸门。
 *
 * 供 UI「暂停/继续」按钮使用：暂停后，刷课循环在每个活动开始前挂起等待，
 * 不再发起任何网络请求（释放带宽），恢复后自动从当前进度继续。
 */

let paused = false;
let resumeResolvers: Array<() => void> = [];
const listeners = new Set<(paused: boolean) => void>();

/** 当前是否处于暂停状态 */
function isPaused() {
  return paused;
}

/** 暂停刷课 */
function pause() {
  if (paused) return;
  paused = true;
  listeners.forEach((l) => l(true));
}

/** 恢复刷课 */
function resume() {
  if (!paused) return;
  paused = false;
  const waiters = resumeResolvers;
  resumeResolvers = [];
  waiters.forEach((r) => r());
  listeners.forEach((l) => l(false));
}

/** 切换暂停状态，返回切换后的状态 */
function toggle() {
  if (paused) {
    resume();
  } else {
    pause();
  }
  return paused;
}

/**
 * 在关键循环中调用：若处于暂停状态则挂起，直到恢复。
 * 恢复后会立即返回，调用方继续正常流程。
 */
async function waitIfPaused(): Promise<void> {
  if (!paused) return;
  await new Promise<void>((resolve) => {
    resumeResolvers.push(resolve);
  });
}

/** 订阅暂停状态变化（用于推送 UI） */
function onPauseChange(listener: (paused: boolean) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export { isPaused, pause, resume, toggle, waitIfPaused, onPauseChange };
