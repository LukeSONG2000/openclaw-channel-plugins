import type {
  DeliverAccountContext,
  DeliverEventContext,
  PlainReplyPayload,
  SendWithRetryFn,
} from "../outbound-deliver.js";
import type { ReplyContext } from "../reply-dispatcher.js";

export type CustomStaticDeliverParseMediaTags = (
  replyText: string,
  event: DeliverEventContext,
  actx: DeliverAccountContext,
  sendWithRetry: SendWithRetryFn,
  consumeQuoteRef: () => string | undefined,
) => Promise<{ handled: boolean; normalizedText: string }>;

export type CustomStaticDeliverHandleStructuredPayload = (
  replyContext: ReplyContext,
  replyText: string,
  recordOutboundActivity: () => void,
) => Promise<boolean>;

export type CustomStaticDeliverSendPlainReply = (
  payload: PlainReplyPayload,
  replyText: string,
  event: DeliverEventContext,
  actx: DeliverAccountContext,
  sendWithRetry: SendWithRetryFn,
  consumeQuoteRef: () => string | undefined,
  toolMediaUrls: string[],
) => Promise<void>;

export interface ApplyCustomStaticDeliverGatewayParams {
  deliverPayload: PlainReplyPayload;
  replyContext: ReplyContext;
  deliverEvent: DeliverEventContext;
  deliverAccountContext: DeliverAccountContext;
  sendWithRetry: SendWithRetryFn;
  quoteRef?: string;
  toolMediaUrls: string[];
  recordBlockDeliveredMedia: (payload: PlainReplyPayload) => void;
  recordOutboundActivity: () => void;
  parseAndSendMediaTags: CustomStaticDeliverParseMediaTags;
  handleStructuredPayload: CustomStaticDeliverHandleStructuredPayload;
  sendPlainReply: CustomStaticDeliverSendPlainReply;
}

export type ApplyCustomStaticDeliverGatewayResult =
  | {
      kind: "media-tags";
    }
  | {
      kind: "structured-payload";
    }
  | {
      kind: "plain";
    };

export async function applyCustomStaticDeliverGateway(
  params: ApplyCustomStaticDeliverGatewayParams,
): Promise<ApplyCustomStaticDeliverGatewayResult> {
  const consumeQuoteRef = createSingleUseQuoteRef(params.quoteRef);
  let replyText = params.deliverPayload.text ?? "";

  const mediaResult = await params.parseAndSendMediaTags(
    replyText,
    params.deliverEvent,
    params.deliverAccountContext,
    params.sendWithRetry,
    consumeQuoteRef,
  );
  if (mediaResult.handled) {
    params.recordOutboundActivity();
    return { kind: "media-tags" };
  }
  replyText = mediaResult.normalizedText;

  const structuredHandled = await params.handleStructuredPayload(
    params.replyContext,
    replyText,
    params.recordOutboundActivity,
  );
  if (structuredHandled) {
    return { kind: "structured-payload" };
  }

  params.recordBlockDeliveredMedia(params.deliverPayload);
  await params.sendPlainReply(
    params.deliverPayload,
    replyText,
    params.deliverEvent,
    params.deliverAccountContext,
    params.sendWithRetry,
    consumeQuoteRef,
    params.toolMediaUrls,
  );
  params.recordOutboundActivity();
  return { kind: "plain" };
}

function createSingleUseQuoteRef(quoteRef: string | undefined): () => string | undefined {
  let used = false;
  return () => {
    if (quoteRef && !used) {
      used = true;
      return quoteRef;
    }
    return undefined;
  };
}
