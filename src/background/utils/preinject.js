import { getUniqId } from '#/common';
import { INJECT_CONTENT, INJECTABLE_TAB_URL_RE, METABLOCK_RE } from '#/common/consts';
import ua from '#/common/ua';
import cache from './cache';
import { getScriptsByURL } from './db';
import { extensionRoot, postInitialize } from './init';
import { getOption, hookOptions } from './options';
import { popupTabs } from './popup-tracker';

const API_CONFIG = {
  urls: ['*://*/*'], // `*` scheme matches only http and https
  types: ['main_frame', 'sub_frame'],
};
const TIME_AFTER_SEND = 10e3; // longer as establishing connection to sites may take time
const TIME_AFTER_RECEIVE = 1e3; // shorter as response body will be coming very soon
const TIME_KEEP_DATA = 60e3; // 100ms should be enough but the tab may hang or get paused in debugger
let injectInto;
hookOptions(changes => {
  injectInto = changes.defaultInjectInto ?? injectInto;
  if ('isApplied' in changes) togglePreinject(changes.isApplied);
});
postInitialize.push(() => {
  injectInto = getOption('defaultInjectInto');
  togglePreinject(getOption('isApplied'));
});

/** @return {Promise<Object>} */
export function getInjectedScripts(url, tabId, frameId) {
  return cache.pop(getKey(url, !frameId)) || prepare(url, tabId, frameId, true);
}

function getKey(url, isTop) {
  return `preinject${+isTop}:${url}`;
}

function togglePreinject(enable) {
  // Using onSendHeaders because onHeadersReceived in Firefox fires *after* content scripts.
  // And even in Chrome a site may be so fast that preinject on onHeadersReceived won't be useful.
  const onOff = `${enable ? 'add' : 'remove'}Listener`;
  const config = enable ? API_CONFIG : undefined;
  browser.webRequest.onSendHeaders[onOff](preinject, config);
  browser.webRequest.onHeadersReceived[onOff](prolong, config);
}

function preinject({ url, tabId, frameId }) {
  if (!INJECTABLE_TAB_URL_RE.test(url)) return;
  const isTop = !frameId;
  const key = getKey(url, isTop);
  if (!cache.has(key)) {
    // GetInjected message will be sent soon by the content script
    // and it may easily happen while getScriptsByURL is still waiting for browser.storage
    // so we'll let GetInjected await this pending data by storing Promise in the cache
    cache.put(key, prepare(url, tabId, frameId), TIME_AFTER_SEND);
  }
}

function prolong({ url, frameId }) {
  cache.hit(getKey(url, !frameId), TIME_AFTER_RECEIVE);
}

async function prepare(url, tabId, frameId, isLate) {
  const data = await getScriptsByURL(url, !frameId);
  const { inject } = data;
  inject.scripts.forEach(prepareScript, data);
  inject.injectInto = injectInto;
  inject.ua = ua;
  inject.isFirefox = ua.isFirefox;
  inject.isPopupShown = popupTabs[tabId];
  if (!isLate && browser.contentScripts) {
    registerScriptDataFF(data, url, !!frameId);
  }
  return data;
}

/** @this data */
function prepareScript(script, index, scripts) {
  const { custom, meta, props } = script;
  const { id } = props;
  const { require, values } = this;
  const code = this.code[id];
  const dataKey = getUniqId('VMin');
  const name = encodeURIComponent(meta.name.replace(/[#&',/:;?@=]/g, replaceWithFullWidthForm));
  const isContent = (custom.injectInto || meta.injectInto || injectInto) === INJECT_CONTENT;
  const pathMap = custom.pathMap || {};
  const reqs = meta.require?.map(key => require[pathMap[key] || key]).filter(Boolean);
  // trying to avoid progressive string concatenation of potentially huge code slices
  // adding `;` on a new line in case some required script ends with a line comment
  const reqsSlices = reqs ? [].concat(...reqs.map(req => [req, '\n;'])) : [];
  const hasReqs = reqsSlices.length;
  const injectedCode = [
    // hiding module interface from @require'd scripts so they don't mistakenly use it
    `window.${dataKey}=function(log){try{with(this)((define,module,exports)=>{`,
    ...reqsSlices,
    // adding a nested IIFE to support 'use strict' in the code when there are @requires
    hasReqs ? '(()=>{' : '',
    // TODO: move code above @require
    code,
    // adding a new line in case the code ends with a line comment
    code.endsWith('\n') ? '' : '\n',
    hasReqs ? '})()' : '',
    // Firefox lists .user.js among our own content scripts so a space at start will group them
    '})()}catch(e){log(e)}}',
    `\n//# sourceURL=${extensionRoot}${ua.isFirefox ? '%20' : ''}${name}.user.js#${id}`,
  ].join('');
  cache.put(dataKey, injectedCode, TIME_KEEP_DATA);
  scripts[index] = {
    ...script,
    dataKey,
    code: isContent ? '' : injectedCode,
    metaStr: code.match(METABLOCK_RE)[1] || '',
    values: values[id],
  };
}

function replaceWithFullWidthForm(s) {
  // fullwidth range starts at 0xFF00, normal range starts at space char code 0x20
  return String.fromCharCode(s.charCodeAt(0) - 0x20 + 0xFF00);
}

function registerScriptDataFF(data, url, allFrames) {
  data.registration = browser.contentScripts.register({
    allFrames,
    js: [{
      code: `resolveData(${JSON.stringify(data.inject)})`,
    }],
    matches: url.split('#', 1),
    runAt: 'document_start',
  });
}
