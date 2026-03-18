import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: false, linkify: true });

export function markdownToHtml(text: string): string {
  // Use markdown-it to render, then post-process for Telegram compatibility
  let html = md.render(text);
  // Strip tags Telegram doesn't support (h1-h6, p, ul, li, etc.)
  // Keep: <b>, <i>, <s>, <code>, <pre>, <a>
  html = html.replace(/<\/?p>/g, '');
  html = html.replace(/<h[1-6][^>]*>/g, '<b>');
  html = html.replace(/<\/h[1-6]>/g, '</b>\n');
  html = html.replace(/<\/?ul>/g, '');
  html = html.replace(/<\/?ol>/g, '');
  html = html.replace(/<li>/g, '• ');
  html = html.replace(/<\/li>/g, '\n');
  html = html.replace(/<em>/g, '<i>');
  html = html.replace(/<\/em>/g, '</i>');
  html = html.replace(/<strong>/g, '<b>');
  html = html.replace(/<\/strong>/g, '</b>');
  return html.trim();
}
