/**
 * Course meta AI drafting — the prompt/parse core shared by the owner's
 * my-courses edit dialog (/api/my-courses/ai-meta, ai-cover) and the admin
 * console's course editor (/api/admin/courses/ai). Both ask the model for the
 * same artifacts from the same material, so the prompts live here once.
 *
 * The store's outline is an opaque object to both callers; this module narrows
 * the fields it reads (requirement + scene titles) and nothing else.
 */
import {
  STAGE_DESCRIPTION_MAX_LENGTH,
  STAGE_NAME_MAX_LENGTH,
} from '@/lib/server/agent-runtime/stage-limits';

/** The outline fields the prompts read, narrowed from the opaque store object. */
export interface CourseOutlineDigest {
  name: string;
  description: string;
  requirement: string;
  sceneTitles: string[];
}

export function courseOutlineDigest(document: {
  stage: { name: string; description?: string | null };
  outline?: unknown;
}): CourseOutlineDigest {
  const outline = (document.outline ?? {}) as { requirement?: unknown; outlines?: unknown };
  const requirement = typeof outline.requirement === 'string' ? outline.requirement.trim() : '';
  const sceneTitles = (Array.isArray(outline.outlines) ? outline.outlines : [])
    .map((scene) =>
      typeof (scene as { title?: unknown })?.title === 'string'
        ? (scene as { title: string }).title.trim()
        : '',
    )
    .filter((title): title is string => !!title)
    .slice(0, 30);
  return {
    name: document.stage.name.trim(),
    description: document.stage.description?.trim() || '',
    requirement,
    sceneTitles,
  };
}

/** The 标题/介绍 drafting prompts for a strict-JSON {title, description} reply. */
export function buildCourseMetaPrompts(digest: CourseOutlineDigest): {
  system: string;
  user: string;
} {
  const userPrompt = [
    digest.requirement ? `课程需求：${digest.requirement}` : `课程名称：${digest.name}`,
    digest.sceneTitles.length > 0
      ? `章节目录：\n${digest.sceneTitles.map((t, i) => `${i + 1}. ${t}`).join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const systemPrompt = [
    '你是课程编辑助手。根据提供的课程信息，为这门课程撰写：',
    `1. title：课程标题，不超过 ${STAGE_NAME_MAX_LENGTH} 个字符，吸引人且准确概括课程内容。`,
    `2. description：课程介绍，不超过 ${STAGE_DESCRIPTION_MAX_LENGTH} 个字符，说明课程教什么、适合谁。`,
    '使用与课程内容相同的语言（中文课程用中文撰写）。',
    '只输出 JSON 对象，格式：{"title": "…", "description": "…"}，不要输出其他内容。',
  ].join('\n');
  return { system: systemPrompt, user: userPrompt };
}

/**
 * The course-poster cover prompt. One charming focal illustration built FROM
 * the course's own material carries the whole cover: the cartoon character
 * and scene should be invented for the subject (creative metaphors over
 * generic mascots), rendered with clean vector-quality linework. A little
 * course-related text may be woven into the design — short, correctly
 * written and beautifully typeset, never a mandatory full title — while
 * meta/boilerplate words (海报/封面/在线课程…) are banned outright: image
 * models happily bake the style descriptor itself into the picture.
 */
export function buildCourseCoverPrompt(digest: CourseOutlineDigest): string {
  const sceneTitles = digest.sceneTitles.slice(0, 8);
  const theme = digest.description || digest.requirement || sceneTitles.join('、');
  return [
    `设计一张16:9横版课程封面，风格亲切生动、精致有设计感，让人一看就有兴趣点进来学习。`,
    `背景为明快的柔和渐变色调，可加轻微光晕或少量几何色块点缀氛围，整体干净不杂乱。`,
    `画面主体是围绕课程主题原创的主视觉插画（单一焦点，不要罗列多个元素），课程主题：${theme || digest.name}。`,
    '插画内容要依据课程内容充分创新：从课程知识点中提炼有代表性的卡通形象、场景或趣味隐喻，大胆构思、不落俗套，避免通用模板化的吉祥物。',
    '插画为现代扁平风格，造型圆润、色彩活泼有层次；线条要流畅饱满、粗细均匀、干净利落，如矢量插画般精致，避免毛糙、断续、紊乱的线条；可拟人化或加入微笑等亲和力细节，居中构图并留出舒适的呼吸空间。',
    '画面中可以适当点缀少量与课程内容相关的文字（如主题词、关键词），少而精、自然融入设计（如手写标签、招牌、对话框等创意形式）；文字必须字形清晰、书写正确、排版讲究，字体简洁美观（如圆润手写体或现代无衬线体），与画面气质协调；不要求完整句子，也不必出现课程全名，没有合适的文字就不加，不要生硬堆砌。',
    '严禁出现与课程内容无关的描述性或平台性字样，例如「海报」「封面」「在线课程」「课程海报」「AI生成」等。',
    '不要照片写实，不要密集堆砌细节，不要装饰性花纹。',
  ]
    .filter(Boolean)
    .join('');
}

/** Pull the first JSON object out of a model reply that may be fenced or chatty. */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}
