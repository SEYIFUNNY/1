import { getScriptName, getUniqId, sendTabCmd, trueJoin } from '@/common';
import {
  INJECT_AUTO, INJECT_CONTENT, INJECT_MAPPING, INJECT_PAGE,
  METABLOCK_RE,
} from '@/common/consts';
import initCache from '@/common/cache';
import { forEachEntry, objectPick, objectSet } from '@/common/object';
import ua from '@/common/ua';
import { getScriptsByURL, ENV_CACHE_KEYS, ENV_REQ_KEYS, ENV_SCRIPTS, ENV_VALUE_IDS } from './db';
import { extensionRoot, postInitialize } from './init';
import { commands } from './message';
import { getOption, hookOptions } from './options';
import { popupTabs } from './popup-tracker';
import { clearRequestsByTabId } from './requests';
import storage from './storage';
import { clearStorageCache, onStorageChanged } from './storage-cache';
import { addValueOpener, clearValueOpener } from './values';

const API_CONFIG = {
  urls: ['*://*/*'], // `*` scheme matches only http and https
  types: ['main_frame', 'sub_frame'],
};
const CSAPI_REG = 'csar';
const contentScriptsAPI = browser.contentScripts;
/** In normal circumstances the data will be removed in ~1sec on use,
 * however connecting may take a long time or the tab may be paused in devtools. */
