import { Browser, Cookie } from 'playwright';

import * as fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { dataDir } from './config.js';

// Cookie 存放在数据目录（exe 模式下为 exe 所在文件夹），确保跨启动可复用
const cookieFilename = path.join(dataDir, '.cookies.txt');

interface LoginConfig {
  account?: string;
  password?: string;
  loginApi: string;
  homeApi: string;
}

async function login(browser: Browser, config: LoginConfig) {
  const context =
    browser.contexts().length == 0
      ? await browser.newContext()
      : browser.contexts()[0];

  const cookies = await restoreCookies();

  if (cookies.length != 0) {
    await context.clearCookies();

    await context.addCookies(filterCookies(cookies, ['session'])).catch((e) => {
      console.warn('解析Cookie文件失败:', e);
      fs.rmSync(cookieFilename);
    });
  }

  // Electron 多窗口 + CDP 场景：需要避开 UI 窗口。
  // preload 会给 automation 窗口设置 window.name = 'IMS_AUTOMATION'。
  let page = context.pages().length == 0 ? await context.newPage() : context.pages()[0];

  for (const p of context.pages()) {
    const name = await p
      .evaluate(() => window.name)
      .then(String)
      .catch(() => '');
    if (name === 'IMS_AUTOMATION') {
      page = p;
      break;
    }
  }

  await page.goto(config.homeApi, { timeout: 1000 * 60 * 10 });

  if (!RegExp(`^${config.loginApi}`).test(page.url())) {
    console.log('已经登陆');
    return page;
  }

  console.warn('需要登陆');

  const agree = page.locator('#agreeCheckBox').first();
  await agree.setChecked(true);

  const { account, password } = config;

  if (account && password) {
    await page.getByPlaceholder('请输入登录名').fill(account);
    await page.getByPlaceholder('请输入登录密码').fill(password);
    await page.getByRole('button', { name: /^\s*登\s*录\s*$/ }).click();
  } else {
    console.warn('缺少账号或密码, 需要手动输入');
  }

  // 等待跳转到主页
  // 站点可能附加 locale 等查询参数（如 ?locale=en），精确匹配会永远等不到，这里用前缀匹配
  const homeBase = config.homeApi.split('#')[0].replace(/\?.*$/, '');
  await page.waitForURL((url) => url.href.startsWith(homeBase), {
    timeout: 1000 * 60 * 5,
  });

  // 登录跳转完成后校验会话是否真正生效：
  // SSO 有时跳回主页但 lms 域 session 未写入，后续 API 全部 404，
  // 表现为"课程列表为空、程序静默结束"。这里调一个轻量 API 提前暴露。
  try {
    const resp = await page.evaluate(async () => {
      const r = await fetch('/api/my-courses?page=1&page_size=1', {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      const text = await r.text();
      return { status: r.status, contentType: r.headers.get('content-type') ?? '', text: text.slice(0, 120) };
    });
    if (resp.status !== 200 || !resp.contentType.includes('json')) {
      console.error(
        chalk.red(`登录后会话校验失败 (HTTP ${resp.status})，API 未返回 JSON。` +
          '常见原因：SSO 跳回但 session 未写入、验证码/风控拦截。请重新运行并留意登录窗口。'),
      );
      throw new Error(`login session check failed: HTTP ${resp.status}`);
    }
    console.log(chalk.green('✅ 登录后会话校验通过'));
  } catch (e: any) {
    if (String(e?.message ?? '').includes('login session check')) throw e;
    console.warn(chalk.yellow('⚠️ 会话校验请求本身失败（不阻断）:', e?.message ?? e));
  }

  return page;
}

async function storeCookies(cookies: Array<Cookie>) {
  const s = JSON.stringify(cookies);

  fs.writeFileSync(cookieFilename, s);
}

async function restoreCookies(): Promise<Array<Cookie>> {
  if (fs.existsSync(cookieFilename)) {
    // playwright 不识别null,需要转换undefined
    const cookies: Cookie[] = JSON.parse(
      String(fs.readFileSync(cookieFilename)),
    );
    cookies.forEach((cookie) => {
      for (const k in cookie) {
        (cookie as any)[k] = cookie[k as keyof Cookie] ?? void 0;
      }

      // 不识别小写开头,需要转 ___*( ￣皿￣)/#____
      cookie.sameSite = {
        STRICT: 'Strict',
        LAX: 'Lax',
        None: 'None',
      }[cookie.sameSite.toUpperCase()] as any;
    });

    return cookies;
  }
  return [];
}

/**
 *
 * @param cookies Cookie数组
 * @param names 需要哪些Cookie匹配的name
 * @returns 过滤后符合names的Cookie数组
 */
function filterCookies(cookies: Array<Cookie>, names: string[]) {
  return cookies.filter((cookie) => names.includes(cookie.name));
}

export { LoginConfig, filterCookies, login, restoreCookies, storeCookies };
