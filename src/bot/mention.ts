/**
 * Strip `<at>BotName</at>` tags that Teams adds in group chats.
 */
export function stripMention(text: string): string {
  return text.replace(/<at>.*?<\/at>\s*/g, "").trim();
}
