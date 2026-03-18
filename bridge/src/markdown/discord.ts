export function markdownToDiscordChunks(text: string, limit = 2000): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  const lines = text.split('\n');
  let current = '';
  let inCodeBlock = false;

  const flushCurrent = () => {
    if (current.length > 0) {
      const closeStr = inCodeBlock ? '\n```' : '';
      chunks.push(current + closeStr);
      current = '';
    }
  };

  for (const line of lines) {
    const isFence = /^```/.test(line);

    // Build the text to add (possibly with reopen prefix if we just flushed)
    const reopenPrefix = () => (inCodeBlock ? '```\n' : '');
    const separator = current.length === 0 ? '' : '\n';
    const addition = separator + line;

    if (current.length + addition.length <= limit) {
      // Fits in current chunk
      current += addition;
      if (isFence) inCodeBlock = !inCodeBlock;
    } else {
      // Doesn't fit — flush current
      flushCurrent();

      // Build new content for this line, with reopen prefix if inside a code block
      const prefix = reopenPrefix();
      const lineContent = prefix + line;

      if (lineContent.length <= limit) {
        // Line fits in a new chunk
        current = lineContent;
        if (isFence) inCodeBlock = !inCodeBlock;
      } else {
        // Line is too long — split it character-wise
        // For each piece we emit (except possibly the last), we need to balance fences
        let remaining = lineContent;

        while (remaining.length > limit) {
          let slice = remaining.slice(0, limit);
          remaining = remaining.slice(limit);

          // Count backticks in this slice to see if fences are balanced
          const fenceCount = (slice.match(/```/g) || []).length;
          if (fenceCount % 2 !== 0) {
            // Odd number of fences — close the open one
            slice += '\n```';
          }
          chunks.push(slice);

          // If there's more remaining and we were in a code block context,
          // reopen the fence for the next slice (but only if the slice we just
          // pushed ended inside a code block)
          if (remaining.length > 0) {
            // Determine if we're now inside a code block after the slice
            // by counting all fences in slices so far from the prefix
            const totalFencesSoFar = (lineContent.slice(0, lineContent.length - remaining.length).match(/```/g) || []).length;
            // Add the close fence we may have added
            const adjustedFences = (slice.match(/```/g) || []).length;
            // After pushing this slice with balanced fences, we are NOT inside a code block
            // So if the original line was in a code block, we need to reopen
            if (inCodeBlock || prefix.startsWith('```')) {
              remaining = '```\n' + remaining;
            }
          }
        }
        current = remaining;
        // isFence: the original line's fence toggle
        if (isFence) inCodeBlock = !inCodeBlock;
      }
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}
