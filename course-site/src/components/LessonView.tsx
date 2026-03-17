import { useEffect, useRef } from 'react';
import { ArrowLeft, ArrowRight, FileCode2, BookOpen, Map } from 'lucide-react';
import { MarkdownRenderer } from './MarkdownRenderer';
import type { Lesson, Module } from '../types';

interface Props {
  lesson: Lesson;
  module: Module;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  prevLabel?: string;
  nextLabel?: string;
}

export function LessonView({ lesson, module, onPrev, onNext, prevLabel, nextLabel }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [lesson.id]);

  const typeIcon = lesson.type === 'project-readme'
    ? <FileCode2 size={14} />
    : lesson.type === 'project-plan'
    ? <Map size={14} />
    : <BookOpen size={14} />;

  const typeBadge = lesson.type === 'project-readme'
    ? 'Project Requirements'
    : lesson.type === 'project-plan'
    ? 'Implementation Plan'
    : `Module ${module.number}`;

  return (
    <div ref={scrollRef} style={{
      flex: 1,
      height: '100vh',
      overflowY: 'auto',
      display: 'flex',
      flexDirection: 'column',
    }}>
      {/* Top bar */}
      <div style={{
        position: 'sticky',
        top: 0,
        zIndex: 10,
        background: 'rgba(12,12,14,0.85)',
        backdropFilter: 'blur(12px)',
        borderBottom: '1px solid var(--border)',
        padding: '0 48px',
        height: '52px',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
      }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: '5px', color: 'var(--text-muted)', fontSize: '12px' }}>
          {typeIcon}
          {typeBadge}
        </span>
        <span style={{ color: 'var(--border)', fontSize: '14px' }}>/</span>
        <span style={{ color: 'var(--text-secondary)', fontSize: '12px', fontWeight: 500 }}>
          {lesson.title}
        </span>
      </div>

      {/* Content */}
      <div style={{
        flex: 1,
        padding: '52px 48px 80px',
        maxWidth: '860px',
        width: '100%',
      }}>
        <MarkdownRenderer content={lesson.content} />
      </div>

      {/* Navigation footer */}
      {(onPrev || onNext) && (
        <div style={{
          padding: '24px 48px',
          borderTop: '1px solid var(--border)',
          display: 'flex',
          justifyContent: 'space-between',
          gap: '16px',
          maxWidth: '860px',
        }}>
          {onPrev ? (
            <button
              onClick={onPrev}
              style={{
                display: 'flex', alignItems: 'center', gap: '8px',
                padding: '10px 16px', borderRadius: '8px',
                border: '1px solid var(--border)', background: 'transparent',
                color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '13px',
                transition: 'all 150ms',
              }}
              onMouseEnter={e => {
                const b = e.currentTarget;
                b.style.background = 'var(--bg-elevated)';
                b.style.color = 'var(--text-primary)';
              }}
              onMouseLeave={e => {
                const b = e.currentTarget;
                b.style.background = 'transparent';
                b.style.color = 'var(--text-secondary)';
              }}
            >
              <ArrowLeft size={14} />
              <span>{prevLabel ?? 'Previous'}</span>
            </button>
          ) : <div />}

          {onNext ? (
            <button
              onClick={onNext}
              style={{
                display: 'flex', alignItems: 'center', gap: '8px',
                padding: '10px 16px', borderRadius: '8px',
                border: '1px solid var(--accent)', background: 'var(--accent-dim)',
                color: 'var(--accent-bright)', cursor: 'pointer', fontSize: '13px', fontWeight: 500,
                transition: 'all 150ms', marginLeft: 'auto',
              }}
              onMouseEnter={e => {
                const b = e.currentTarget;
                b.style.background = 'rgba(124,106,247,0.2)';
              }}
              onMouseLeave={e => {
                const b = e.currentTarget;
                b.style.background = 'var(--accent-dim)';
              }}
            >
              <span>{nextLabel ?? 'Next'}</span>
              <ArrowRight size={14} />
            </button>
          ) : <div />}
        </div>
      )}
    </div>
  );
}
