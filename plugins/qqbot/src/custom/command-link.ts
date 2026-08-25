export function slashCommandInput(command: string, show: string = command): string {
  const text = command.trimStart();
  const label = show.trim() || text.trim();
  return `<qqbot-cmd-input text="${escapeAttribute(text)}" show="${escapeAttribute(label)}"/>`;
}

export function slashCommandEnter(command: string, show: string = command): string {
  const text = command.trimStart();
  const label = show.trim() || text.trim();
  return `<qqbot-cmd-enter text="${escapeAttribute(text)}" show="${escapeAttribute(label)}"/>`;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
