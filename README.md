# @chtibizoux/sveltekit-adapter-bun

Another sveltekit adapter for bun, an alternative to [svelte-adapter-bun](https://github.com/gornostay25/svelte-adapter-bun). This package support websocket in dev mode with few steps of setup.

## Installation

```shell
bun add -d @chtibizoux/sveltekit-adapter-bun
```

## Start dev server

> [!NOTE]  
> You do not need to do this if you are not using websocket.

run `bun sveltekit-bun` to start a dev server

> [!IMPORTANT]
> This dev server uses bun's internal stuff, so it might break in the future bun version, but the
> production build will not be affected.

## Use the websocket

```typescript
// ./src/app.d.ts
// for the type checking

import type { AdapterPlatform } from '@chtibizoux/sveltekit-adapter-bun';

// See https://kit.svelte.dev/docs/types#app
// for information about these interfaces
declare global {
    namespace App {
        // interface Error {}
        // interface Locals {}
        // interface PageData {}
        // interface PageState {}
        interface Platform extends AdapterPlatform {}
    }
}
```

```typescript
// ./src/routes/echo/+server.ts

export async function GET({ platform }) {
    // can mark any response for upgrade, if the upgrade failed, the response will be sent as is
    return platform!.markForUpgrade(
        new Response('Websocket Requried', {
            status: 400
        }),
        {
            message(ws, message) {
                ws.send(message);
            }
        }
    );
}
```
