import { BookOpen, Cpu, ArrowRight } from 'lucide-react';
import type { Module } from '../types';

interface Props {
  modules: Module[];
  onSelectLesson: (moduleNum: string, lessonId: string) => void;
}

export function HomeView({ modules, onSelectLesson }: Props) {
  return (
    <div style={{
      flex: 1,
      height: '100vh',
      overflowY: 'auto',
      padding: '80px 64px',
    }}>
      {/* Hero */}
      <div style={{ maxWidth: '640px', marginBottom: '64px' }}>
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: '8px',
          padding: '5px 12px', borderRadius: '20px',
          border: '1px solid var(--border)',
          background: 'var(--bg-elevated)',
          marginBottom: '24px',
        }}>
          <Cpu size={12} color="var(--accent-bright)" />
          <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 500 }}>
            Backend Engineering · TypeScript
          </span>
        </div>

        <h1 style={{
          fontSize: '2.75rem', fontWeight: 800, lineHeight: 1.1,
          color: 'var(--text-primary)', letterSpacing: '-0.03em',
          marginBottom: '16px',
        }}>
          Backend Mastery
        </h1>
        <p style={{
          fontSize: '1.05rem', color: 'var(--text-secondary)', lineHeight: 1.7, marginBottom: '0',
          maxWidth: '520px',
        }}>
          Build production-grade backend systems from first principles.
          Every module teaches concepts through real code — no copy-paste, no shortcuts.
        </p>
      </div>

      {/* Module grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
        gap: '12px',
        maxWidth: '980px',
      }}>
        {modules.map((module) => (
          <button
            key={module.id}
            onClick={() => {
              if (module.lessons.length > 0) {
                onSelectLesson(module.number, module.lessons[0].id);
              }
            }}
            style={{
              display: 'flex', flexDirection: 'column', gap: '12px',
              padding: '20px', borderRadius: '10px', textAlign: 'left',
              border: '1px solid var(--border)', background: 'var(--bg-surface)',
              cursor: 'pointer', transition: 'all 150ms',
            }}
            onMouseEnter={e => {
              const b = e.currentTarget;
              b.style.background = 'var(--bg-elevated)';
              b.style.borderColor = 'rgba(255,255,255,0.12)';
            }}
            onMouseLeave={e => {
              const b = e.currentTarget;
              b.style.background = 'var(--bg-surface)';
              b.style.borderColor = 'var(--border)';
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <span style={{
                fontSize: '11px', fontWeight: 700, color: 'var(--accent)',
                background: 'var(--accent-dim)', padding: '2px 8px', borderRadius: '4px',
                fontFamily: 'JetBrains Mono, monospace',
              }}>
                {module.number === '09' ? 'CAPSTONE' : `MOD ${module.number}`}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--text-muted)', fontSize: '11px' }}>
                <BookOpen size={11} />
                <span>{module.lessonCount} lessons</span>
              </div>
            </div>

            <div>
              <div style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '6px', lineHeight: 1.3 }}>
                {module.title}
              </div>
              <div style={{ fontSize: '12.5px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                {module.description}
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--accent-bright)', fontSize: '12px', fontWeight: 500 }}>
              <span>Start learning</span>
              <ArrowRight size={12} />
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
