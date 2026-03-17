export interface Lesson {
  id: string;
  title: string;
  slug: string;
  content: string;
  type: 'lesson' | 'project-readme' | 'project-plan';
}

export interface Module {
  id: string;
  number: string;
  title: string;
  description: string;
  lessons: Lesson[];
  projectReadme?: string;
  projectPlan?: string;
  lessonCount: number;
}

export interface CourseNav {
  modules: Module[];
}
