/*! MIT © Luke Edwards https://github.com/lukeed/sirv/blob/master/packages/sirv/index.js */
import { existsSync, Stats, statSync } from 'fs';
import { lookup as getExt, mimes } from 'mrmime';
import { join, normalize, resolve } from 'path';
import { totalist } from 'totalist/sync';
import exMimes from './mime.conf';

type Arrayable<T> = T | T[];
type NextHandler = () => Response;
type RequestHandler = (req: Request, next?: NextHandler) => Response | undefined;

interface SirvFiles {
    [key: string]: SirvData;
}

interface SirvData {
    abs: string;
    stats: Stats;
    headers: Headers;
}

interface Options {
    dev?: boolean;
    etag?: boolean;
    maxAge?: number;
    immutable?: boolean;
    single?: string | boolean;
    ignores?: false | Arrayable<string | RegExp>;
    extensions?: string[];
    dotFiles?: boolean;
    brotli?: boolean;
    gzip?: boolean;
    setHeaders?: (headers: Headers, pathname: string, stats: Stats) => Headers;
}

// function isMatch(uri, arr) {
//     for (let i = 0; i < arr.length; i++) {
//         if (arr[i].test(uri)) return true;
//     }
// }

function toAssume(uri: string, extns: string[]) {
    const len = uri.length - 1;
    if (uri.charCodeAt(len) === 47) {
        uri = uri.substring(0, len);
    }

    const arr = [];
    const tmp = `${uri}/index`;
    for (let i = 0; i < extns.length; i++) {
        const x = extns[i] ? `.${extns[i]}` : '';
        if (uri) arr.push(uri + x);
        arr.push(tmp + x);
    }

    return arr;
}

function viaCache(cache: SirvFiles, uri: string, extns: string[]) {
    const arr = toAssume(uri, extns);
    for (let i = 0; i < arr.length; i++) {
        const data = cache[arr[i]];
        if (data) {
            return data;
        }
    }
}

function viaLocal(dir: string, isEtag: boolean, uri: string, extns: string[]) {
    const arr = toAssume(uri, extns);
    for (let i = 0; i < arr.length; i++) {
        const name = arr[i];
        const abs = normalize(join(dir, name));
        if (abs.startsWith(dir) && existsSync(abs)) {
            const stats = statSync(abs);
            if (stats.isDirectory()) continue;
            const headers = toHeaders(name, stats, isEtag);
            headers.set('Cache-Control', isEtag ? 'no-cache' : 'no-store');
            return { abs, stats, headers };
        }
    }
}

function send(req: Request, data: SirvData) {
    let code = 200;
    const opts: { start?: number; end?: number; range?: true } = {};

    if (req.headers.has('range')) {
        code = 206;
        let [x, y] = req.headers.get('range')!.replace('bytes=', '').split('-');
        let end = (opts.end = parseInt(y, 10) || data.stats.size - 1);
        let start = (opts.start = parseInt(x, 10) || 0);

        if (start >= data.stats.size || end >= data.stats.size) {
            data.headers.set('Content-Range', `bytes */${data.stats.size}`);
            return new Response(null, {
                headers: data.headers,
                status: 416
            });
        }

        data.headers.set('Content-Range', `bytes ${start}-${end}/${data.stats.size}`);
        data.headers.set('Content-Length', String(end - start + 1));
        data.headers.set('Accept-Ranges', 'bytes');
        opts.range = true;
    }

    if (opts.range) {
        return new Response(Bun.file(data.abs).slice(opts.start, opts.end), {
            headers: data.headers,
            status: code
        });
    }

    return new Response(Bun.file(data.abs), {
        headers: data.headers,
        status: code
    });
}

const ENCODING = {
    '.br': 'br',
    '.gz': 'gzip'
};

