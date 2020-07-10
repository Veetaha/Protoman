import { HttpMethod, RequestDescriptor } from '../../core/http_client/request';
import { MessageValue, ProtoCtx } from '../../core/protobuf/protobuf';
import { serializeProtobuf } from '../../core/protobuf/serializer';
import { Env, toVarMap } from './Env';
import { applyEnvs } from '../../core/env';
import { applyToProtoMessage } from '../../core/protobuf/ap';

export type BodyType = 'none' | 'protobuf';
export const BODY_TYPES: string[] = ['none', 'protobuf'];

export interface RequestBuilder {
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers: ReadonlyArray<[string, string]>;
  readonly bodyType: BodyType;
  readonly bodies: RequestBody;
  readonly expectedProtobufMsg: string | undefined;
}

export interface RequestBody {
  none: undefined;
  protobuf: MessageValue | undefined;
}

function encodeBase64ProtobufInJsonString(bin: Buffer): Buffer {
  const quote = Uint8Array.from(['"'.charCodeAt(0)]);
  const base64Encoded = Buffer.from(bin.toString('base64'), 'utf8');
  return Buffer.concat([quote, base64Encoded, quote]);
}

export async function toRequestDescriptor(
  builder: RequestBuilder,
  env: Env,
  ctx: ProtoCtx,
): Promise<RequestDescriptor> {
  const { url, method, headers, bodyType, bodies, expectedProtobufMsg } = builder;
  const varMap = toVarMap(env);

  let body;
  if (bodyType === 'protobuf' && bodies.protobuf && url.startsWith('https://lambda/')) {
    const withEnv = applyToProtoMessage(bodies.protobuf, (s: string): string => applyEnvs(s, varMap));
    body = encodeBase64ProtobufInJsonString(await serializeProtobuf(withEnv, ctx));
  } else {
    body = undefined;
  }

  return {
    url: applyEnvs(url, varMap),
    method,
    headers: headers.map(([k, v]) => [k, applyEnvs(v, varMap)]),
    body,
    expectedProtobufMsg,
  };
}
