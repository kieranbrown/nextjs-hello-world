// @ts-nocheck

/*
 * This file is a copy paste from the patched fetch made by nextjs. We maintain the normal fetch and create
 * a wrapper around it to match the API design from the patched fetch so we can use next/cache...
 */

import { StaticGenerationAsyncStorage } from "next/dist/client/components/static-generation-async-storage";
import { DynamicServerError } from "next/dist/client/components/hooks-server-context";
import { decode } from "./base64array-buffer";
export { staticGenerationAsyncStorage } from "next/dist/client/components/static-generation-async-storage";

const CACHE_ONE_YEAR = 31536000;

// we're on cloudflare :D
const isEdgeRuntime = true;

// We get the AsyncStorage from the patched fetch :)
//@ts-ignore
/*   const staticGenerationStore = fetch.__nextGetStaticStore();
  staticGenerationStore.incrementalCache = (globalThis as any).__incrementalCache; */

function addImplicitTags(
  staticGenerationStore: ReturnType<StaticGenerationAsyncStorage["getStore"]>
) {
  const newTags: string[] = [];
  const pathname = staticGenerationStore?.originalPathname;
  if (!pathname) {
    return newTags;
  }

  if (!Array.isArray(staticGenerationStore.tags)) {
    staticGenerationStore.tags = [];
  }
  if (!staticGenerationStore.tags.includes(pathname)) {
    staticGenerationStore.tags.push(pathname);
  }
  newTags.push(pathname);
  return newTags;
}

function trackFetchMetric(
  staticGenerationStore: ReturnType<StaticGenerationAsyncStorage["getStore"]>,
  ctx: {
    url: string;
    status: number;
    method: string;
    cacheReason: string;
    cacheStatus: "hit" | "miss";
    start: number;
  }
) {
  if (!staticGenerationStore) return;
  if (!staticGenerationStore.fetchMetrics) {
    staticGenerationStore.fetchMetrics = [];
  }
  const dedupeFields = ["url", "status", "method"];

  // don't add metric if one already exists for the fetch
  if (
    staticGenerationStore.fetchMetrics.some((metric) => {
      return dedupeFields.every(
        (field) => (metric as any)[field] === (ctx as any)[field]
      );
    })
  ) {
    return;
  }
  staticGenerationStore.fetchMetrics.push({
    url: ctx.url,
    cacheStatus: ctx.cacheStatus,
    status: ctx.status,
    method: ctx.method,
    start: ctx.start,
    end: Date.now(),
    idx: staticGenerationStore.nextFetchId || 0,
  });
}

