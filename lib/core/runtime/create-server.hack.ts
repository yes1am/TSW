/* !
 * Tencent is pleased to support the open source community by making Tencent Server Web available.
 * Copyright (C) 2018 THL A29 Limited, a Tencent company. All rights reserved.
 * Licensed under the MIT License (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at
 * http://opensource.org/licenses/MIT
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

import * as http from "http";
import * as https from "https";
import * as domain from "domain";
import currentContext, { RequestLog } from "../context";
import { address } from "ip";
import { AddressInfo, isIP } from "net";
import { captureOutgoing } from "./capture/outgoing";
import { captureIncoming } from "./capture/incoming";
import { eventBus, EVENT_LIST } from "../bus";

let httpCreateServerHacked = false;
let httpsCreateServerHacked = false;

let originHttpCreateServer = null;
let originHttpsCreateServer = null;

export const hack = <T extends typeof http.createServer>(
  originCreateServer: T
): (
    (
      optionsOrRequestListener: http.ServerOptions,
      requestListenerOrUndefined?: http.RequestListener
    ) => http.Server
  ) => (
    (
      optionsOrRequestListener: http.ServerOptions,
      requestListenerOrUndefined?: http.RequestListener
    ): http.Server => {
      let requestListener: http.RequestListener;
      let options: http.ServerOptions;
      if (typeof optionsOrRequestListener === "function") {
        requestListener = optionsOrRequestListener;
      } else {
        requestListener = requestListenerOrUndefined;
        options = optionsOrRequestListener;
      }

      const requestListenerWrap: http.RequestListener = (req, res) => {
        const start = new Date().getTime();
        const timestamps: RequestLog["timestamps"] = {
          dnsTime: 0,
          requestStart: start,
          onSocket: start,
          onLookUp: start,
          requestFinish: start,
          socketConnect: start
        } as RequestLog["timestamps"];

        // Creating a domain and wrapping the execution.
        const d = domain.create();

        d.add(req);
        d.add(res);

        const clearDomain = (): void => {
          d.remove(req);
          d.remove(res);

          if (process.domain.currentContext) {
            process.domain.currentContext = null;
          }

          const parser = (req.socket as any).parser as any;
          if (parser && parser.domain) {
            (parser.domain as domain.Domain).exit();
            parser.domain = null;
          }

          while (process.domain) {
            (process.domain as domain.Domain).exit();
          }
        };

        const requestInfo = captureIncoming(req);

        res.writeHead = ((fn): typeof res.writeHead => (
          ...args: unknown[]
        ): ReturnType<typeof res.writeHead> => {
          timestamps.onResponse = new Date().getTime();

          const context = currentContext();

          eventBus.emit(EVENT_LIST.RESPONSE_START, {
            req, res, context
          });

          captureOutgoing(res);

          return fn.apply(res, args);
        })(res.writeHead);

        res.once("finish", () => {
          const context = currentContext();

          context.currentRequest = {
            SN: context.SN,

            protocol: "HTTP",
            host: req.headers.host,
            path: req.url,

            process: `TSW: ${process.pid}`,

            clientIp: req.socket.remoteAddress,
            clientPort: req.socket.remotePort,
            serverIp: address(),
            serverPort: (req.socket.address() as AddressInfo).port,
            requestHeader: ((): string => {
              const result = [];
              result.push(`${req.method} ${
                req.url} HTTP/${req.httpVersion}`);

              Object.keys(req.headers).forEach((key) => {
                result.push(`${key}: ${req.headers[key]}`);
              });

              result.push("");
              result.push("");

              return result.join("\r\n");
            })(),
            requestBody: requestInfo.body.toString("base64"),
            responseHeader: ((): string => {
              const result = [];
              result.push(`HTTP/${req.httpVersion} ${
                res.statusCode} ${res.statusMessage}`);

              const resHeaders = res.getHeaders();
              Object.keys(resHeaders).forEach((key) => {
                result.push(`${key}: ${resHeaders[key]}`);
              });

              result.push("");
              result.push("");

              return result.join("\r\n");
            })(),
            responseBody: (res as any)._body.toString("base64"),
            responseLength: (res as any)._bodyLength,
            responseType: res.getHeader("content-type"),
            statusCode: res.statusCode,
            timestamps
          } as RequestLog;

          clearDomain();

          eventBus.emit(EVENT_LIST.RESPONSE_FINISH, {
            req, res, context
          });
        });

        res.once("close", () => {
          timestamps.responseClose = new Date().getTime();

          const context = currentContext();

          clearDomain();

          eventBus.emit(EVENT_LIST.RESPONSE_CLOSE, {
            req, res, context
          });
        });

        d.run(() => {
          const context = currentContext();
          eventBus.emit(EVENT_LIST.REQUEST_START, {
            req, context
          });

          // proxy req to proxy env when hitting uid
          if ((isIP(context.proxyIp))
          && !req.headers["x-tsw-proxy"]) {
            console.debug("isProxyUser...");

            const requestOptions = {
              hostname: context.proxyIp,
              port: context.proxyPort,
              path: req.url,
              method: req.method,
              headers: { "x-tsw-proxy": "true", ...req.headers }
            };
            console.debug("start proxy");
            const proxyReq = http.request(requestOptions, (proxyRes) => {
              proxyRes.pipe(res);
              Object.keys(proxyRes.headers).forEach((headerType) => {
                res.setHeader(headerType, proxyRes.headers[headerType]);
              });

              res.writeHead(proxyRes.statusCode);
              proxyRes.on("end", () => {
                console.debug("end proxy");
              });
            });

            if (/POST|PUT/i.test(req.method)) {
              req.pipe(proxyReq);
            } else {
              proxyReq.end();
            }

            proxyReq.on("error", (err) => {
              console.error("proxy fail...");
              console.error(JSON.stringify(err));
              if (res.headersSent) {
                res.end();
                return;
              }

              res.setHeader("Content-Type", "text/html; charset=UTF-8");
              res.writeHead(500);
              res.end();
            });

            return;
          }

          requestListener(req, res);
        });
      };

      if (options) {
        return originCreateServer.apply(this, [options, requestListenerWrap]);
      }

      return originCreateServer.apply(this, [requestListenerWrap]);
    }
  );

export const httpCreateServerHack = (): void => {
  if (!httpCreateServerHacked) {
    httpCreateServerHacked = true;
    originHttpCreateServer = http.createServer;

    // eslint-disable-next-line
    // @ts-ignore
    // By default, ts not allow us to rewrite original methods.
    http.createServer = hack(http.createServer);
  }
};

export const httpsCreateServerHack = (): void => {
  if (!httpsCreateServerHacked) {
    httpsCreateServerHacked = true;
    originHttpsCreateServer = https.createServer;

    // eslint-disable-next-line
    // @ts-ignore
    // By default, ts not allow us to rewrite original methods.
    https.createServer = hack(https.createServer);
  }
};

export const httpCreateServerRestore = (): void => {
  if (httpCreateServerHacked) {
    httpCreateServerHacked = false;
    // eslint-disable-next-line
    // @ts-ignore
    // By default, ts not allow us to rewrite original methods.
    http.createServer = originHttpCreateServer;
  }
};

export const httpsCreateServerRestore = (): void => {
  if (httpsCreateServerHacked) {
    httpsCreateServerHacked = false;
    // eslint-disable-next-line
    // @ts-ignore
    // By default, ts not allow us to rewrite original methods.
    https.createServer = originHttpsCreateServer;
  }
};
