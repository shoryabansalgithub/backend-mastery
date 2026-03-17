import { useState } from 'react';
import { ChevronRight, BookOpen, FileText, Layers, Cpu, Globe, Clock, Radio, Server, Trophy } from 'lucide-react';
import type { Module } from '../types';

const MODULE_ICONS = [BookOpen, Globe, Layers, Cpu, FileText, Radio, Clock, Radio, Server, Trophy];

interface Props {
  modules: Module[];
  activeLesson: string | null;
  onSelectLesson: (moduleNum: string, lessonId: string) => void;
  onSelectModule: (moduleNum: string) => void;
}

interface ModuleItemProps {
  module: Module;
  isActive: boolean;
  activeLesson: string | null;
  onSelectLesson: (lessonId: string) => void;
  onClick: () => void;
  index: number;
}

function ModuleItem({ module, isActive, activeLesson, onSelectLesson, onClick, index }: ModuleItemProps) {
  const Icon = MODULE_ICONS[index] ?? BookOpen;
  const hasActiveLesson = module.lessons.some(l => l.id === activeLesson);

  return (
    <div>
      <button
        onClick={onClick}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: '8px 12px',
          borderRadius: '6px',
          border: 'none',
          cursor: 'pointer',
          background: isActive ? 'var(--bg-hover)' : 'transparent',
          color: hasActiveLesson || isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
          textAlign: 'left',
          transition: 'background 150ms, color 150ms',
        }}
        onMouseEnter={e => {
          if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-elevated)';
        }}
        onMouseLeave={e => {
          (e.currentTarget as HTMLButtonElement).style.background = isActive ? 'var(--bg-hover)' : 'transparent';
        }}
      >
        <span style={{
          width: '20px', height: '20px', flexShrink: 0,
          color: hasActiveLesson || isActive ? 'var(--accent-bright)' : 'var(--text-muted)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icon size={14} />
        </span>
        <span style={{ flex: 1, fontSize: '13px', fontWeight: 500, lineHeight: 1.3 }}>
          {module.number === '09' ? 'Capstone' : `${module.number}. ${module.title}`}
        </span>
        <span style={{
          fontSize: '10px',
          color: 'var(--text-muted)',
          background: 'var(--bg-elevated)',
          padding: '1px 6px',
          borderRadius: '10px',
          fontFamily: 'JetBrains Mono, monospace',
        }}>
          {module.lessonCount}
        </span>
        <ChevronRight
          size={12}
          style={{
            color: 'var(--text-muted)',
            transition: 'transform 150ms',
            transform: isActive ? 'rotate(90deg)' : 'rotate(0deg)',
            flexShrink: 0,
          }}
        />
      </button>

      {isActive && (
        <div style={{ paddingLeft: '8px', marginTop: '2px', marginBottom: '4px' }}>
          {module.lessons.map(lesson => (
            <button
              key={lesson.id}
              onClick={() => onSelectLesson(lesson.id)}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '6px 8px 6px 28px',
                borderRadius: '5px',
                border: 'none',
                cursor: 'pointer',
                background: activeLesson === lesson.id ? 'var(--accent-dim)' : 'transparent',
                color: activeLesson === lesson.id ? 'var(--accent-bright)' : 'var(--text-muted)',
                textAlign: 'left',
                fontSize: '12.5px',
                lineHeight: 1.4,
                transition: 'background 120ms, color 120ms',
              }}
              onMouseEnter={e => {
                if (activeLesson !== lesson.id)
                  (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-elevated)';
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLButtonElement).style.background =
                  activeLesson === lesson.id ? 'var(--accent-dim)' : 'transparent';
              }}
            >
              <span style={{
                width: '4px', height: '4px', borderRadius: '50%', flexShrink: 0,
                background: activeLesson === lesson.id ? 'var(--accent-bright)' : 'var(--text-muted)',
              }} />
              <span style={{ flex: 1 }}>{lesson.title}</span>
              {(lesson.type === 'project-readme' || lesson.type === 'project-plan') && (
                <span style={{
                  fontSize: '9px', color: 'var(--accent)', background: 'var(--accent-dim)',
                  padding: '1px 5px', borderRadius: '3px', fontWeight: 600, letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                }}>
                  {lesson.type === 'project-readme' ? 'PRJ' : 'PLAN'}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Sidebar({ modules, activeLesson, onSelectLesson, onSelectModule }: Props) {
  const [openModule, setOpenModule] = useState<string | null>('00');

  const handleModuleClick = (moduleNum: string) => {
    if (openModule === moduleNum) {
      setOpenModule(null);
    } else {
      setOpenModule(moduleNum);
      onSelectModule(moduleNum);
    }
  };

  return (
    <aside style={{
      width: '264px',
      flexShrink: 0,
      height: '100vh',
      position: 'fixed',
      left: 0,
      top: 0,
      display: 'flex',
      flexDirection: 'column',
      background: 'var(--bg-surface)',
      borderRight: '1px solid var(--border)',
      overflowY: 'auto',
    }}>
      {/* Logo */}
      <div style={{
        padding: '20px 16px 16px',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{
            width: '28px', height: '28px', borderRadius: '7px',
            background: 'linear-gradient(135deg, #7c6af7 0%, #9d8fff 100%)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>
            <Cpu size={14} color="white" />
          </div>
          <div>
            <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.2 }}>
              Backend Mastery
            </div>
            <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', lineHeight: 1 }}>
              TypeScript · 10 Modules
            </div>
          </div>
        </div>
      </div>

      {/* Module list */}
      <div style={{ flex: 1, padding: '10px 8px', overflowY: 'auto' }}>
        <div style={{ fontSize: '10px', fontWeight: 600, color: 'var(--text-muted)', padding: '6px 12px 8px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Course Content
        </div>
        {modules.map((module, index) => (
          <ModuleItem
            key={module.id}
            module={module}
            index={index}
            isActive={openModule === module.number}
            activeLesson={activeLesson}
            onSelectLesson={(lessonId) => onSelectLesson(module.number, lessonId)}
            onClick={() => handleModuleClick(module.number)}
          />
        ))}
      </div>

      {/* Footer */}
      <div style={{
        padding: '12px 16px',
        borderTop: '1px solid var(--border)',
        flexShrink: 0,
      }}>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
          First principles · No shortcuts
        </div>
      </div>
    </aside>
  );
}
