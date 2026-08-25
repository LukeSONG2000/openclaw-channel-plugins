import {
  sendErrorToTarget as defaultSendErrorToTarget,
  sendWithTokenRetry as defaultSendWithTokenRetry,
  type ReplyContext,
} from "../reply-dispatcher.js";

export interface CustomDispatchSendHelpers {
  sendWithRetry: <T>(sendFn: (token: string) => Promise<T>) => Promise<T>;
  sendErrorMessage: (errorText: string) => Promise<void>;
}

export interface CustomDispatchSendHelpersParams {
  account: ReplyContext["account"];
  replyContext: ReplyContext;
  log?: ReplyContext["log"];
  sendWithTokenRetry?: typeof defaultSendWithTokenRetry;
  sendErrorToTarget?: typeof defaultSendErrorToTarget;
}

export function buildCustomDispatchSendHelpers(
  params: CustomDispatchSendHelpersParams,
): CustomDispatchSendHelpers {
  const sendWithTokenRetry = params.sendWithTokenRetry ?? defaultSendWithTokenRetry;
  const sendErrorToTarget = params.sendErrorToTarget ?? defaultSendErrorToTarget;

  return {
    sendWithRetry: <T>(sendFn: (token: string) => Promise<T>) =>
      sendWithTokenRetry(
        params.account.appId,
        params.account.clientSecret,
        sendFn,
        params.log,
        params.account.accountId,
      ),
    sendErrorMessage: (errorText: string) =>
      sendErrorToTarget(params.replyContext, errorText),
  };
}
