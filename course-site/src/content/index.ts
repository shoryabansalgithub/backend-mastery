/// <reference types="vite/client" />

// Raw imports of all markdown files
const lessonFiles = import.meta.glob('./**/*.md', { eager: true, import: 'default' }) as Record<string, string>;

// Module metadata
const MODULE_META: Record<string, { title: string; description: string }> = {
  '00': { title: 'Foundations', description: 'TypeScript, Node.js runtime, async patterns, and error handling' },
  '01': { title: 'HTTP & REST APIs', description: 'HTTP from scratch, Express, REST design, validation, middleware' },
  '02': { title: 'Authentication', description: 'Cryptography, password hashing, JWT, OAuth2, RBAC' },
  '03': { title: 'PostgreSQL', description: 'Relational theory, SQL, indexes, transactions, connection pooling' },
  '04': { title: 'ORMs & Drizzle', description: 'ORMs, Drizzle, migrations, advanced query patterns' },
  '05': { title: 'WebSockets', description: 'TCP, WebSocket protocol, ws library, scaling real-time connections' },
  '06': { title: 'Cron & Background Jobs', description: 'Background jobs, cron scheduling, BullMQ, reliability patterns' },
  '07': { title: 'Message Queues & Redis', description: 'Messaging fundamentals, Redis deep dive, streams, production patterns' },
  '08': { title: 'Scaling & Production', description: 'Docker, Compose, CI/CD, observability, performance' },
  '09': { title: 'Capstone', description: 'Synthesize everything: build a system handling 10k req/s' },
};

function titleFromFilename(filename: string): string {
  const base = filename.replace(/\.md$/, '').replace(/^\d+-/, '');
  return base.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

import type { Module, Lesson } from '../types';

export function buildCourse(): Module[] {
  const moduleMap = new Map<string, {
    num: string;
    lessons: Array<{ sortKey: string; lesson: Lesson }>;
    projectReadme?: string;
    projectPlan?: string;
  }>();

  for (const [path, content] of Object.entries(lessonFiles)) {
    // path looks like: "./00-foundations/01-typescript-for-backend.md"
    const parts = path.replace('./', '').split('/');
    if (parts.length < 2) continue;

    const moduleDir = parts[0]; // "00-foundations"
    const numMatch = moduleDir.match(/^(\d+)-/);
    if (!numMatch) continue;
    const moduleNum = numMatch[1];

    if (!moduleMap.has(moduleNum)) {
      moduleMap.set(moduleNum, { num: moduleNum, lessons: [] });
    }
    const mod = moduleMap.get(moduleNum)!;

    if (parts.length === 2) {
      // Root-level lesson file
      const filename = parts[1]; // "01-typescript-for-backend.md"
      const lessonNumMatch = filename.match(/^(\d+)-/);
      if (!lessonNumMatch) continue;
      const lessonNum = lessonNumMatch[1];

      const lesson: Lesson = {
        id: `${moduleNum}-${lessonNum}`,
        title: titleFromFilename(filename),
        slug: filename.replace('.md', ''),
        content,
        type: 'lesson',
      };
      mod.lessons.push({ sortKey: filename, lesson });
    } else if (parts.length === 3 && parts[1] === 'project') {
      const filename = parts[2];
      if (filename === 'README.md') mod.projectReadme = content;
      if (filename === 'plan.md') mod.projectPlan = content;
    }
  }

  const modules: Module[] = [];
  for (const [num, data] of [...moduleMap.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const meta = MODULE_META[num] ?? { title: `Module ${num}`, description: '' };
    data.lessons.sort((a, b) => a.sortKey.localeCompare(b.sortKey));

    const lessons: Lesson[] = data.lessons.map(({ lesson }) => lesson);

    if (data.projectReadme) {
      lessons.push({
        id: `${num}-project-readme`,
        title: 'Project: Requirements',
        slug: 'project-readme',
        content: data.projectReadme,
        type: 'project-readme',
      });
    }
    if (data.projectPlan) {
      lessons.push({
        id: `${num}-project-plan`,
        title: 'Project: Implementation Plan',
        slug: 'project-plan',
        content: data.projectPlan,
        type: 'project-plan',
      });
    }

    modules.push({
      id: `module-${num}`,
      number: num,
      title: meta.title,
      description: meta.description,
      lessons,
      projectReadme: data.projectReadme,
      projectPlan: data.projectPlan,
      lessonCount: data.lessons.length,
    });
  }

  return modules;
}
