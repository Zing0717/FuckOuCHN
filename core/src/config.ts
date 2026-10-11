import chalk from 'chalk';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { config as dotenvRaw } from 'dotenv';

const require = createRequire(import.meta.url);

// 数据目录锚定：优先 exe 所在真实目录（electron-builder portable 的 cwd 是临时解压目录，
// 直接用 cwd 会导致 .env/.cookies.txt 丢失，表现为 exe 无法自动登录）。
// 源码运行（electron ./dist/src）时 app.isPackaged=false，回退到 cwd。
let dataDir = process.cwd();
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { app } = require('electron');
  if (app?.isPackaged && process.env.PORTABLE_EXECUTABLE_DIR) {
    dataDir = process.env.PORTABLE_EXECUTABLE_DIR;
  }
} catch {
  // 非 Electron 环境保持 cwd
}

// 先加载 exe 目录下的 .env（存在才加载，避免覆盖已有环境变量优先级）
const envPath = path.join(dataDir, '.env');
if (fs.existsSync(envPath)) {
  dotenvRaw({ path: envPath });
} else {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('dotenv').config();
}

export { dataDir };

const BASE_SSO_URL = 'https://iam.pt.ouchn.cn/am';

const API_BASE_URL = 'https://lms.ouchn.cn';

const { _PROXY_HOST: host, _PROXY_PORT: port } = process.env;
const { _API: api, _KEY: key, _MODEL: model, _Qps } = process.env;
const qps = Number(_Qps) || 1;

const { _ACCOUNT: account, _PASSWORD: password } = process.env;

const examMaxRetries = Math.max(0, Number(process.env._EXAM_MAX_RETRIES ?? 2));

// 功能开关
const parseEnvBool = (val: string | undefined, defaultVal: boolean): boolean => {
  if (val === undefined || val === '') return defaultVal;
  const v = val.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
};

const {
  _ENABLE_VIDEO,
  _ENABLE_EXAM,
  _ENABLE_PAGE,
  _ENABLE_MATERIAL,
  _ENABLE_FORUM,
  _ENABLE_WEBLINK,
  _ENABLE_CLASSROOM,
  _ENABLE_HOMEWORK,
  _ENABLE_TENCENT_MEETING,
} = process.env;

const Config = {
  user: {
    account,
    password,
  },
  urls: {
    login: () => BASE_SSO_URL,
    user: () => `${API_BASE_URL}/user`,
    course: () => `${API_BASE_URL}/course`,
    home: () => `${Config.urls.user()}/index#/`,
    userCourses: () => `${API_BASE_URL}/user/courses#/`,
    // modules: (courseId: string) => `https://lms.ouchn/api/courses/${courseId}/modules`,

  },
  proxy: host && port ? { host: host!, port: Number(port) } : void 0,
  ai: { api, key, model, qps },
  // 功能开关（细粒度控制）
  features: {
    // 视频类
    enableVideo: parseEnvBool(_ENABLE_VIDEO, true),        // 默认开启：在线视频、录播、微课等
    // 测试类
    enableExam: parseEnvBool(_ENABLE_EXAM, true),          // 默认开启：考试
    enableClassroom: parseEnvBool(_ENABLE_CLASSROOM, true), // 默认开启：随堂测试
    // 其他活动
    enablePage: parseEnvBool(_ENABLE_PAGE, true),          // 默认开启：页面
    enableMaterial: parseEnvBool(_ENABLE_MATERIAL, true),  // 默认开启：参考资料
    enableForum: parseEnvBool(_ENABLE_FORUM, true),        // 默认开启：讨论
    enableWebLink: parseEnvBool(_ENABLE_WEBLINK, true),    // 默认开启：线上链接
    enableHomework: parseEnvBool(_ENABLE_HOMEWORK, true),  // 默认开启：作业
    enableTencentMeeting: parseEnvBool(_ENABLE_TENCENT_MEETING, true), // 默认开启：腾讯会议
    // 完成度确认（若开启，则在本地检测后会等待后端确认活动已完成）
    strictCompletionCheck: parseEnvBool(process.env._STRICT_COMPLETION_CHECK, false),
  },

  browser: {
    headless: !!process.env._HEAD_LESS,
    slowMo() {
      const min = Number(process.env._SLOW_MO_MIN ?? 6000);
      const max = Number(process.env._SLOW_MO_MAX ?? 9000);
      console.assert(max > min);
      return Math.floor(Math.random() * (max - min + 1)) + min;
    },
  },
  playRate: Number(process.env._PLAY_RATE ?? 8),
  totalPoints: Number(process.env._TOTAL_POINTS ?? 100),
  examMaxRetries,
};

function printConfigStatus() {
  console.log('\n========== 功能开关 ==========');
  console.log('📹 视频刷课 (online_video/lesson/lesson_replay/slide):', Config.features.enableVideo ? '✅ 开启' : '❌ 关闭');
  console.log('📝 考试答题 (exam):', Config.features.enableExam ? '✅ 开启' : '❌ 关闭');
  console.log('📝 随堂测试 (classroom):', Config.features.enableClassroom ? '✅ 开启' : '❌ 关闭');
  console.log('📄 页面浏览 (page):', Config.features.enablePage ? '✅ 开启' : '❌ 关闭');
  console.log('📚 参考资料 (material):', Config.features.enableMaterial ? '✅ 开启' : '❌ 关闭');
  console.log('💬 讨论论坛 (forum):', Config.features.enableForum ? '✅ 开启' : '❌ 关闭');
  console.log('🔗 线上链接 (web_link):', Config.features.enableWebLink ? '✅ 开启' : '❌ 关闭');
  console.log('📋 作业提交 (homework):', Config.features.enableHomework ? '✅ 开启' : '❌ 关闭');
  console.log('🎥 腾讯会议 (tencent_meeting):', Config.features.enableTencentMeeting ? '✅ 开启' : '❌ 关闭');
  console.log('================================\n');
  console.log('视频倍速:', Config.playRate);
  console.log('考试分数及格线(百分比):', Config.totalPoints);
  console.log('考试最多重试次数:', Config.examMaxRetries);

  if (Config.browser.headless) {
    console.log('无头模式已启用');
  }

  if (Config.ai && Config.ai.api && Config.ai.key && Config.ai.model) {
    console.log('AI已启用:');
    console.log('API', Config.ai.api);
    console.log('Key', '*'.repeat(Config.ai.key.length));
    console.log('Model', Config.ai.model);
  }

  if (Config.proxy) {
    console.log(
      '代理:',
      chalk.green(`http://${Config.proxy.host}:${Config.proxy.port}`),
    );
  }
}

export default Config;

export { API_BASE_URL, printConfigStatus };