function toHeaders(name: string, stats: Stats, isEtag: boolean) {
    const enc = ENCODING[name.slice(-3) as keyof typeof ENCODING];

    let cType = getExt(name.slice(0, enc ? -3 : undefined)) || '';
    if (cType === 'text/html') cType += ';charset=utf-8';

    let headers = new Headers({
        'Content-Length': String(stats.size),
        'Content-Type': cType,
        'Last-Modified': stats.mtime.toUTCString()
    });

    if (enc) headers.set('Content-Encoding', enc);

    if (isEtag) headers.set('ETag', `W/"${stats.size}-${stats.mtime.getTime()}"`);

    return headers;
}

for (const mime in exMimes) {
    mimes[mime] = exMimes[mime];
}

export default function (dir: string, opts: Options = {}): RequestHandler {
    dir = resolve(dir || '.');

    let setHeaders = opts.setHeaders || false;

    let extensions = opts.extensions || ['html', 'htm'];
    let gzips = opts.gzip && extensions.map((x) => `${x}.gz`).concat('gz');
    let brots = opts.brotli && extensions.map((x) => `${x}.br`).concat('br');

    const FILES: SirvFiles = {};

    // let fallback = '/';
    let isEtag = !!opts.etag;
    // let isSPA = !!opts.single;

    // if (typeof opts.single === 'string') {
    //     let idx = opts.single.lastIndexOf('.');
    //     fallback += !!~idx ? opts.single.substring(0, idx) : opts.single;
    // }

    let ignores = [];
    if (opts.ignores !== false) {
        ignores.push(/[/]([A-Za-z\s\d~$._-]+\.\w+){1,}$/); // any extn
        if (opts.dotFiles) ignores.push(/\/\.\w/);
        else ignores.push(/\/\.well-known/);
        ([] as (string | RegExp)[]).concat(opts.ignores || []).forEach((x) => {
            ignores.push(new RegExp(x, 'i'));
        });
    }

    let cc = opts.maxAge != null && `public,max-age=${opts.maxAge}`;
    if (cc && opts.immutable) cc += ',immutable';
    else if (cc && opts.maxAge === 0) cc += ',must-revalidate';

    if (!opts.dev) {
        totalist(dir, (name, abs, stats) => {
            if (/\.well-known[\\+\/]/.test(name)) {
            } // keep
            else if (!opts.dotFiles && /(^\.|[\\+|\/+]\.)/.test(name)) return;

            let headers = toHeaders(name, stats, isEtag);
            if (cc) headers.set('Cache-Control', cc);

            FILES['/' + name.normalize().replace(/\\+/g, '/')] = { abs, stats, headers };
        });
    }

    let lookup: (uri: string, extns: string[]) => SirvData | undefined = opts.dev
        ? viaLocal.bind(0, dir, isEtag)
        : viaCache.bind(0, FILES);

    return function (req: Request) {
        let extns = [''];
        let pathname = new URL(req.url).pathname;
        let val = req.headers.get('accept-encoding') || '';
        if (gzips && val.includes('gzip')) extns.unshift(...gzips);
        if (brots && /(br|brotli)/i.test(val)) extns.unshift(...brots);
        extns.push(...extensions); // [...br, ...gz, orig, ...exts]

        if (pathname.indexOf('%') !== -1) {
            try {
                pathname = decodeURIComponent(pathname);
            } catch (err) {
                /* malform uri */
            }
        }

        // tmp = lookup(pathname, extns)
        // if (!tmp) {
        //     if (isSPA && !isMatch(pathname, ignores)) {
        //         tmp = lookup(fallback, extns)
        //     }
        // }
        let data = lookup(pathname, extns);
        //  || isSPA && !isMatch(pathname, ignores) && lookup(fallback, extns);

        if (!data) return;

        if (isEtag && req.headers.get('if-none-match') === data.headers.get('ETag')) {
            return new Response(null, { status: 304 });
        }

        data = {
            ...data,
            // clone a new headers to prevent the cached one getting modified
            headers: new Headers(data.headers)
        };

        if (gzips || brots) {
            data.headers.append('Vary', 'Accept-Encoding');
        }

        if (setHeaders) {
            data.headers = setHeaders(data.headers, pathname, data.stats);
        }
        return send(req, data);
    };
}
