'use client';

/**
 * /tutorial — 使用教程: a static three-step walkthrough of the product loop
 * (生成 → 学习 → 管理). Content-first page; no data dependencies.
 */
import Link from 'next/link';
import { BookOpen, GraduationCap, Keyboard, ListChecks, PenLine, Sparkles } from 'lucide-react';

import { SiteHeader } from '@/components/site-header/site-header';
import { Card, CardContent } from '@/components/ui/card';

const STEPS = [
  {
    icon: PenLine,
    title: '1. 描述你的课程',
    body: '回到首页，在「制作课程」输入框里用一两句话写下想学的内容，例如「给小学五年级学生讲解分数的加减法，配练习题」。可按需调整年级、学科与页数偏好。',
    tips: ['描述越具体，大纲越贴合', '支持上传文档/图片作为参考资料'],
  },
  {
    icon: Sparkles,
    title: '2. 一键生成',
    body: '点击生成后系统会自动规划大纲并逐页制作课件，包含讲解、互动与测验。生成过程可随时查看进度，完成后自动进入课堂。',
    tips: ['生成中可以离开页面，进度不会丢失', '对大纲不满意可直接回复修改意见'],
  },
  {
    icon: GraduationCap,
    title: '3. 进入课堂学习',
    body: '课堂里可以逐页学习、与 AI 老师对话提问、完成随堂测验；支持语音朗读与导出 PPT 复习。',
    tips: ['点击页面元素可查看讲解', '测验答错会有针对性讲解'],
  },
  {
    icon: ListChecks,
    title: '4. 管理与回看',
    body: '在「我的课程」查看本设备生成过的全部课程，点击任意卡片即可继续学习；优质课程可由管理员发布到「学习天地」共享给所有人。',
    tips: ['个人资料与密码在「个人中心」维护'],
  },
] as const;

const FAQ = [
  {
    q: '需要注册账号吗？',
    a: '不需要自助注册。账号由管理员统一开通，拿到用户名和初始密码后在登录页登录即可。',
  },
  {
    q: '忘记密码怎么办？',
    a: '请联系管理员重置密码；登录后可在「个人中心 → 修改密码」自行更新。',
  },
  {
    q: '课程会在不同设备间同步吗？',
    a: '已发布到「学习天地」的课程任何设备都能学习；自己生成、未发布的课程目前保存在当前设备对应的账号空间内。',
  },
  {
    q: '快捷键有哪些？',
    a: '课堂内支持方向键翻页、空格播放/暂停朗读等常用快捷操作，详见课堂内帮助入口。',
  },
] as const;

export default function TutorialPage() {
  return (
    <div className="bg-gradient-to-b from-sky-50 via-white to-indigo-50 dark:from-slate-950 dark:via-slate-950 dark:to-indigo-950 min-h-[100dvh]">
      <SiteHeader />
      <main className="mx-auto w-full max-w-4xl px-4 pb-16 pt-28 md:px-8">
        <div className="mb-8 flex items-center gap-3">
          <span className="bg-purple-100 dark:bg-purple-900/40 inline-flex size-11 items-center justify-center rounded-full text-purple-600 dark:text-purple-300">
            <Keyboard className="size-6" />
          </span>
          <div>
            <h1 className="text-2xl font-bold">使用教程</h1>
            <p className="text-muted-foreground text-sm">四步上手：从描述课程到开始学习</p>
          </div>
        </div>

        <div className="flex flex-col gap-4">
          {STEPS.map((step) => (
            <Card key={step.title}>
              <CardContent className="flex gap-4 p-5">
                <span className="bg-purple-50 dark:bg-purple-900/30 inline-flex size-10 shrink-0 items-center justify-center rounded-full text-purple-600 dark:text-purple-300">
                  <step.icon className="size-5" />
                </span>
                <div className="min-w-0">
                  <h2 className="font-semibold">{step.title}</h2>
                  <p className="text-muted-foreground mt-1 text-sm leading-relaxed">{step.body}</p>
                  <ul className="text-muted-foreground mt-2 list-inside list-disc text-xs">
                    {step.tips.map((tip) => (
                      <li key={tip}>{tip}</li>
                    ))}
                  </ul>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <h2 className="mb-4 mt-10 flex items-center gap-2 text-lg font-bold">
          <BookOpen className="size-5" /> 常见问题
        </h2>
        <div className="flex flex-col gap-3">
          {FAQ.map((item) => (
            <Card key={item.q}>
              <CardContent className="p-5">
                <h3 className="text-sm font-semibold">{item.q}</h3>
                <p className="text-muted-foreground mt-1 text-sm leading-relaxed">{item.a}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <p className="text-muted-foreground mt-10 text-center text-sm">
          准备好了？
          <Link href="/" className="text-primary underline underline-offset-4">
            返回首页开始制作课程 →
          </Link>
        </p>
      </main>
    </div>
  );
}
