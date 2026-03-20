export function markdownToFeishu(text: string): string {
  let result = text;
  result = result.replace(/<b>(.*?)<\/b>/g, '**$1**');
  result = result.replace(/<i>(.*?)<\/i>/g, '*$1*');
  result = result.replace(/<s>(.*?)<\/s>/g, '~~$1~~');
  result = result.replace(/<code>(.*?)<\/code>/g, '`$1`');
  result = result.replace(/<a href="(.*?)">(.*?)<\/a>/g, '[$2]($1)');
  result = result.replace(/<pre>([\s\S]*?)<\/pre>/g, '```\n$1\n```');
  result = result.replace(/<\/?[^>]+>/g, '');
  return result;
}