export async function nextFetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined
) {
  let url: URL | undefined;
  try {
    url = new URL(input instanceof Request ? input.url : input);
    url.username = "";
    url.password = "";
  } catch {
    // Error caused by malformed URL should be handled by native fetch
    url = undefined;
  }
  const fetchUrl = url?.href ?? "";
  const fetchStart = Date.now();
  const method = init?.method?.toUpperCase() || "GET";

  const originFetch: typeof fetch = (globalThis as any)._nextOriginalFetch

  // We get the AsyncStorage from the patched fetch :)
  //@ts-ignore
  const staticGenerationStore = fetch.__nextGetStaticStore();
  staticGenerationStore.incrementalCache = (
    globalThis as any
  ).__incrementalCache;
  const isRequestInput =
    input &&
    typeof input === "object" &&
    typeof (input as Request).method === "string";

  const getRequestMeta = (field: string) => {
    let value = isRequestInput ? (input as any)[field] : null;
    return value || (init as any)?.[field];
  };

  // If the staticGenerationStore is not available, we can't do any
  // special treatment of fetch, therefore fallback to the original
  // fetch implementation.
  if (!staticGenerationStore || (init?.next as any)?.internal) {
    return fetch(input, init);
  }

  let revalidate: number | undefined | false = undefined;
  const getNextField = (field: "revalidate" | "tags") => {
    return typeof init?.next?.[field] !== "undefined"
      ? init?.next?.[field]
      : isRequestInput
      ? (input as any).next?.[field]
      : undefined;
  };
  // RequestInit doesn't keep extra fields e.g. next so it's
  // only available if init is used separate
  let curRevalidate = getNextField("revalidate");
  const tags: string[] = getNextField("tags") || [];

  if (Array.isArray(tags)) {
    if (!staticGenerationStore.tags) {
      staticGenerationStore.tags = [];
    }
    for (const tag of tags) {
      if (!staticGenerationStore.tags.includes(tag)) {
        staticGenerationStore.tags.push(tag);
      }
    }
  }
  const implicitTags = addImplicitTags(staticGenerationStore);

  for (const tag of implicitTags || []) {
    if (!tags.includes(tag)) {
      tags.push(tag);
    }
  }
  const isOnlyCache = staticGenerationStore.fetchCache === "only-cache";
  const isForceCache = staticGenerationStore.fetchCache === "force-cache";
  const isDefaultCache = staticGenerationStore.fetchCache === "default-cache";
  const isDefaultNoStore =
    staticGenerationStore.fetchCache === "default-no-store";
  const isOnlyNoStore = staticGenerationStore.fetchCache === "only-no-store";
  const isForceNoStore = staticGenerationStore.fetchCache === "force-no-store";

  let _cache = getRequestMeta("cache");

  if (typeof _cache === "string" && typeof curRevalidate !== "undefined") {
    console.warn(
      `Warning: fetch for ${fetchUrl} on ${staticGenerationStore.pathname} specified "cache: ${_cache}" and "revalidate: ${curRevalidate}", only one should be specified.`
    );
    _cache = undefined;
  }

  if (_cache === "force-cache") {
    curRevalidate = false;
  }
  if (["no-cache", "no-store"].includes(_cache || "")) {
    curRevalidate = 0;
  }
  if (typeof curRevalidate === "number" || curRevalidate === false) {
    revalidate = curRevalidate;
  }

  let cacheReason = "";
  const _headers = getRequestMeta("headers");
  const initHeaders: Headers =
    typeof _headers?.get === "function"
      ? _headers
      : new Headers(_headers || {});

  const hasUnCacheableHeader =
    initHeaders.get("authorization") || initHeaders.get("cookie");

  const isUnCacheableMethod = !["get", "head"].includes(
    getRequestMeta("method")?.toLowerCase() || "get"
  );

  // if there are authorized headers or a POST method and
  // dynamic data usage was present above the tree we bail
  // e.g. if cookies() is used before an authed/POST fetch
  const autoNoCache =
    (hasUnCacheableHeader || isUnCacheableMethod) &&
    staticGenerationStore.revalidate === 0;

  if (isForceNoStore) {
    revalidate = 0;
    cacheReason = "fetchCache = force-no-store";
  }

  if (isOnlyNoStore) {
    if (_cache === "force-cache" || revalidate === 0) {
      throw new Error(
        `cache: 'force-cache' used on fetch for ${fetchUrl} with 'export const fetchCache = 'only-no-store'`
      );
    }
    revalidate = 0;
    cacheReason = "fetchCache = only-no-store";
  }

  if (isOnlyCache && _cache === "no-store") {
    throw new Error(
      `cache: 'no-store' used on fetch for ${fetchUrl} with 'export const fetchCache = 'only-cache'`
    );
  }

  if (
    isForceCache &&
    (typeof curRevalidate === "undefined" || curRevalidate === 0)
  ) {
    cacheReason = "fetchCache = force-cache";
    revalidate = false;
  }

  if (typeof revalidate === "undefined") {
    if (isDefaultCache) {
      revalidate = false;
      cacheReason = "fetchCache = default-cache";
    } else if (autoNoCache) {
      revalidate = 0;
      cacheReason = "auto no cache";
    } else if (isDefaultNoStore) {
      revalidate = 0;
      cacheReason = "fetchCache = default-no-store";
    } else {
      cacheReason = "auto cache";
      revalidate =
        typeof staticGenerationStore.revalidate === "boolean" ||
        typeof staticGenerationStore.revalidate === "undefined"
          ? false
          : staticGenerationStore.revalidate;
    }
  } else if (!cacheReason) {
    cacheReason = `revalidate: ${revalidate}`;
  }

  if (
    // we don't consider autoNoCache to switch to dynamic during
    // revalidate although if it occurs during build we do
    !autoNoCache &&
    (typeof staticGenerationStore.revalidate === "undefined" ||
      (typeof revalidate === "number" &&
        (staticGenerationStore.revalidate === false ||
          (typeof staticGenerationStore.revalidate === "number" &&
            revalidate < staticGenerationStore.revalidate))))
  ) {
    staticGenerationStore.revalidate = revalidate;
  }

  const isCacheableRevalidate =
    (typeof revalidate === "number" && revalidate > 0) || revalidate === false;

  let cacheKey: string | undefined;
  if (staticGenerationStore.incrementalCache && isCacheableRevalidate) {
    try {
      cacheKey = await staticGenerationStore.incrementalCache.fetchCacheKey(
        fetchUrl,
        isRequestInput ? (input as RequestInit) : init
      );
    } catch (err) {
      console.error(`Failed to generate cache key for`, input);
    }
  }
  const requestInputFields = [
    "cache",
    "credentials",
    "headers",
    "integrity",
    "keepalive",
    "method",
    "mode",
    "redirect",
    "referrer",
    "referrerPolicy",
    "signal",
    "window",
    "duplex",
  ];

  if (isRequestInput) {
    const reqInput: Request = input as any;
    const reqOptions: RequestInit = {
      body: (reqInput as any)._ogBody || reqInput.body,
    };

    for (const field of requestInputFields) {
      reqOptions[field] = reqInput[field];
    }
    input = new Request(reqInput.url, reqOptions);
  } else if (init) {
    const initialInit = init;
    init = {
      body: (init as any)._ogBody || init.body,
    };
    for (const field of requestInputFields) {
      init[field] = initialInit[field];
    }
  }

  const fetchIdx = staticGenerationStore.nextFetchId ?? 1;
  staticGenerationStore.nextFetchId = fetchIdx + 1;

  const normalizedRevalidate =
    typeof revalidate !== "number" ? CACHE_ONE_YEAR : revalidate;

  const doOriginalFetch = async (isStale?: boolean) => {
    // add metadata to init without editing the original
    const clonedInit = {
      ...init,
      next: { ...init?.next, fetchType: "origin", fetchIdx },
    };
    delete clonedInit.cache

    return originFetch(input, clonedInit).then(async (res) => {
      if (!isStale) {
        trackFetchMetric(staticGenerationStore, {
          start: fetchStart,
          url: fetchUrl,
          cacheReason,
          cacheStatus: "miss",
          status: res.status,
          method: clonedInit.method || "GET",
        });
      }
      if (
        res.status === 200 &&
        staticGenerationStore.incrementalCache &&
        cacheKey &&
        isCacheableRevalidate
      ) {
        const bodyBuffer = Buffer.from(await res.arrayBuffer());

        try {
          await staticGenerationStore.incrementalCache.set(
            cacheKey,
            {
              kind: "FETCH",
              data: {
                headers: Object.fromEntries(res.headers.entries()),
                body: bodyBuffer.toString("base64"),
                status: res.status,
                tags,
              },
              revalidate: normalizedRevalidate,
            },
            revalidate,
            true,
            fetchUrl,
            fetchIdx
          );
        } catch (err) {
          console.warn(`Failed to set fetch cache`, input, err);
        }

        return new Response(bodyBuffer, {
          headers: new Headers(res.headers),
          status: res.status,
        });
      }
      return res;
    });
  };

  if (cacheKey && staticGenerationStore?.incrementalCache) {
    const entry = staticGenerationStore.isOnDemandRevalidate
      ? null
      : await staticGenerationStore.incrementalCache.get(
          cacheKey,
          true,
          revalidate,
          fetchUrl,
          fetchIdx
        );

    if (entry?.value && entry.value.kind === "FETCH") {
      const currentTags = entry.value.data.tags;
      // when stale and is revalidating we wait for fresh data
      // so the revalidated entry has the updated data
      if (!(staticGenerationStore.isRevalidate && entry.isStale)) {
        if (entry.isStale) {
          if (!staticGenerationStore.pendingRevalidates) {
            staticGenerationStore.pendingRevalidates = [];
          }
          staticGenerationStore.pendingRevalidates.push(
            doOriginalFetch(true).catch(console.error)
          );
        } else if (tags && !tags.every((tag) => currentTags?.includes(tag))) {
          // if new tags are being added we need to set even if
          // the data isn't stale
          if (!entry.value.data.tags) {
            entry.value.data.tags = [];
          }

          for (const tag of tags) {
            if (!entry.value.data.tags.includes(tag)) {
              entry.value.data.tags.push(tag);
            }
          }
          staticGenerationStore.incrementalCache?.set(
            cacheKey,
            entry.value,
            revalidate,
            true,
            fetchUrl,
            fetchIdx
          );
        }

        const resData = entry.value.data;
        let decodedBody: ArrayBuffer;

        decodedBody = decode(resData.body);

        trackFetchMetric(staticGenerationStore, {
          start: fetchStart,
          url: fetchUrl,
          cacheReason,
          cacheStatus: "hit",
          status: resData.status || 200,
          method: init?.method || "GET",
        });

        return new Response(decodedBody, {
          headers: resData.headers,
          status: resData.status,
        });
      }
    }
  }

  if (staticGenerationStore.isStaticGeneration) {
    if (init && typeof init === "object") {
      const cache = init.cache;
      // Delete `cache` property as Cloudflare Workers will throw an error
      if (isEdgeRuntime) {
        delete init.cache;
      }
      if (cache === "no-store") {
        staticGenerationStore.revalidate = 0;
        // TODO: ensure this error isn't logged to the user
        // seems it's slipping through currently
        const dynamicUsageReason = `no-store fetch ${input}${
          staticGenerationStore.pathname
            ? ` ${staticGenerationStore.pathname}`
            : ""
        }`;
        const err = new DynamicServerError(dynamicUsageReason);
        staticGenerationStore.dynamicUsageStack = err.stack;
        staticGenerationStore.dynamicUsageDescription = dynamicUsageReason;

        throw err;
      }

      const hasNextConfig = "next" in init;
      const next = init.next || {};
      if (
        typeof next.revalidate === "number" &&
        (typeof staticGenerationStore.revalidate === "undefined" ||
          next.revalidate < staticGenerationStore.revalidate)
      ) {
        const forceDynamic = staticGenerationStore.forceDynamic;

        if (!forceDynamic || next.revalidate !== 0) {
          staticGenerationStore.revalidate = next.revalidate;
        }

        if (!forceDynamic && next.revalidate === 0) {
          const dynamicUsageReason = `revalidate: ${
            next.revalidate
          } fetch ${input}${
            staticGenerationStore.pathname
              ? ` ${staticGenerationStore.pathname}`
              : ""
          }`;
          const err = new DynamicServerError(dynamicUsageReason);
          staticGenerationStore.dynamicUsageStack = err.stack;
          staticGenerationStore.dynamicUsageDescription = dynamicUsageReason;

          throw err;
        }
      }
      if (hasNextConfig) delete init.next;
    }
  }

  return await doOriginalFetch();
}
