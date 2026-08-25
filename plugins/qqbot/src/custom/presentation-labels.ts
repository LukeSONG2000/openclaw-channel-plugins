import type {
  CustomCapability,
  CustomDeployConfirmationStatus,
  CustomGuessGame,
  CustomPoll,
  CustomSceneKind,
  CustomTaskStatus,
} from "./types.js";

type ConcreteCapability = Exclude<CustomCapability, "*">;

export const CUSTOM_SCENE_LABELS: Record<CustomSceneKind, string> = {
  "codex-only": "仅 Codex 任务",
  chat: "日常聊天",
  "system-admin": "系统管理",
  "dev-lab": "开发实验室",
  "default-dm": "私聊默认",
};

const CAPABILITY_LABELS: Record<ConcreteCapability, string> = {
  "chat.send": "发送聊天消息",
  "codex.run": "执行 Codex 任务",
  "codex.longTask": "创建或修改长任务",
  "system.status": "查看状态",
  "system.restart": "重启服务",
  "config.read": "读取配置",
  "config.write": "写入配置/规则",
  "web.search": "联网搜索",
  "auth.grant": "处理授权",
  "deploy.check": "检查部署/版本",
  "deploy.apply": "执行部署/升级",
  "proactive.send": "主动发消息",
  "game.interact": "创建或管理互动",
  "schedule.run": "创建/执行定时任务",
};

const TASK_STATUS_LABELS: Record<CustomTaskStatus, string> = {
  queued: "排队中",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const DEPLOY_STATUS_LABELS: Record<CustomDeployConfirmationStatus, string> = {
  pending: "待确认",
  confirmed: "已确认",
  cancelled: "已取消",
  expired: "已过期",
};

const POLL_STATUS_LABELS: Record<CustomPoll["status"], string> = {
  open: "进行中",
  closed: "已关闭",
};

const GAME_STATUS_LABELS: Record<CustomGuessGame["status"], string> = {
  open: "进行中",
  won: "已猜中",
  closed: "已关闭",
};

export function formatBooleanYesNo(value: boolean): string {
  return value ? "是" : "否";
}

export function formatBooleanYesNoUnknown(value: boolean | undefined): string {
  return value === undefined ? "未知" : formatBooleanYesNo(value);
}

export function formatOnOff(value: boolean): string {
  return value ? "开启" : "关闭";
}

export function formatUnknown(value: string | undefined | null): string {
  const text = String(value ?? "").trim();
  return text || "未知";
}

export function formatSceneSource(source: string): string {
  if (source === "exact") return "精确绑定";
  if (source === "kind-wildcard") return "同类通配";
  if (source === "wildcard") return "全局通配";
  if (source === "default") return "默认规则";
  return source || "未知";
}

export function formatSceneKind(scene: CustomSceneKind): string {
  return `${CUSTOM_SCENE_LABELS[scene] ?? scene}（${scene}）`;
}

export function formatCapabilityForDisplay(capability: CustomCapability): string {
  if (capability === "*") return "全部能力（*）";
  const label = CAPABILITY_LABELS[capability];
  return label ? `${capability}（${label}）` : capability;
}

export function formatCapabilityForUser(capability: CustomCapability): string {
  if (capability === "*") return "全部能力（*）";
  const label = CAPABILITY_LABELS[capability];
  return label ? `${label}（${capability}）` : capability;
}

export function formatCapabilitiesForDisplay(capabilities: readonly CustomCapability[] | undefined): string {
  if (!capabilities?.length) return "无";
  return capabilities.map(formatCapabilityForDisplay).join(", ");
}

export function formatTaskStatusForDisplay(status: CustomTaskStatus | string): string {
  return `${TASK_STATUS_LABELS[status as CustomTaskStatus] ?? status}（${status}）`;
}

export function formatDeployStatusForDisplay(status: CustomDeployConfirmationStatus | string): string {
  return `${DEPLOY_STATUS_LABELS[status as CustomDeployConfirmationStatus] ?? status}（${status}）`;
}

export function formatPollStatusForDisplay(status: CustomPoll["status"] | string): string {
  return `${POLL_STATUS_LABELS[status as CustomPoll["status"]] ?? status}（${status}）`;
}

export function formatGameStatusForDisplay(status: CustomGuessGame["status"] | string): string {
  return `${GAME_STATUS_LABELS[status as CustomGuessGame["status"]] ?? status}（${status}）`;
}

export function formatDurationZh(ms: number | undefined, empty: string = "-"): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return empty;
  if (ms < 1000) return `${Math.floor(ms)}毫秒`;
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}天`);
  if (hours > 0) parts.push(`${hours}小时`);
  if (minutes > 0) parts.push(`${minutes}分钟`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}秒`);
  return parts.slice(0, 2).join("");
}
