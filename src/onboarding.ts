/**
 * QQBot CLI Onboarding Adapter
 * 
 * 提供 openclaw onboard 命令的交互式配置支持
 */
import type { 
  ChannelOnboardingAdapter,
  ChannelOnboardingStatus,
  ChannelOnboardingStatusContext,
  ChannelOnboardingConfigureContext,
  ChannelOnboardingResult,
  OpenClawConfig,
  SetupInput,
} from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, listQQBotAccountIds, resolveQQBotAccount, applyQQBotAccountConfig } from "./config.js";
import { inspectCustomAdminBindings } from "./custom/auth.js";
import {
  applyCustomRuntimeAdminBindingsToConfig,
  normalizeCustomRuntimeAdminGroup,
  normalizeCustomRuntimeAdminList,
  resolveCustomRuntimeConfig,
} from "./custom/config.js";

// 内部类型（用于类型安全）
interface QQBotChannelConfig {
  enabled?: boolean;
  appId?: string;
  clientSecret?: string;
  clientSecretFile?: string;
  name?: string;
  imageServerBaseUrl?: string;
  markdownSupport?: boolean;
  allowFrom?: string[];
  /** HTTP/WebSocket User-Agent 追加后缀 */
  userAgentSuffix?: string;
  /** 群消息是否默认需要 @提及才触发回复 */
  defaultRequireMention?: boolean;
  /** 消息接收传输方式：websocket（默认）| webhook */
  transport?: string;
  /** webhook 传输配置（transport="webhook" 时生效） */
  webhook?: { path?: string };
  accounts?: Record<string, {
    enabled?: boolean;
    appId?: string;
    clientSecret?: string;
    clientSecretFile?: string;
    name?: string;
    imageServerBaseUrl?: string;
    markdownSupport?: boolean;
    allowFrom?: string[];
  }>;
}

// Prompter 类型定义
interface Prompter {
  note: (message: string, title?: string) => Promise<void>;
  confirm: (opts: { message: string; initialValue?: boolean }) => Promise<boolean>;
  text: (opts: { message: string; placeholder?: string; initialValue?: string; validate?: (value: string) => string | undefined }) => Promise<string>;
  select: <T>(opts: { message: string; options: Array<{ value: T; label: string }>; initialValue?: T }) => Promise<T>;
}

/**
 * 解析默认账户 ID
 */
