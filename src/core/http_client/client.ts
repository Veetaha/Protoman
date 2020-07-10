/* eslint-disable @typescript-eslint/no-use-before-define */
import * as aws from 'aws-sdk';
import { RequestDescriptor } from './request';
import { ProtoCtx } from '../protobuf/protobuf';
import { convertHeaders, unconvertHeaders } from './headers';
import { ResponseBodyValue, ResponseDescriptor, ResponseBodyType } from './response';
import fetch, { Response, Headers } from 'node-fetch';
import { deserializeProtobuf } from '../protobuf/deserializer';

const CONTENT_TYPE_JSON = 'application/json';
const CONTENT_TYPE_HTML = 'text/html';

export async function makeRequest(request: RequestDescriptor, protoCtx: ProtoCtx): Promise<ResponseDescriptor> {
  const { url, method, body } = request;

  const headers = convertHeaders(request.headers);

  const sTime = Date.now();

  const match = /https:\/\/lambda\/([a-zA-z0-9\-]+)(?:\/([a-z\-0-9]+))?/.exec(url);

  let response;
  if (match) {
    const [, lambdaName, region] = match;

    const lambda = new aws.Lambda({ region: region ?? 'us-east-2' });

    const buf = body ? Buffer.from(body) : undefined;

    const resp = await lambda
      .invoke({
        FunctionName: lambdaName,
        Payload: buf,
      })
      .promise()
      .catch(err => {
        console.log({ err });
        throw err;
      });
    const headers = new Headers();
    headers.append('content-type', CONTENT_TYPE_JSON);
    response = new Response(resp.Payload as Buffer, { headers });
  } else {
    response = await fetch(url, { method, body, headers });
  }
  const eTime = Date.now();

  const dt = eTime - sTime;

  return translateResponse(response, request, protoCtx, dt);
}

async function translateResponse(
  response: Response,
  request: RequestDescriptor,
  protoCtx: ProtoCtx,
  dt: number,
): Promise<ResponseDescriptor> {
  const responseHeaders = unconvertHeaders(response.headers);
  const saidContentType = responseHeaders.find(([name]) => name === 'content-type')?.[1];

  const { expectedProtobufMsg } = request;

  let responseBodyType: ResponseBodyType = 'unknown';
  let responseBodyValue: ResponseBodyValue = undefined;
  let warning: string | undefined = undefined;

  let buf = new Uint8Array(await response.arrayBuffer());

  if (saidContentType === CONTENT_TYPE_JSON && buf.length >= 2) {
    const quoteByte = '"'.charCodeAt(0);
    if (buf[0] === quoteByte && buf[buf.length - 1] == quoteByte) {
      responseBodyType = 'base64-protobuf-in-json-string';
      buf = decodeBase64ProtobufInJsonString(buf);
    }
  }

  if (buf.length === 0) {
    responseBodyType = 'empty';
    responseBodyValue = undefined;
  } else if (saidContentType === CONTENT_TYPE_JSON && responseBodyType !== 'base64-protobuf-in-json-string') {
    responseBodyType = 'json';
    responseBodyValue = toJson(buf);
  } else if (saidContentType?.includes(CONTENT_TYPE_HTML)) {
    responseBodyType = 'html';
    responseBodyValue = toStr(buf);
  } else if (expectedProtobufMsg) {
    const res = await deserializeProtobuf(buf, expectedProtobufMsg, protoCtx);
    switch (res.tag) {
      case 'invalid':
        if (res.value) {
          responseBodyType = 'json';
          responseBodyValue = res.value;
        } else {
          responseBodyType = 'unknown';
          responseBodyValue = undefined;
        }
        warning = res.error;
        break;
      case 'valid':
        responseBodyType = 'protobuf';
        responseBodyValue = res.value;
        break;
    }
  }

  return {
    statusCode: response.status,
    headers: responseHeaders,
    body: {
      type: responseBodyType,
      value: responseBodyValue,
      bodySize: buf.length,
    },
    warning,
    time: dt,
  };
}

function toStr(buf: Uint8Array): string {
  try {
    return new TextDecoder().decode(buf);
  } catch (err) {
    throw new Error('Error occurred while decoding body to string:\n' + err.message);
  }
}

function toJson(buf: Uint8Array): string {
  const str = toStr(buf);
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch (err) {
    throw new Error('Error occurred while parsing json:\n' + err.message + '\nGiven JSON:\n' + str);
  }
}

function decodeBase64ProtobufInJsonString(arr: Uint8Array): Buffer {
  const buf = Buffer.from(arr);
  const unquoted = buf.slice(1, buf.length - 1);
  const base64encoded = unquoted.toString('utf8');
  return Buffer.from(base64encoded, 'base64');
}
