declare module 'SERVER' {
    import { Server as BunServer } from 'bun';
    import { CAC } from 'cac';
    export { MaybePromise, Server } from '@sveltejs/kit';
    export function get_hooks(): Promise<{
        setupCLI?: (cac: CAC) => MaybePromise<void>;
        beforeServe?: (options: any) => MaybePromise<void>;
        afterServe?: (server: BunServer, options: any) => MaybePromise<void>;
    }>;
}

declare module 'MANIFEST' {
    import { SSRManifest } from '@sveltejs/kit';
    export const manifest: SSRManifest;
}
