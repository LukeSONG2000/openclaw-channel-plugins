import type {
  DeliverDebouncer,
  DeliverExecutor,
  DeliverInfo,
  DeliverPayload,
} from "../deliver-debounce.js";
import type { DeliverDebounceConfig } from "../types.js";

export interface CustomDeliverDebounceLogger {
  info: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
}

export type CustomDeliverDebouncerFactory = (
  config: DeliverDebounceConfig | undefined,
  executor: DeliverExecutor,
  log?: CustomDeliverDebounceLogger,
  prefix?: string,
) => DeliverDebouncer | null;

export interface DispatchCustomDebouncedDeliverParams {
  accountId: string;
  payload: DeliverPayload;
  info: DeliverInfo;
  currentDebouncer: DeliverDebouncer | null;
  setDebouncer: (debouncer: DeliverDebouncer | null) => void;
  debounceConfig: DeliverDebounceConfig | undefined;
  executeDeliver: DeliverExecutor;
  createDebouncer: CustomDeliverDebouncerFactory;
  log?: CustomDeliverDebounceLogger;
}

export type DispatchCustomDebouncedDeliverResult =
  | {
      kind: "debounced";
      debouncer: DeliverDebouncer;
      created: boolean;
    }
  | {
      kind: "direct";
    };

export async function dispatchCustomDebouncedDeliver(
  params: DispatchCustomDebouncedDeliverParams,
): Promise<DispatchCustomDebouncedDeliverResult> {
  let debouncer = params.currentDebouncer;
  let created = false;
  if (!debouncer) {
    debouncer = params.createDebouncer(
      params.debounceConfig,
      params.executeDeliver,
      params.log,
      `[qqbot:${params.accountId}:debounce]`,
    );
    params.setDebouncer(debouncer);
    created = Boolean(debouncer);
  }

  if (debouncer) {
    await debouncer.deliver(params.payload, params.info);
    return { kind: "debounced", debouncer, created };
  }

  await params.executeDeliver(params.payload, params.info);
  return { kind: "direct" };
}
