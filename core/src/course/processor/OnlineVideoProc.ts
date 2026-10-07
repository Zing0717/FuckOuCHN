import { expect } from '@playwright/test';
import { Page } from 'playwright';
import ProgressBar from 'progress';
import { CourseType, Processor } from '../processor.js';
import { waitForSPALoaded } from '../../utils.js';
import Config from '../../config.js';

export default class OnlineVideoProc implements Processor {
  name: CourseType = 'online_video';

  // 最近一次播放的视频总时长（秒），用于上报 activities-read 的 end
  private lastDurationSeconds: number | null = null;

  async exec(page: Page) {
    await waitForSPALoaded(page);

    const mediaType = await this.detectMediaType(page);
    if (!mediaType) {
      console.warn('❌ 未检测到音视频元素，跳过');
      return;
    }

    console.log('✅ 检测到媒体类型:', mediaType);

    await this.setPlaybackRate(page, mediaType);
    const [start, end] = await this.getMediaTime(page, mediaType);

    if (start === end && end !== '00:00') return;

    await this.preparePlayback(page, mediaType);
    const totalSeconds = this.timeStringToNumber(end);
    this.lastDurationSeconds = totalSeconds;
    const progress = this.createProgress(
      this.timeStringToNumber(start),
      totalSeconds,
    );

    // 启动视频状态监控与进度条更新
    const cleanupFns = [
      this.monitorPlayback(page),
      this.trackProgress(page, progress, mediaType, end),
    ];

    // 等待播放结束
    await this.waitForPlaybackEnd(page, mediaType);

    // 清理
    cleanupFns.forEach((fn) => fn());

    // 标记为已阅读（尝试触发后端完成状态）并校验后端记录
    try {
      // 尝试从 URL/hash 中提取 activityId 与 courseId
      const info = await page.evaluate(() => {
        const h = location.hash || location.href;
        const aidMatch = (h.match(/#\/(\d+)$/) || h.match(/\/(\d+)(?:$|\/)/));
        const cidMatch = location.pathname.match(/course\/(\d+)/);
        return {
          activityId: aidMatch ? Number(aidMatch[1]) : null,
          courseId: cidMatch ? Number(cidMatch[1]) : null,
        };
      });

      const activityId = info.activityId;
      const courseId = info.courseId;

      if (activityId) {
        // 动态导入以避免循环依赖问题
        const CourseApi = await import('../../api/course.js');
        let readCalled = false;
        try {
          // end 传视频总秒数，平台按观看时长判定完成
          const endSeconds = Math.round(this.lastDurationSeconds ?? 0) || 1;
          await CourseApi.default.activitiesRead('online_video' as any, activityId, endSeconds);
          console.log(`✅ 已通知后端活动已阅读: ${activityId} (end=${endSeconds}s)`);
          readCalled = true;
        } catch (err: any) {
          console.warn('⚠️ activitiesRead 调用失败:', (err as any)?.message ?? String(err));
        }

        if (!readCalled) {
          console.warn('⚠️ 所有 activitiesRead 类型尝试均失败，后端可能不支持此接口或需不同参数');
        }

        // 根据配置决定是否严格等待后端确认
        if (courseId && Config.features.strictCompletionCheck) {
          const maxChecks = 6; // 6 次，每次 5s，总共 30s
          let confirmed = false;
          for (let i = 0; i < maxChecks; i++) {
            try {
              const reads = await CourseApi.default.getActivityReadsForUser(courseId);
              const found = reads.find((r: any) => r.activity_id === activityId && r.completeness === 'full');
              if (found) {
                confirmed = true;
                console.log(`✅ 后端确认活动已完成: ${activityId}`);
                break;
              }
            } catch (e) {
              // 忽略单次错误，继续重试
            }
            await page.waitForTimeout(5000);
          }

          if (!confirmed) {
            console.warn(`⚠️ 后端未在超时时间内确认活动 ${activityId} 已完成，遵循 strictCompletionCheck=true 将在继续前再等待 10s 并重试一次`);
            await page.waitForTimeout(10000);
            try {
              const reads = await CourseApi.default.getActivityReadsForUser(courseId);
              const found = reads.find((r: any) => r.activity_id === activityId && r.completeness === 'full');
              if (found) {
                console.log(`✅ 后端延迟确认活动已完成: ${activityId}`);
                confirmed = true;
              }
            } catch {
              /* ignore */
            }

            if (!confirmed) {
              console.warn('⚠️ 严格完成确认未通过，继续执行会中止 (strictCompletionCheck=true)');
              throw new Error(`活动 ${activityId} 未被后端确认完成`);
            }
          }
        } else if (!courseId) {
          console.warn('⚠️ 无法解析 courseId，无法向后端确认完成状态');
        } else {
          // 非严格模式：不等待后端确认，已结束即可继续
          if (!readCalled) {
            console.warn('⚠️ 非严格模式，已结束但未能通知后端完成（activitiesRead 调用失败），将继续下一活动');
          } else {
            console.log('ℹ️ 非严格模式，已调用 activitiesRead，继续下一活动（不等待后端确认）');
          }
        }
      }
    } catch (err) {
      console.warn('⚠️ 标记/确认活动已读失败:', (err as any)?.message ?? String(err));
      if (Config.features.strictCompletionCheck) throw err; // 严格模式下抛出错误
    }

    console.log('✅ 播放完毕');
  }

  // -------------------------------
  // 🧩 工具方法区域
  // -------------------------------

  private async detectMediaType(page: Page): Promise<'video' | 'audio' | ''> {
    if (await page.locator('video').count()) {
      await this.showVideoControls(page);
      return 'video';
    }
    if (await page.locator('audio').count()) {
      return 'audio';
    }
    return '';
  }

  private async showVideoControls(page: Page) {
    await page
      .locator('div.mvp-replay-player-all-controls')
      .evaluate((el) => el.classList.remove('mvp-replay-player-hidden-control'))
      .catch(() => { });
  }

  private async setPlaybackRate(page: Page, mediaType: 'video' | 'audio') {
    await page.evaluate(
      ({ type, rate }) => {
        const media = document.querySelector(type) as HTMLMediaElement;
        if (media) {
          media.playbackRate = rate;
          media.muted = true; // muted helps with autoplay policies, reduce autoplay interruptions
        }
      },
      { type: mediaType, rate: Config.playRate },
    );
  }

  private async getMediaTime(
    page: Page,
    mediaType: 'video' | 'audio',
  ): Promise<[string, string]> {
    // 保留原有文本读取兼容性，但多数情况下优先使用 numeric time (见 trackProgress)
    const [start, end] =
      mediaType === 'video'
        ? (await page.locator('div.mvp-time-display').textContent())!.split('/')
        : [
          (await page.locator('.current-time').textContent())!,
          (await page.locator('.duration').textContent())!,
        ];
    return [start.trim(), end.trim()];
  }

  private async preparePlayback(page: Page, mediaType: 'video' | 'audio') {
    if (mediaType === 'video') {
      await this.showVideoControls(page);
      // 尽量直接使用 Media API 而非点击控件，减少 UI 切换带来的抖动
      await page.evaluate(() => {
        const el = document.querySelector('video') as HTMLVideoElement | null;
        if (!el) return;
        try {
          el.muted = true;
          // 某些播放器会拒绝 play()，基于 promise 的调用更稳健
          void el.play();
        } catch {
          // ignore
        }
      });
    } else {
      await this.clickSafely(page, '.play');
      await this.clickSafely(page, '.volume');
    }
  }

  private async clickSafely(page: Page, selector: string) {
    const el = page.locator(selector);
    try {
      await expect(el).toBeVisible({ timeout: 1000 });
      await el.click();
    } catch {
      console.warn(`⚠️ 元素 ${selector} 不可点击`);
    }
  }

  private monitorPlayback(page: Page) {
    let lastCur = -1;
    let stableCount = 0;
    const interval = setInterval(async () => {
      try {
        const state = await page.evaluate(() => {
          const el = document.querySelector('video') || document.querySelector('audio');
          if (!el) return { cur: -1, paused: true, ready: 0, ended: false };
          return {
            cur: (el as HTMLMediaElement).currentTime,
            paused: (el as HTMLMediaElement).paused,
            ready: (el as HTMLMediaElement).readyState,
            ended: (el as HTMLMediaElement).ended,
          };
        });

        if (state.ended) {
          // 已结束，停止监控
          return;
        }

        // 如果 paused 或 readyState 太低，视为可能卡住
        const cur = Math.floor(Number(state.cur) || 0);
        if (cur === lastCur && cur > 0) {
          stableCount++;
        } else {
          stableCount = 0;
        }

        lastCur = cur;

        // 连续两次稳定且处于 paused 或 readyState 小于 3（HAVE_FUTURE_DATA）时尝试恢复
        if (stableCount >= 2 && (state.paused || state.ready < 3)) {
          console.log('⚠️ 检测到播放异常（暂停/缓冲），尝试恢复播放');
          await this.attemptRecoverPlayback(page, stableCount);
        }

        // 连续多次恢复失败后，触发页面刷新作为最后手段
        if (stableCount >= 8) {
          console.warn('⚠️ 多次恢复失败，准备刷新页面');
          try {
            await page.reload({ timeout: 10000 });
            await page.waitForLoadState('domcontentloaded');
          } catch {
            console.error('❌ 页面刷新失败');
          }
          stableCount = 0;
        }
      } catch {
        /* ignore */
      }
    }, 2500);

    return () => clearInterval(interval);
  }

  private async attemptRecoverPlayback(page: Page, attempt: number) {
    try {
      // 尝试使用 Media API 直接播放
      const played = await page.evaluate(async ({ rate }) => {
        const el = document.querySelector('video') as HTMLVideoElement | null;
        if (!el) return false;
        try {
          el.muted = true;
          el.playbackRate = rate;
          await el.play();
          return !el.paused;
        } catch {
          return false;
        }
      }, { rate: Config.playRate });

      if (played) return true;

      // 若播放失败，尝试轻微跳转以绕过播放器卡住状态
      await page.evaluate(() => {
        const el = document.querySelector('video') as HTMLVideoElement | null;
        if (!el) return;
        try {
          el.currentTime = Math.min(el.duration || 0, (el.currentTime || 0) + 0.5);
        } catch {
          // ignore
        }
      });

      // 再次尝试播放
      const played2 = await page.evaluate(() => {
        const el = document.querySelector('video') as HTMLVideoElement | null;
        if (!el) return false;
        try {
          void el.play();
          return !el.paused;
        } catch {
          return false;
        }
      });

      if (played2) return true;

      // 作为保底，尝试点击播放控件
      await this.clickSafely(page, '.mvp-toggle-play.mvp-first-btn-margin');
      await page.waitForTimeout(300);
      await this.clickSafely(page, '.mvp-toggle-play.mvp-first-btn-margin');
    } catch (e) {
      console.warn('⚠️ 恢复播放时出现错误', e);
    }

    return false;
  }

  private trackProgress(
    page: Page,
    progress: ProgressBar,
    mediaType: 'video' | 'audio',
    end: string,
  ) {
    let prevSec = 0;
    const interval = setInterval(async () => {
      try {
        // 使用 numeric currentTime 以减少字符串解析错误干扰
        const cur = await page.evaluate(() => {
          const el = document.querySelector('video') || document.querySelector('audio');
          return el ? (el as HTMLMediaElement).currentTime : 0;
        });
        const curSec = Math.floor(Number(cur) || 0);
        if (curSec > prevSec) {
          progress.tick(curSec - prevSec, {
            tcur: this.timeNumberToString(curSec),
            tend: end,
          });
          prevSec = curSec;
        }
      } catch {
        // ignore
      }
    }, 1000);

    return () => clearInterval(interval);
  }

  private async waitForPlaybackEnd(page: Page, mediaType: 'video' | 'audio') {
    // 先等待视频开始播放（currentTime > 0 且未 paused）
    // 使用更鲁棒的轮询：最大等待 2 分钟，超时后不抛出，而是回退到基于进度的监控。
    const startTimeoutMs = 120000;
    const pollIntervalMs = 500;
    const startAt = Date.now();
    let started = false;

    while (Date.now() - startAt < startTimeoutMs) {
      try {
        const state = await page.evaluate(({ mediaType }) => {
          const el = document.querySelector(mediaType) as HTMLMediaElement | null;
          if (!el) return { exists: false, cur: 0, paused: true, cssPlaying: false };
          // 有些自研播放器会在容器上标记播放状态，通过常见类名尝试检测
          const container = el.closest('.mvp-replay-player, .player, .video-player');
          const cssPlaying = container ? container.className.includes('playing') || container.className.includes('is-playing') : false;
          return { exists: true, cur: el.currentTime || 0, paused: el.paused, cssPlaying };
        }, { mediaType });

        if (state.exists && ((state.cur || 0) > 0 && !state.paused) || state.cssPlaying) {
          started = true;
          break;
        }
      } catch (e) {
        // 忽略评估错误，继续轮询
      }
      await page.waitForTimeout(pollIntervalMs);
    }

    if (!started) {
      console.warn('⚠️ 等待视频开始播放超时（2 分钟），将启用基于进度的恢复与监控以避免误判');
      // 不抛出错误：继续执行并依赖后续的 monitorPlayback/trackProgress 来确认播放
    }

    // 再等待播放结束：优先用 ended 属性
    // 若 el.ended 不可靠，则要求连续两次（>=2s）满足接近结束且处于可播放状态
    const maxConfirmWaitMs = 5 * 60 * 1000; // 最多等待 5 分钟以确认结束
    const confirmStart = Date.now();

    let consecutiveConfirm = 0;

    while (Date.now() - confirmStart < maxConfirmWaitMs) {
      try {
        const check = await page.evaluate(() => {
          const el = document.querySelector('video') as HTMLVideoElement | null;
          if (!el) return { ok: false, cur: 0, dur: 0, ended: false, paused: true, ready: 0 };
          const dur = el.duration || 0;
          const cur = el.currentTime || 0;
          const ended = !!el.ended;
          const isNearEnd = dur > 0 && cur >= Math.max(0, dur - 1);
          const isPlayable = !el.paused && el.readyState >= 3; // HAVE_FUTURE_DATA
          return { ok: (ended || (isNearEnd && isPlayable)), cur, dur, ended, paused: el.paused, ready: el.readyState };
        });

        if (check.ok) {
          consecutiveConfirm++;
        } else {
          consecutiveConfirm = 0;
        }

        // 需要连续两次确认以避免误判
        if (consecutiveConfirm >= 2) {
          console.log(`✅ 播放结束确认: cur=${check.cur} dur=${check.dur} ended=${check.ended} ready=${check.ready}`);
          break;
        }

        // 如果播放器显示已结束，也立即确认
        if (check.ended) {
          console.log(`✅ 媒体 ended 标志为 true，立即结束: cur=${check.cur} dur=${check.dur}`);
          break;
        }

        // 若在等待期间播放仍在推进，可继续等待
        await page.waitForTimeout(1000);
      } catch (e) {
        // 忽略评估错误，继续轮询
        console.warn('⚠️ 结束确认评估失败，继续轮询:', (e as any)?.message ?? e);
        await page.waitForTimeout(1000);
      }
    }

    if (consecutiveConfirm < 2) {
      console.warn('⚠️ 结束确认在最大等待时间内未通过，仍将进行一次最终检查并继续，避免阻塞过久');
      // 最终检查一次，如果依然未接近结束，给予额外缓冲时间
      const finalCheck = await page.evaluate(() => {
        const el = document.querySelector('video') as HTMLVideoElement | null;
        if (!el) return { cur: 0, dur: 0, ended: false };
        return { cur: el.currentTime || 0, dur: el.duration || 0, ended: !!el.ended };
      });

      if (!finalCheck.ended && !(finalCheck.dur > 0 && finalCheck.cur >= Math.max(0, finalCheck.dur - 1))) {
        console.warn(`⚠️ 最终检查显示未到末尾 (cur=${finalCheck.cur} dur=${finalCheck.dur} ended=${finalCheck.ended})，再等待 10s 以防误判`);
        await page.waitForTimeout(10000);
      }
    }
  }

  // -------------------------------
  // ⏱️ 时间处理 + 进度条
  // -------------------------------

  private createProgress(cur: number, end: number) {
    const bar = new ProgressBar('🎬 正在播放 [:bar] :percent :tcur/:tend', {
      head: '>',
      incomplete: ' ',
      total: end,
      width: 30,
      clear: true,
    });
    bar.tick(cur, {
      tcur: this.timeNumberToString(cur),
      tend: this.timeNumberToString(end),
    });
    return bar;
  }

  private timeNumberToString(sec: number): string {
    const h = Math.floor(sec / 3600)
      .toString()
      .padStart(2, '0');
    const m = Math.floor((sec % 3600) / 60)
      .toString()
      .padStart(2, '0');
    const s = Math.floor(sec % 60)
      .toString()
      .padStart(2, '0');
    return `${h}:${m}:${s}`;
  }

  private timeStringToNumber(time: string): number {
    const parts = time.split(':').map(Number);
    if (parts.some((n) => isNaN(n) || n < 0)) return 0;
    const [h, m, s] = [0, 0, 0, ...parts].slice(-3);
    return h * 3600 + m * 60 + s;
  }
}