const TIME_KEEP_DATA = 5 * 60e3;
const cache = initCache({
  lifetime: TIME_KEEP_DATA,
  onDispose: contentScriptsAPI && (async val => {
    if (val) {
      const reg = (val.then ? await val : val)[CSAPI_REG];
      if (reg) (await reg).unregister();
    }
  }),
});
const FEEDBACK = 'feedback';
const HEADERS = 'headers';
const INJECT = 'inject';
const FORCE_CONTENT = 'forceContent';
const INJECT_INTO = 'injectInto';
// KEY_XXX for hooked options
const KEY_EXPOSE = 'expose';
const KEY_DEF_INJECT_INTO = 'defaultInjectInto';
const KEY_IS_APPLIED = 'isApplied';
const KEY_XHR_INJECT = 'xhrInject';
const BAD_URL_CHAR = /[#/?]/g; // will be encoded to avoid splitting the URL in devtools UI
const GRANT_NONE_VARS = '{GM,GM_info,unsafeWindow,cloneInto,createObjectIn,exportFunction}';
const expose = {};
let isApplied;
let injectInto;
let xhrInject;

Object.assign(commands, {
  /** @return {Promise<VM.Injection.Sent>} */
  async GetInjected({ url, forceContent }, src) {
    const { frameId, tab } = src;
    const tabId = tab.id;
    if (!url) url = src.url || tab.url;
    clearFrameData(tabId, frameId);
    const key = getKey(url, !frameId);
    const cacheVal = cache.pop(key) || prepare(key, url, tabId, frameId, forceContent);
    const bag = cacheVal[INJECT] ? cacheVal : await cacheVal;
    const inject = bag[INJECT];
    const feedback = bag[FEEDBACK];
    if (feedback?.length) {
      // Injecting known content scripts without waiting for InjectionFeedback message.
      // Running in a separate task because it may take a long time to serialize data.
      setTimeout(injectionFeedback, 0, { [FEEDBACK]: feedback }, src);
    }
    addValueOpener(tabId, frameId, inject[ENV_SCRIPTS]);
    inject.isPopupShown = popupTabs[tabId];
    return inject;
  },
  InjectionFeedback: injectionFeedback,
});

hookOptions(onOptionChanged);
postInitialize.push(() => {
  for (const key of [KEY_EXPOSE, KEY_DEF_INJECT_INTO, KEY_IS_APPLIED, KEY_XHR_INJECT]) {
    onOptionChanged({ [key]: getOption(key) });
  }
});

async function injectionFeedback({
  feedId,
  [FEEDBACK]: feedback,
  [FORCE_CONTENT]: forceContent,
}, src) {
  feedback.forEach(processFeedback, src);
  if (feedId) {
    // cache cleanup when getDataFF outruns GetInjected
    cache.del(feedId.cacheKey);
    // envDelayed
    const env = await cache.pop(feedId.envKey);
    if (env) {
      env[FORCE_CONTENT] = forceContent;
      env[ENV_SCRIPTS].map(prepareScript, env).filter(Boolean).forEach(processFeedback, src);
      addValueOpener(src.tab.id, src.frameId, env[ENV_SCRIPTS]);
      return objectPick(env, ['cache', ENV_SCRIPTS]);
    }
  }
}

/** @this {chrome.runtime.MessageSender} */
async function processFeedback([key, runAt, unwrappedId]) {
  const code = cache.pop(key);
  // see TIME_KEEP_DATA comment
  if (runAt && code) {
    const { frameId, tab: { id: tabId } } = this;
    runAt = `document_${runAt === 'body' ? 'start' : runAt}`;
    browser.tabs.executeScript(tabId, { code, frameId, runAt });
    if (unwrappedId) sendTabCmd(tabId, 'Run', unwrappedId, { frameId });
  }
}

const propsToClear = {
  [storage.cache.prefix]: ENV_CACHE_KEYS,
  [storage.code.prefix]: true,
  [storage.require.prefix]: ENV_REQ_KEYS,
  [storage.script.prefix]: true,
  [storage.value.prefix]: ENV_VALUE_IDS,
};

onStorageChanged(async ({ keys: dbKeys }) => {
  const raw = cache.getValues();
  const resolved = !raw.some(val => val?.then);
  const cacheValues = resolved ? raw : await Promise.all(raw);
  const dirty = cacheValues.some(bag => bag[INJECT]
    && dbKeys.some((key) => {
      const prefix = key.slice(0, key.indexOf(':') + 1);
      const prop = propsToClear[prefix];
      key = key.slice(prefix.length);
      return prop === true
        || bag[prop]?.includes(prefix === storage.value.prefix ? +key : key);
    }));
  if (dirty) {
    cache.destroy();
  }
});

function normalizeRealm(value) {
  return INJECT_MAPPING::hasOwnProperty(value)
    ? value
    : injectInto || INJECT_AUTO;
}

function onOptionChanged(changes) {
  changes::forEachEntry(([key, value]) => {
    switch (key) {
    case KEY_DEF_INJECT_INTO:
      injectInto = normalizeRealm(value);
      cache.destroy();
      break;
    case KEY_XHR_INJECT:
      toggleXhrInject(value);
      cache.destroy();
      break;
    case KEY_IS_APPLIED:
      togglePreinject(value);
      break;
    case KEY_EXPOSE:
      value::forEachEntry(([site, isExposed]) => {
        expose[decodeURIComponent(site)] = isExposed;
      });
      break;
    default:
      if (key.includes('.')) { // used by `expose.url`
        onOptionChanged(objectSet({}, key, value));
      }
    }
  });
}

function getKey(url, isTop) {
  return isTop ? url : `-${url}`;
}

function togglePreinject(enable) {
  isApplied = enable;
  // Using onSendHeaders because onHeadersReceived in Firefox fires *after* content scripts.
  // And even in Chrome a site may be so fast that preinject on onHeadersReceived won't be useful.
  const onOff = `${enable ? 'add' : 'remove'}Listener`;
  const config = enable ? API_CONFIG : undefined;
  browser.webRequest.onSendHeaders[onOff](onSendHeaders, config);
  if (!isApplied || !xhrInject) { // will be registered in toggleXhrInject
    browser.webRequest.onHeadersReceived[onOff](onHeadersReceived, config);
  }
  browser.tabs.onRemoved[onOff](onTabRemoved);
  browser.tabs.onReplaced[onOff](onTabReplaced);
  if (!enable) {
    cache.destroy();
    clearFrameData();
    clearStorageCache();
  }
}

function toggleXhrInject(enable) {
  xhrInject = enable;
  browser.webRequest.onHeadersReceived.removeListener(onHeadersReceived);
  if (enable) {
    browser.webRequest.onHeadersReceived.addListener(onHeadersReceived, API_CONFIG, [
      'blocking',
      'responseHeaders',
      browser.webRequest.OnHeadersReceivedOptions.EXTRA_HEADERS,
    ].filter(Boolean));
  }
}

function onSendHeaders({ url, tabId, frameId }) {
  const isTop = !frameId;
  const key = getKey(url, isTop);
  if (!cache.has(key)) {
    // GetInjected message will be sent soon by the content script
    // and it may easily happen while getScriptsByURL is still waiting for browser.storage
    // so we'll let GetInjected await this pending data by storing Promise in the cache
    cache.put(key, prepare(key, url, tabId, frameId), TIME_KEEP_DATA);
  }
}

/** @param {chrome.webRequest.WebResponseHeadersDetails} info */
function onHeadersReceived(info) {
  const key = getKey(info.url, !info.frameId);
  const bag = xhrInject && cache.get(key);
  // Proceeding only if prepareScripts has replaced promise in cache with the actual data
  return bag?.[INJECT] && prepareXhrBlob(info, bag);
}

/**
 * @param {chrome.webRequest.WebResponseHeadersDetails} info
 * @param {VM.Injection.Bag} bag
 */
function prepareXhrBlob({ url, responseHeaders }, bag) {
  if (url.startsWith('https:') && detectStrictCsp(responseHeaders)) {
    forceContentInjection(bag);
  }
  const blobUrl = URL.createObjectURL(new Blob([
    JSON.stringify(bag[INJECT]),
  ]));
  responseHeaders.push({
    name: 'Set-Cookie',
    value: `"${process.env.INIT_FUNC_NAME}"=${blobUrl.split('/').pop()}; SameSite=Lax`,
  });
  setTimeout(URL.revokeObjectURL, TIME_KEEP_DATA, blobUrl);
  bag[HEADERS] = true;
  return { responseHeaders };
}

function prepare(key, url, tabId, frameId, forceContent) {
  /** @type {VM.Injection.Bag} */
  const res = {
    [INJECT]: {
      expose: !frameId
        && url.startsWith('https://')
        && expose[url.split('/', 3)[2]],
    },
  };
  return isApplied
    ? prepareScripts(res, key, url, tabId, frameId, forceContent)
    : res;
}

/**
 * @param {VM.Injection.Bag} res
 * @param cacheKey
 * @param url
 * @param tabId
 * @param frameId
 * @param forceContent
 * @return {Promise<any>}
 */
async function prepareScripts(res, cacheKey, url, tabId, frameId, forceContent) {
  const bag = getScriptsByURL(url, !frameId);
  const { envDelayed, [ENV_SCRIPTS]: scripts } = Object.assign(bag, await bag.promise);
  const isLate = forceContent != null;
  bag[FORCE_CONTENT] = forceContent; // used in prepareScript and isPageRealm
  const feedback = scripts.map(prepareScript, bag).filter(Boolean);
  const more = envDelayed.promise;
  const envKey = getUniqId(`${tabId}:${frameId}:`);
  /** @type {VM.Injection.Sent} */
  const inject = res[INJECT];
  Object.assign(inject, {
    [ENV_SCRIPTS]: scripts,
    [INJECT_INTO]: injectInto,
    [INJECT_PAGE]: !forceContent && (
      scripts.some(isPageRealm, bag)
      || envDelayed[ENV_SCRIPTS].some(isPageRealm, bag)
    ),
    cache: bag.cache,
    feedId: {
      cacheKey, // InjectionFeedback cache key for cleanup when getDataFF outruns GetInjected
      envKey, // InjectionFeedback cache key for envDelayed
    },
    hasMore: !!more, // tells content bridge to expect envDelayed
    ids: bag.disabledIds, // content bridge adds the actually running ids and sends via SetPopup
    info: {
      ua,
    },
  });
  res[FEEDBACK] = feedback;
  res[CSAPI_REG] = contentScriptsAPI && !isLate && !xhrInject
    && registerScriptDataFF(inject, url, !!frameId);
  if (more) cache.put(envKey, more);
  if (!isLate && !cache.get(cacheKey)?.headers) {
    cache.put(cacheKey, res); // synchronous onHeadersReceived needs plain object not a Promise
  }
  return res;
}

/** @this {VM.Injection.Env} */
function prepareScript(script) {
  const { custom, meta, props } = script;
  const { id } = props;
  const { [FORCE_CONTENT]: forceContent, require, value } = this;
  const code = this.code[id];
  const dataKey = getUniqId('VMin');
  const displayName = getScriptName(script);
  const name = encodeURIComponent(displayName.replace(BAD_URL_CHAR, replaceWithFullWidthForm));
  const isContent = isContentRealm(script, forceContent);
  const pathMap = custom.pathMap || {};
  const reqs = meta.require.map(key => require[pathMap[key] || key]).filter(Boolean);
  // trying to avoid progressive string concatenation of potentially huge code slices
  // adding `;` on a new line in case some required script ends with a line comment
  const reqsSlices = reqs ? [].concat(...reqs.map(req => [req, '\n;'])) : [];
  const hasReqs = reqsSlices.length;
  const wrap = !meta.unwrap;
  const { grant } = meta;
  const numGrants = grant.length;
  const grantNone = !numGrants || numGrants === 1 && grant[0] === 'none';
  const injectedCode = [
    wrap && `window.${dataKey}=function(${
      // using a shadowed name to avoid scope pollution
      grantNone ? GRANT_NONE_VARS : 'GM'}${
      IS_FIREFOX ? `,${dataKey}){try{` : '){'}${
      grantNone ? '' : 'with(this)with(c)delete c,'
    // hiding module interface from @require'd scripts so they don't mistakenly use it
    }((define,module,exports)=>{`,
    ...reqsSlices,
    // adding a nested IIFE to support 'use strict' in the code when there are @requires
    hasReqs && wrap && '(()=>{',
    code,
    // adding a new line in case the code ends with a line comment
    !code.endsWith('\n') && '\n',
    hasReqs && wrap && '})()',
    wrap && `})()${IS_FIREFOX ? `}catch(e){${dataKey}(e)}` : ''}}`,
    // 0 at the end to suppress errors about non-cloneable result of executeScript in FF
    IS_FIREFOX && ';0',
    // Firefox lists .user.js among our own content scripts so a space at start will group them
    `\n//# sourceURL=${extensionRoot}${IS_FIREFOX ? '%20' : ''}${name}.user.js#${id}`,
  ]::trueJoin('');
  cache.put(dataKey, injectedCode, TIME_KEEP_DATA);
  /** @type {VM.Injection.Script} */
  Object.assign(script, {
    dataKey,
    displayName,
    // code will be `true` if the desired realm is PAGE which is not injectable
    code: isContent ? '' : forceContent || injectedCode,
    metaStr: code.match(METABLOCK_RE)[1] || '',
    values: value[id] || null,
  });
  return isContent && [
    dataKey,
    script.runAt,
    !wrap && id, // unwrapped scripts need an explicit `Run` message
  ];
}

function replaceWithFullWidthForm(s) {
  // fullwidth range starts at 0xFF00, normal range starts at space char code 0x20
  return String.fromCharCode(s.charCodeAt(0) - 0x20 + 0xFF00);
}

const resolveDataCodeStr = `(${function _(data) {
  /* `function` is required to compile `this`, and `this` is required because our safe-globals
   * shadows `window` so its name is minified and hence inaccessible here */
  const { vmResolve } = this;
  if (vmResolve) {
    vmResolve(data);
  } else {
    // running earlier than the main content script for whatever reason
    this.vmData = data;
  }
}})`;

// TODO: rework the whole thing to register scripts individually with real `matches`
function registerScriptDataFF(inject, url, allFrames) {
  return contentScriptsAPI.register({
    allFrames,
    js: [{
      code: `${resolveDataCodeStr}(${JSON.stringify(inject)})`,
    }],
    matches: url.split('#', 1),
    runAt: 'document_start',
  });
}

/** @param {chrome.webRequest.HttpHeader[]} responseHeaders */
function detectStrictCsp(responseHeaders) {
  return responseHeaders.some(({ name, value }) => (
    /^content-security-policy$/i.test(name)
    && /^.(?!.*'unsafe-inline')/.test( // true if not empty and without 'unsafe-inline'
      value.match(/(?:^|;)\s*script-src-elem\s[^;]+/)
      || value.match(/(?:^|;)\s*script-src\s[^;]+/)
      || value.match(/(?:^|;)\s*default-src\s[^;]+/)
      || '',
    )
  ));
}

/** @param {VM.Injection.Bag} bag */
function forceContentInjection(bag) {
  const inject = bag[INJECT];
  inject[FORCE_CONTENT] = true;
  inject[ENV_SCRIPTS].forEach(scr => {
    // When script wants `page`, the result below will be `true` so the script goes into `failedIds`
    scr.code = !isContentRealm(scr, true) || '';
    bag[FEEDBACK].push([scr.dataKey, true]);
  });
}

function isContentRealm(scr, forceContent) {
  const realm = scr[INJECT_INTO] || (
    scr[INJECT_INTO] = normalizeRealm(scr.custom[INJECT_INTO] || scr.meta[INJECT_INTO])
  );
  return realm === INJECT_CONTENT || forceContent && realm === INJECT_AUTO;
}

/** @this {VM.Injection.Env} */
function isPageRealm(scr) {
  return !isContentRealm(scr, this[FORCE_CONTENT]);
}

function onTabRemoved(id /* , info */) {
  clearFrameData(id);
}

function onTabReplaced(addedId, removedId) {
  clearFrameData(removedId);
}

function clearFrameData(tabId, frameId) {
  clearRequestsByTabId(tabId, frameId);
  clearValueOpener(tabId, frameId);
}
