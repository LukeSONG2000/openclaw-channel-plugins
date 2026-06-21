import {
  acknowledgeInteraction as defaultAcknowledgeInteraction,
  getAccessToken as defaultGetAccessToken,
  getApiPluginVersion as defaultGetApiPluginVersion,
  sendC2CMessage as defaultSendC2CMessage,
  sendChannelMessage as defaultSendChannelMessage,
  sendGroupMessage as defaultSendGroupMessage,
} from "../api.js";
import { getFrameworkVersion as defaultGetFrameworkVersion } from "../slash-commands.js";
import type { InteractionEvent, ResolvedQQBotAccount } from "../types.js";
import {
  handleCustomInteractionCreateGateway as defaultHandleCustomInteractionCreateGateway,
  type CustomInteractionCreateRuntime,
  type HandleCustomInteractionCreateGatewayParams,
  type HandleCustomInteractionCreateGatewayResult,
} from "./interaction-create-gateway-adapter.js";

export interface CustomInteractionCreateHandlerGatewayLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
}

export interface CustomInteractionCreateHandlerGatewayParams {
  account: Pick<ResolvedQQBotAccount, "accountId" | "appId" | "clientSecret">;
  cfg: unknown;
  runtime: CustomInteractionCreateRuntime;
  persistAuthState: () => void;
  persistPollState: () => void;
  persistGameState: () => void;
  persistDeployConfirmationState: () => void;
  getConfigApi: HandleCustomInteractionCreateGatewayParams["getConfigApi"];
  getRouting?: () => HandleCustomInteractionCreateGatewayParams["routing"];
  getLegacyApprovalHandler?: HandleCustomInteractionCreateGatewayParams["getLegacyApprovalHandler"];
  log?: CustomInteractionCreateHandlerGatewayLogger;
  getAccessToken?: typeof defaultGetAccessToken;
  acknowledgeInteraction?: typeof defaultAcknowledgeInteraction;
  sendGroupMessage?: typeof defaultSendGroupMessage;
  sendC2CMessage?: typeof defaultSendC2CMessage;
  sendChannelMessage?: typeof defaultSendChannelMessage;
  getApiPluginVersion?: typeof defaultGetApiPluginVersion;
  getFrameworkVersion?: typeof defaultGetFrameworkVersion;
  handleInteractionCreate?: typeof defaultHandleCustomInteractionCreateGateway;
}

export type CustomInteractionCreateHandlerGateway = (
  event: InteractionEvent,
) => Promise<HandleCustomInteractionCreateGatewayResult>;

export function createCustomInteractionCreateHandlerGateway(
  params: CustomInteractionCreateHandlerGatewayParams,
): CustomInteractionCreateHandlerGateway {
  return async (event) => {
    const getAccessToken = params.getAccessToken ?? defaultGetAccessToken;
    let interactionToken: Promise<string> | null = null;
    const getInteractionToken = () => {
      interactionToken ??= getAccessToken(params.account.appId, params.account.clientSecret);
      return interactionToken;
    };

    return (params.handleInteractionCreate ?? defaultHandleCustomInteractionCreateGateway)({
      accountId: params.account.accountId,
      event,
      cfg: params.cfg,
      runtime: params.runtime,
      persistAuthState: params.persistAuthState,
      persistPollState: params.persistPollState,
      persistGameState: params.persistGameState,
      persistDeployConfirmationState: params.persistDeployConfirmationState,
      getConfigApi: params.getConfigApi,
      routing: params.getRouting?.(),
      acknowledge: async (code, payload) => {
        const token = await getInteractionToken();
        if (code !== undefined && payload !== undefined) {
          await (params.acknowledgeInteraction ?? defaultAcknowledgeInteraction)(token, event.id, code, payload);
        } else {
          await (params.acknowledgeInteraction ?? defaultAcknowledgeInteraction)(token, event.id);
        }
      },
      pluginVersion: (params.getApiPluginVersion ?? defaultGetApiPluginVersion)(),
      frameworkVersion: (params.getFrameworkVersion ?? defaultGetFrameworkVersion)(),
      sendReply: async (target, text) => {
        const token = await getInteractionToken();
        if (target.kind === "group") {
          await (params.sendGroupMessage ?? defaultSendGroupMessage)(token, target.groupOpenid, text);
        } else if (target.kind === "c2c") {
          await (params.sendC2CMessage ?? defaultSendC2CMessage)(token, target.userOpenid, text);
        } else {
          await (params.sendChannelMessage ?? defaultSendChannelMessage)(token, target.channelId, text);
        }
      },
      getLegacyApprovalHandler: params.getLegacyApprovalHandler,
      log: params.log,
    });
  };
}