function resolveDefaultQQBotAccountId(cfg: OpenClawConfig): string {
  const ids = listQQBotAccountIds(cfg);
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function qqbotChannelConfig(cfg: OpenClawConfig): Record<string, unknown> {
  return ((cfg.channels?.qqbot ?? {}) as Record<string, unknown>);
}

function envValue(name: string, env: Record<string, string | undefined> | undefined = process.env): string | undefined {
  return env?.[name]?.trim() || undefined;
}

function inputValue(input: Record<string, unknown> | undefined, names: string[]): unknown {
  for (const name of names) {
    const value = input?.[name];
    if (value !== undefined && value !== null && String(value).trim()) return value;
  }
  return undefined;
}

const CUSTOM_RUNTIME_ADMIN_INPUT_KEYS = ["customRuntimeAdmins", "customAdmins", "admins"];
const CUSTOM_RUNTIME_ADMIN_GROUP_INPUT_KEYS = ["customRuntimeAdminGroup", "customAdminGroup", "adminGroup"];

export function resolveQQBotCustomRuntimeInitializationInput(
  input?: Record<string, unknown>,
  env?: Record<string, string | undefined>,
): { admins?: unknown; adminGroup?: unknown } {
  return {
    admins: inputValue(input, CUSTOM_RUNTIME_ADMIN_INPUT_KEYS) ?? envValue("QQBOT_CUSTOM_ADMINS", env) ?? envValue("QQBOT_ADMINS", env),
    adminGroup: inputValue(input, CUSTOM_RUNTIME_ADMIN_GROUP_INPUT_KEYS) ?? envValue("QQBOT_CUSTOM_ADMIN_GROUP", env) ?? envValue("QQBOT_ADMIN_GROUP", env),
  };
}

export function validateQQBotCustomRuntimeInitializationInput(input: {
  admins?: unknown;
  adminGroup?: unknown;
}): string | null {
  const admins = normalizeCustomRuntimeAdminList(input.admins);
  if (admins.length === 0) {
    return "QQBot initialization requires customRuntime admins; provide customRuntimeAdmins/admins or QQBOT_CUSTOM_ADMINS";
  }
  const adminGroup = normalizeCustomRuntimeAdminGroup(input.adminGroup);
  if (!adminGroup) {
    return "QQBot initialization requires customRuntime adminGroup; provide customRuntimeAdminGroup/adminGroup or QQBOT_CUSTOM_ADMIN_GROUP";
  }
  return null;
}

export function applyQQBotCustomRuntimeInitialization(
  cfg: OpenClawConfig,
  input: {
    admins?: unknown;
    adminGroup?: unknown;
    enabled?: boolean;
  },
): OpenClawConfig {
  const admins = normalizeCustomRuntimeAdminList(input.admins);
  const adminGroup = normalizeCustomRuntimeAdminGroup(input.adminGroup);
  if (admins.length === 0 && !adminGroup && typeof input.enabled !== "boolean") return cfg;
  return applyCustomRuntimeAdminBindingsToConfig(cfg, {
    admins,
    adminGroup,
    enabled: input.enabled,
  });
}

export function validateQQBotSetupInput(
  input: SetupInput | Record<string, unknown>,
  env?: Record<string, string | undefined>,
): string | null {
  const setupInput = input as SetupInput;
  if (!setupInput.token && !setupInput.tokenFile && !setupInput.useEnv) {
    return "QQBot requires --token (format: appId:clientSecret) or --use-env";
  }
  return validateQQBotCustomRuntimeInitializationInput(
    resolveQQBotCustomRuntimeInitializationInput(input as Record<string, unknown>, env),
  );
}

export function applyQQBotSetupAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  input: SetupInput | Record<string, unknown>;
}): OpenClawConfig {
  const input = params.input as Record<string, unknown>;
  let appId = "";
  let clientSecret = "";
  const token = typeof input.token === "string" ? input.token : "";

  if (token) {
    const parts = token.split(":");
    if (parts.length === 2) {
      appId = parts[0] ?? "";
      clientSecret = parts[1] ?? "";
    }
  }

  const nextCfg = applyQQBotAccountConfig(params.cfg, params.accountId, {
    appId,
    clientSecret,
    clientSecretFile: typeof input.tokenFile === "string" ? input.tokenFile : undefined,
    name: typeof input.name === "string" ? input.name : undefined,
    imageServerBaseUrl: typeof input.imageServerBaseUrl === "string" ? input.imageServerBaseUrl : undefined,
  }) as OpenClawConfig;

  return applyQQBotCustomRuntimeInitialization(nextCfg, {
    ...resolveQQBotCustomRuntimeInitializationInput(input),
  });
}

/**
 * QQBot Onboarding Adapter
 */
