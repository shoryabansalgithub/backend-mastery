import { useState, useMemo } from 'react';
import { buildCourse } from './content/index';
import { Sidebar } from './components/Sidebar';
import { LessonView } from './components/LessonView';
import { HomeView } from './components/HomeView';
import type { Lesson, Module } from './types';

export default function App() {
  const modules = useMemo(() => buildCourse(), []);
  const [activeLesson, setActiveLesson] = useState<string | null>(null);

  // Flatten all lessons for prev/next navigation
  const allLessons = useMemo(() => {
    const result: Array<{ lesson: Lesson; module: Module }> = [];
    for (const mod of modules) {
      for (const lesson of mod.lessons) {
        result.push({ lesson, module: mod });
      }
    }
    return result;
  }, [modules]);

  const activeIndex = useMemo(() =>
    allLessons.findIndex(({ lesson }) => lesson.id === activeLesson),
    [allLessons, activeLesson]
  );

  const currentEntry = activeIndex >= 0 ? allLessons[activeIndex] : null;
  const prevEntry = activeIndex > 0 ? allLessons[activeIndex - 1] : null;
  const nextEntry = activeIndex < allLessons.length - 1 ? allLessons[activeIndex + 1] : null;

  const handleSelectLesson = (_moduleNum: string, lessonId: string) => {
    setActiveLesson(lessonId);
  };

  const handleSelectModule = (moduleNum: string) => {
    const mod = modules.find(m => m.number === moduleNum);
    if (mod && mod.lessons.length > 0 && !mod.lessons.some(l => l.id === activeLesson)) {
      setActiveLesson(mod.lessons[0].id);
    }
  };

  return (
    <div style={{ display: 'flex', minHeight: '100dvh' }}>
      <Sidebar
        modules={modules}
        activeLesson={activeLesson}
        onSelectLesson={handleSelectLesson}
        onSelectModule={handleSelectModule}
      />

      <main style={{ marginLeft: '264px', flex: 1, display: 'flex' }}>
        {currentEntry ? (
          <LessonView
            lesson={currentEntry.lesson}
            module={currentEntry.module}
            onPrev={prevEntry ? () => setActiveLesson(prevEntry.lesson.id) : null}
            onNext={nextEntry ? () => setActiveLesson(nextEntry.lesson.id) : null}
            prevLabel={prevEntry?.lesson.title}
            nextLabel={nextEntry?.lesson.title}
          />
        ) : (
          <HomeView modules={modules} onSelectLesson={handleSelectLesson} />
        )}
      </main>
    </div>
  );
}
