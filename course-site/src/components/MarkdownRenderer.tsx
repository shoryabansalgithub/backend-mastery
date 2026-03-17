import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/atom-one-dark.css';

interface Props {
  content: string;
}

export function MarkdownRenderer({ content: markdownContent }: Props) {
  return (
    <div className="prose">
      <ReactMarkdown
        children={markdownContent}
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          pre({ children, ...props }) {
            // Extract language from className on the code element
            const codeEl = (children as any)?.props;
            const className = codeEl?.className ?? '';
            const lang = className.replace('language-', '') || '';
            return (
              <div className="code-block">
                {lang && <span className="code-lang">{lang}</span>}
                <pre {...props}>
                  <span className="code-block-inner">{children}</span>
                </pre>
              </div>
            );
          },
          // Make tables scrollable
          table({ children, ...props }) {
            return (
              <div style={{ overflowX: 'auto', margin: '1.25rem 0' }}>
                <table {...props}>{children}</table>
              </div>
            );
          },
        }}
      />
    </div>
  );
}