export const qqbotOnboardingAdapter: ChannelOnboardingAdapter = {
  channel: "qqbot" as any,

  getStatus: async (ctx: ChannelOnboardingStatusContext): Promise<ChannelOnboardingStatus> => {
    const cfg = ctx.cfg as OpenClawConfig;
    const configured = listQQBotAccountIds(cfg).some((accountId) => {
      const account = resolveQQBotAccount(cfg, accountId);
      return Boolean(account.appId && account.clientSecret);
    });
    const adminBindings = inspectCustomAdminBindings(resolveCustomRuntimeConfig(cfg));
    const adminBindingsReady = adminBindings.admins.length > 0 && Boolean(adminBindings.adminGroup);

    return {
      channel: "qqbot" as any,
      configured: configured && adminBindingsReady,
      statusLines: [
        `QQ Bot: ${configured ? "已配置" : "需要 AppID 和 ClientSecret"}`,
        `Custom Runtime 管理员: ${adminBindings.admins.length ? adminBindings.admins.join(", ") : "未绑定"}`,
        `Custom Runtime 管理群: ${adminBindings.adminGroup ?? "未绑定"}`,
      ],
      selectionHint: configured && adminBindingsReady ? "已配置" : "需要 AppID/Secret、管理员和管理群",
      quickstartScore: configured ? 1 : 20,
    };
  },

  configure: async (ctx: ChannelOnboardingConfigureContext): Promise<ChannelOnboardingResult> => {
    const cfg = ctx.cfg as OpenClawConfig;
    const prompter = ctx.prompter as Prompter;
    const accountOverrides = ctx.accountOverrides as Record<string, string> | undefined;
    const shouldPromptAccountIds = ctx.shouldPromptAccountIds;
    
    const qqbotOverride = accountOverrides?.qqbot?.trim();
    const defaultAccountId = resolveDefaultQQBotAccountId(cfg);
    let accountId = qqbotOverride ?? defaultAccountId;

    // 是否需要提示选择账户
    if (shouldPromptAccountIds && !qqbotOverride) {
      const existingIds = listQQBotAccountIds(cfg);
      if (existingIds.length > 1) {
        accountId = await prompter.select({
          message: "选择 QQBot 账户",
          options: existingIds.map((id) => ({
            value: id,
            label: id === DEFAULT_ACCOUNT_ID ? "默认账户" : id,
          })),
          initialValue: accountId,
        });
      }
    }

    let next: OpenClawConfig = cfg;
    const resolvedAccount = resolveQQBotAccount(next, accountId);
    const accountConfigured = Boolean(resolvedAccount.appId && resolvedAccount.clientSecret);
    const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
    const envAppId = typeof process !== "undefined" ? process.env?.QQBOT_APP_ID?.trim() : undefined;
    const envSecret = typeof process !== "undefined" ? process.env?.QQBOT_CLIENT_SECRET?.trim() : undefined;
    const canUseEnv = allowEnv && Boolean(envAppId && envSecret);
    const hasConfigCredentials = Boolean(resolvedAccount.config.appId && resolvedAccount.config.clientSecret);

    let appId: string | null = null;
    let clientSecret: string | null = null;

    // 显示帮助
    if (!accountConfigured) {
      await prompter.note(
        [
          "1) 打开 QQ 开放平台: https://q.qq.com/",
          "2) 创建机器人应用，获取 AppID 和 ClientSecret",
          "3) 在「开发设置」中添加沙箱成员（测试阶段）",
          "4) 准备管理员 member/user openid 和管理群 group_openid",
          "5) 你也可以设置环境变量 QQBOT_APP_ID、QQBOT_CLIENT_SECRET、QQBOT_CUSTOM_ADMINS、QQBOT_CUSTOM_ADMIN_GROUP",
          "",
          "文档: https://bot.q.qq.com/wiki/",
          "",
          "此版本支持流式消息发送！",
        ].join("\n"),
"QQ Bot 配置",
      );
    }

    // 检测环境变量
    if (canUseEnv && !hasConfigCredentials) {
      const keepEnv = await prompter.confirm({
        message: "检测到环境变量 QQBOT_APP_ID 和 QQBOT_CLIENT_SECRET，是否使用？",
        initialValue: true,
      });
      if (keepEnv) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            qqbot: {
              ...(next.channels?.qqbot as Record<string, unknown> || {}),
              enabled: true,
              allowFrom: resolvedAccount.config?.allowFrom ?? ["*"],
            },
          },
        };
      } else {
        // 手动输入
        appId = String(
          await prompter.text({
            message: "请输入 QQ Bot AppID",
            placeholder: "例如: 102146862",
            initialValue: resolvedAccount.appId || undefined,
            validate: (value: string) => (value?.trim() ? undefined : "AppID 不能为空"),
          }),
        ).trim();
        clientSecret = String(
          await prompter.text({
            message: "请输入 QQ Bot ClientSecret",
            placeholder: "你的 ClientSecret",
            validate: (value: string) => (value?.trim() ? undefined : "ClientSecret 不能为空"),
          }),
        ).trim();
      }
    } else if (hasConfigCredentials) {
      // 已有配置
      const keep = await prompter.confirm({
        message: "QQ Bot 已配置，是否保留当前配置？",
        initialValue: true,
      });
      if (!keep) {
        appId = String(
          await prompter.text({
            message: "请输入 QQ Bot AppID",
            placeholder: "例如: 102146862",
            initialValue: resolvedAccount.appId || undefined,
            validate: (value: string) => (value?.trim() ? undefined : "AppID 不能为空"),
          }),
        ).trim();
        clientSecret = String(
          await prompter.text({
            message: "请输入 QQ Bot ClientSecret",
            placeholder: "你的 ClientSecret",
            validate: (value: string) => (value?.trim() ? undefined : "ClientSecret 不能为空"),
          }),
        ).trim();
      }
    } else {
      // 没有配置，需要输入
      appId = String(
        await prompter.text({
          message: "请输入 QQ Bot AppID",
          placeholder: "例如: 102146862",
          initialValue: resolvedAccount.appId || undefined,
          validate: (value: string) => (value?.trim() ? undefined : "AppID 不能为空"),
        }),
      ).trim();
      clientSecret = String(
        await prompter.text({
          message: "请输入 QQ Bot ClientSecret",
          placeholder: "你的 ClientSecret",
          validate: (value: string) => (value?.trim() ? undefined : "ClientSecret 不能为空"),
        }),
      ).trim();
    }

    const existingBindings = inspectCustomAdminBindings(resolveCustomRuntimeConfig(next));
    const configuredBindings = resolveQQBotCustomRuntimeInitializationInput(ctx.input as Record<string, unknown> | undefined);

    let customAdmins = normalizeCustomRuntimeAdminList(configuredBindings.admins ?? existingBindings.admins);
    let customAdminGroup = normalizeCustomRuntimeAdminGroup(configuredBindings.adminGroup ?? existingBindings.adminGroup);

    if (customAdmins.length === 0) {
      customAdmins = normalizeCustomRuntimeAdminList(await prompter.text({
        message: "请输入 customRuntime 管理员 openid（多个用逗号分隔）",
        placeholder: "例如: ADMIN_MEMBER_OPENID",
        validate: (value: string) => normalizeCustomRuntimeAdminList(value).length ? undefined : "至少需要绑定一个管理员 openid",
      }));
    }

    if (!customAdminGroup) {
      customAdminGroup = normalizeCustomRuntimeAdminGroup(await prompter.text({
        message: "请输入 customRuntime 管理群 group_openid",
        placeholder: "例如: 5C1152CA05D191171B05E6997791C3F5",
        validate: (value: string) => normalizeCustomRuntimeAdminGroup(value) ? undefined : "管理群 group_openid 不能为空",
      }));
    }

    next = applyQQBotCustomRuntimeInitialization(next, {
      admins: customAdmins,
      adminGroup: customAdminGroup,
    });

    // 默认允许所有人执行命令（用户无感知）
    const allowFrom: string[] = resolvedAccount.config?.allowFrom ?? ["*"];

    // 应用配置（markdownSupport 默认开启，如需关闭可用 set-markdown.sh）
    if (appId && clientSecret) {
      const existingQQBot = (next.channels?.qqbot as Record<string, unknown>) || {};
      // 保留已有的 markdownSupport 设置，新装默认 true
      const markdownSupport = existingQQBot.markdownSupport ?? true;

      if (accountId === DEFAULT_ACCOUNT_ID) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            qqbot: {
              ...existingQQBot,
              enabled: true,
              customRuntime: qqbotChannelConfig(next).customRuntime,
              appId,
              clientSecret,
              markdownSupport,
              allowFrom,
            },
          },
        };
      } else {
        const existingAccounts = ((next.channels?.qqbot as QQBotChannelConfig)?.accounts || {});
        const existingAccount = existingAccounts[accountId] || {};
        const acctMarkdown = existingAccount.markdownSupport ?? true;

        next = {
          ...next,
          channels: {
            ...next.channels,
            qqbot: {
              ...existingQQBot,
              enabled: true,
              customRuntime: qqbotChannelConfig(next).customRuntime,
              accounts: {
                ...existingAccounts,
                [accountId]: {
                  ...existingAccount,
                  enabled: true,
                  appId,
                  clientSecret,
                  markdownSupport: acctMarkdown,
                  allowFrom,
                },
              },
            },
          },
        };
      }
    }

    return { success: true, cfg: next as any, accountId };
  },

  disable: (cfg: unknown) => {
    const config = cfg as OpenClawConfig;
    return {
      ...config,
      channels: {
        ...config.channels,
        qqbot: { ...(config.channels?.qqbot as Record<string, unknown> || {}), enabled: false },
      },
    } as any;
  },
};
