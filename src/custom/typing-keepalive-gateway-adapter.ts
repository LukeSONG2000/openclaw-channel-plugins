import { sendC2CInputNotify } from "../api.js";
import type { QueuedMessage } from "../message-queue.js";
import { TYPING_INPUT_SECOND, TypingKeepAlive } from "../typing-keepalive.js";

export interface CustomTypingKeepAliveLogger {
  info?: (msg: string) => void;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
}

export interface CustomTypingKeepAliveHandle {
  start: () => void;
  stop: () => void;
}

export interface CustomTypingKeepAliveFactoryParams {
  getToken: () => Promise<string>;
  clearTokenCache: () => void;
  openid: string;
  msgId?: string;
  log?: CustomTypingKeepAliveLogger;
  logPrefix: string;
}

export interface StartCustomC2CInputNotifyKeepAliveParams {
  accountId: string;
  message: Pick<QueuedMessage, "type" | "senderId" | "messageId">;
  getToken: () => Promise<string>;
  clearTokenCache: () => void;
  sendInputNotify?: (token: string, openid: string, msgId: string | undefined, inputSecond: number) => Promise<{ refIdx?: string }>;
  createKeepAlive?: (params: CustomTypingKeepAliveFactoryParams) => CustomTypingKeepAliveHandle;
  inputSecond?: number;
  log?: CustomTypingKeepAliveLogger;
}

export interface CustomC2CInputNotifyKeepAliveSession {
  inputNotifyRefIdx: Promise<string | undefined>;
  stop: () => void;
}

export function startCustomC2CInputNotifyKeepAlive(
  params: StartCustomC2CInputNotifyKeepAliveParams,
): CustomC2CInputNotifyKeepAliveSession {
  const state: { keepAlive: CustomTypingKeepAliveHandle | null } = { keepAlive: null };
  const inputNotifyRefIdx = sendInitialInputNotifyAndStartKeepAlive(params, state);
  return {
    inputNotifyRefIdx,
    stop: () => state.keepAlive?.stop(),
  };
}

async function sendInitialInputNotifyAndStartKeepAlive(
  params: StartCustomC2CInputNotifyKeepAliveParams,
  state: { keepAlive: CustomTypingKeepAliveHandle | null },
): Promise<string | undefined> {
  if (params.message.type !== "c2c" && params.message.type !== "dm") return undefined;
  try {
    let token = await params.getToken();
    try {
      return await sendInputNotifyWithToken(params, state, token);
    } catch (notifyErr) {
      if (!isRecoverableInputNotifyTokenError(notifyErr)) throw notifyErr;
      params.log?.info?.(`[qqbot:${params.accountId}] InputNotify token expired, refreshing...`);
      params.clearTokenCache();
      token = await params.getToken();
      return await sendInputNotifyWithToken(params, state, token);
    }
  } catch (err) {
    params.log?.error?.(`[qqbot:${params.accountId}] sendC2CInputNotify error: ${err}`);
    return undefined;
  }
}

async function sendInputNotifyWithToken(
  params: StartCustomC2CInputNotifyKeepAliveParams,
  state: { keepAlive: CustomTypingKeepAliveHandle | null },
  token: string,
): Promise<string | undefined> {
  const sendInputNotify = params.sendInputNotify ?? sendC2CInputNotify;
  const inputSecond = params.inputSecond ?? TYPING_INPUT_SECOND;
  const notifyResponse = await sendInputNotify(token, params.message.senderId, params.message.messageId, inputSecond);
  params.log?.info?.(`[qqbot:${params.accountId}] Sent input notify to ${params.message.senderId}${notifyResponse.refIdx ? `, got refIdx=${notifyResponse.refIdx}` : ""}`);
  state.keepAlive = createTypingKeepAlive(params);
  state.keepAlive.start();
  return notifyResponse.refIdx;
}

function createTypingKeepAlive(params: StartCustomC2CInputNotifyKeepAliveParams): CustomTypingKeepAliveHandle {
  if (params.createKeepAlive) {
    return params.createKeepAlive({
      getToken: params.getToken,
      clearTokenCache: params.clearTokenCache,
      openid: params.message.senderId,
      msgId: params.message.messageId,
      log: params.log,
      logPrefix: `[qqbot:${params.accountId}]`,
    });
  }
  return new TypingKeepAlive(
    params.getToken,
    params.clearTokenCache,
    params.message.senderId,
    params.message.messageId,
    params.log as { info: (msg: string) => void; error: (msg: string) => void; debug?: (msg: string) => void } | undefined,
    `[qqbot:${params.accountId}]`,
  );
}

function isRecoverableInputNotifyTokenError(err: unknown): boolean {
  const errMsg = String(err);
  return errMsg.includes("token") || errMsg.includes("401") || errMsg.includes("11244");
}
