import { row, type Message } from "./model.ts";

export interface TaskNotification { taskId: string; toolUseId?: string; status: string; summary: string; result?: string; outputFile?: string; worktreePath?: string; worktreeBranch?: string; raw: string }
export interface NotificationAgent { sessionId: string; nickname: string; role: string }
export function taskNotification(message: Pick<Message, "role" | "blocks" | "metadata">): TaskNotification | undefined {
  const record = row(message.metadata?.fields.record);
  if (message.metadata?.provider !== "claude" || message.role !== "user" ||
    !(row(record.origin).kind === "task-notification" || record.turnOrigin === "task_notification" || record.isMeta === true)) return;
  if (message.blocks.length !== 1 || message.blocks[0].kind !== "text") return;
  const raw = message.blocks[0].text;
  if (!/^\s*<task-notification>[\s\S]*<\/task-notification>\s*$/.test(raw)) return;
  const field = (name: string) => {
    const matches = [...raw.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "g"))];
    if (matches.length !== 1) return;
    return matches[0][1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").trim();
  };
  const taskId = field("task-id"), status = field("status"), summary = field("summary");
  if (!taskId || !/^[\w-]+$/.test(taskId) || !status || !summary) return;
  return { taskId, toolUseId: field("tool-use-id"), status, summary, result: field("result"), outputFile: field("output-file"), worktreePath: field("worktreePath"), worktreeBranch: field("worktreeBranch"), raw };
}
export function notificationText(n: TaskNotification) {
  return `[Historical Claude task notification: ${n.taskId}; status: ${n.status}]\n${n.summary}${n.result ? `\nResult: ${n.result}` : ""}${n.outputFile ? `\nSource output file: ${n.outputFile}` : ""}${n.worktreePath ? `\nSource worktree: ${n.worktreePath}` : ""}${n.worktreeBranch ? `\nSource branch: ${n.worktreeBranch}` : ""}`;
}
export function notificationState(n: TaskNotification): string | Record<string, string | null> {
  if (n.status === "completed") return { completed: n.result ?? n.summary };
  if (n.status === "failed") return { errored: n.summary };
  // Historical pending/running tasks cannot remain live in the destination.
  return "interrupted";
}
