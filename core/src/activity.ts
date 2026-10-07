import Course from '../src/api/course.js';

interface ActivityInfo {
  id: number;
  title: string;
  semester: string;
  code: string;
  startDate: string;
  percent: string | null;
}

async function getActivities(): Promise<ActivityInfo[]> {
  const resp = await Course.getMyCourses(1, 100);
  //console.log('getMyCourses 返回内容:', resp);
  const data = resp.data;
  if (!data || !Array.isArray(data.courses)) {
    //console.warn('getMyCourses 返回数据结构异常:', data);
    throw new Error('my-courses 返回数据结构异常：会话可能已失效，需要重新登录');
  }
  const { courses } = data;
  if (courses.length === 0) {
    // 在册课程不可能为 0：返回空列表几乎总是 API 被重定向到登录页（会话失效）。
    // 抛错让上层可见，避免"静默跑完退出"。
    throw new Error('my-courses 返回空列表：会话可能已失效，需要重新登录');
  }
  return courses.map((course: any) => ({
    id: course.id,
    title: course.name,
    semester: course.semester.name,
    code: course.course_code,
    startDate: course.start_date,
    percent: course.completeness,
  }));
}

export { ActivityInfo, getActivities };
