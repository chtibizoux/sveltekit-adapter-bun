import type { Server } from 'bun';
import { existsSync } from 'fs';
import { manifest } from 'MANIFEST';
import { join } from 'path';
import type { AdapterPlatform, ServeOptions, WebSocketHandler } from '../types';
import { server } from './server';
import sirv from './sirv';
import { get_basepath, get_url, set_url } from './utils';

type MaybePromise<T> = T | Promise<T>;

type FetchOptions = Pick<
    ServeOptions,
    'overrideOrigin' | 'hostHeader' | 'protocolHeader' | 'ipHeader' | 'xffDepth'
>;

type Resolvers = ((args: { request: Request }) => MaybePromise<Response | undefined | void>)[];

type GetIP = (request: Request, fallback: string | undefined) => string | undefined | null;

function clone_req(url: URL, request: Request) {
    return new Request(url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        referrer: request.referrer,
        referrerPolicy: request.referrerPolicy,
        mode: request.mode,
        credentials: request.credentials,
        cache: request.cache,
        redirect: request.redirect,
        integrity: request.integrity
    });
}

async function first_resolve(request: Request, resolvers: Resolvers) {
    const args = { request };
    for (let i = 0; i < resolvers.length; i++) {
        const _r = resolvers[i](args);
        const response = _r instanceof Promise ? await _r : _r;
        if (response) return response;
    }
}

function override_origin(args: { request: Request }, origin: URL) {
    const url = get_url(args.request);
    const newUrl = new URL(url.pathname + url.search, origin);
    args.request = clone_req(newUrl, args.request);
    set_url(args.request, newUrl);
}

function override_origin_with_header(
    args: { request: Request },
    hostHeader: string | undefined,
    protocolHeader: string | undefined
) {
    const url = get_url(args.request);
    let newUrl = new URL(url);
    if (hostHeader && args.request.headers.has(hostHeader)) {
        newUrl.host = args.request.headers.get(hostHeader)!;
    }
    if (protocolHeader && args.request.headers.has(protocolHeader)) {
        newUrl.protocol = args.request.headers.get(protocolHeader)! + ':';
    }
    if (newUrl.href !== url.href) {
        args.request = clone_req(newUrl, args.request);
        set_url(args.request, newUrl);
    }
}

function resolve_xff_ip(request: Request, depth: number) {
    if (!request.headers.has('x-forwarded-for')) return;
    const ips = request.headers.get('x-forwarded-for')!.split(',');
    return ips.at(-depth) || undefined;
}

function serve(path: string, client = false) {
    if (!existsSync(path)) {
        return;
    }
    return sirv(path, {
        etag: true,
        gzip: true,
        brotli: true,
        setHeaders: client
            ? (headers, pathname) => {
                  if (pathname.startsWith(`/${manifest.appDir}/immutable/`)) {
                      headers.set('cache-control', 'public,max-age=31536000,immutable');
                  }
                  return headers;
              }
            : undefined
    });
}

export function create_fetch({
    overrideOrigin,
    hostHeader,
    protocolHeader,
    ipHeader,
    xffDepth
}: FetchOptions) {
    const basePath = get_basepath();
    let getIp: GetIP | undefined = undefined;
    if (ipHeader === 'x-forwarded-for') {
        getIp = (req, fallback) => resolve_xff_ip(req, xffDepth!) ?? fallback;
    } else if (ipHeader) {
        getIp = (req, fallback) => req.headers.get(ipHeader) ?? fallback;
    }
    const resolvers: Resolvers = [];
    const upgrades = new WeakMap<Response, WebSocketHandler>();
    function markUpgrade(response: Response, ws: WebSocketHandler) {
        upgrades.set(response, ws);
        return response;
    }
    if (overrideOrigin) {
        resolvers.push((args) => override_origin(args, new URL(overrideOrigin)));
    } else if (hostHeader || protocolHeader) {
        resolvers.push((args) => override_origin_with_header(args, hostHeader, protocolHeader));
    }
    resolvers.push(({ request }) => serve(join(basePath, '/client'), true)?.(request));
    resolvers.push(({ request }) => serve(join(basePath, '/prerender'))?.(request));
    return (request: Request, srv: Server) => {
        const request_ip = srv.requestIP(request)?.address;
        const try_get_ip = getIp ? () => getIp(request, request_ip) : () => request_ip;
        return first_resolve(request, [
            ...resolvers,
            async (args) => {
                const res = await server.respond(args.request, {
                    getClientAddress() {
                        const ip = try_get_ip();
                        if (ip) return ip;
                        throw new Error('Unable to determine client IP address');
                    },
                    platform: {
                        get originalRequest() {
                            return request;
                        },
                        get bunServer() {
                            return srv;
                        },
                        get markForUpgrade() {
                            return markUpgrade;
                        }
                    } as AdapterPlatform
                });
                if (
                    upgrades.has(res) &&
                    srv.upgrade(request, { headers: res.headers, data: upgrades.get(res) })
                ) {
                    return undefined;
                }
                return res;
            }
        ]);
    };
}
