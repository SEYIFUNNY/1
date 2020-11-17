import {
  INJECT_AUTO,
  INJECT_CONTENT,
  INJECT_MAPPING,
  INJECT_PAGE,
  browser,
} from '#/common/consts';
import { sendCmd } from '#/common';
import { defineProperty, describeProperty, forEachEntry, objectPick } from '#/common/object';

import {
  forEach, push,
  append, createElementNS, remove, NS_HTML,
  addEventListener, removeEventListener,
  log,
} from '../utils/helpers';
import bridge from './bridge';

// Firefox bug: https://bugzilla.mozilla.org/show_bug.cgi?id=1408996
const VMInitInjection = window[process.env.INIT_FUNC_NAME];
// To avoid running repeatedly due to new `document.documentElement`
// (the prop is undeletable so a userscript can't fool us on reinjection)
defineProperty(window, process.env.INIT_FUNC_NAME, { value: 1 });

const { document, setTimeout } = global;
// Userscripts in content mode may redefine head and documentElement
const { get: getHead } = describeProperty(Document.prototype, 'head')
  || describeProperty(HTMLDocument.prototype, 'head'); // old FF before 61;
const { get: getDocElem } = describeProperty(Document.prototype, 'documentElement');
const { appendChild } = Document.prototype; // same as Node.appendChild
const stringIncludes = String.prototype.includes;

bridge.addHandlers({
  // FF bug workaround to enable processing of sourceURL in injected page scripts
  InjectList(runAt) {
    bridge.realms[INJECT_PAGE].lists[runAt]::forEach(inject);
  },
});

export function appendToRoot(node) {
  // DOM spec allows any elements under documentElement
  // https://dom.spec.whatwg.org/#node-trees
  const root = document::getHead() || document::getDocElem();
  return root && root::appendChild(node);
}

export function injectPageSandbox(contentId, webId) {
  inject({
    code: `(${VMInitInjection}())('${webId}','${contentId}')\n//# sourceURL=${
      browser.runtime.getURL('sandbox/injected-web.js')
    }`,
  });
}

export function injectScripts(contentId, webId, data, isXml) {
  bridge.ids = data.ids;
  // eslint-disable-next-line prefer-rest-params
  if (!document::getDocElem()) return waitForDocElem(() => injectScripts(...arguments));
  let injectable = isXml ? false : null;
  const bornReady = ['interactive', 'complete'].includes(document.readyState);
  const INFO = objectPick(data, ['cache', 'isFirefox', 'ua']);
  const realms = {
    [INJECT_CONTENT]: {
      injectable: () => true,
      lists: { start: [], end: [], idle: [] },
      ids: [],
      info: INFO,
    },
    [INJECT_PAGE]: {
      // eslint-disable-next-line no-return-assign
      injectable: () => injectable ?? (injectable = checkInjectable()),
      lists: { start: [], end: [], idle: [] },
      ids: [],
      info: INFO,
    },
  };
  const triage = (script) => {
    const { custom, dataKey, meta, props: { id } } = script;
    const desiredRealm = custom.injectInto || meta.injectInto || data.injectInto;
    const internalRealm = INJECT_MAPPING[desiredRealm] || INJECT_MAPPING[INJECT_AUTO];
    const realm = internalRealm.find(key => realms[key]?.injectable());
    let needsInjection;
    // If the script wants this specific realm, which is unavailable, we won't inject it at all
    if (realm) {
      const { ids, lists } = realms[realm];
      let runAt = bornReady ? 'start'
        : `${custom.runAt || meta.runAt || ''}`.replace(/^document-/, '');
      const list = lists[runAt] || lists[runAt = 'end'];
      script.action = realm === INJECT_CONTENT && (runAt === 'start' ? runAt : 'wait');
      needsInjection = !!script.action;
      ids::push(id);
      list::push(script);
    } else {
      bridge.failedIds.push(id);
    }
    return [dataKey, needsInjection];
  };
  const feedback = data.scripts.map(triage);
  setupContentInvoker(realms, contentId, webId);
  sendCmd('InjectionFeedback', feedback);
  injectAll(realms, 'start');
  if (!bornReady && realms[INJECT_PAGE].ids.length) {
    delete realms[INJECT_CONTENT];
    document.addEventListener('DOMContentLoaded', async () => {
      await 0;
      injectAll(realms, 'end');
      setTimeout(injectAll, 0, realms, 'idle');
    }, { once: true });
  } else {
    bridge.realms = null;
  }
}

function checkInjectable() {
  let res = false;
  bridge.addHandlers({
    Pong() {
      res = true;
    },
  });
  bridge.post('Ping');
  return res;
}

function inject(item) {
  const script = document::createElementNS(NS_HTML, 'script');
  // Firefox ignores sourceURL comment when a syntax error occurs so we'll print the name manually
  let onError;
  if (bridge.isFirefox) {
    onError = e => {
      const { stack } = e.error;
      if (typeof stack === 'string' && stack::stringIncludes(browser.runtime.getURL('/sandbox'))) {
        log('error', [item.meta.name], e.error);
        e.preventDefault();
      }
    };
    window::addEventListener('error', onError);
  }
  // using a safe call to an existing method so we don't have to extract textContent setter
  script::append(item.code);
  // When using declarativeContent there's no documentElement so we'll append to `document`
  if (!appendToRoot(script)) document::appendChild(script);
  if (onError) window::removeEventListener('error', onError);
  script::remove();
}

function injectAll(realms, runAt) {
  bridge.realms = realms;
  realms::forEachEntry(([realm, realmData]) => {
    const isPage = realm === INJECT_PAGE;
    realmData.lists::forEachEntry(([name, items]) => {
      if ((!isPage || name === runAt) && items.length) {
        bridge.post('ScriptData', { items, runAt, info: realmData.info }, realm);
        realmData.info = undefined;
        items::forEach(item => {
          // FF bug workaround to enable processing of sourceURL in injected page scripts
          if (isPage && !bridge.isFirefox) inject(item);
          item.code = '';
        });
      }
    });
  });
  if (runAt === 'idle') {
    bridge.realms = null;
  }
}

function setupContentInvoker(realms, contentId, webId) {
  const invokableIds = realms[INJECT_CONTENT].ids;
  if (invokableIds.length) {
    const invoke = {
      [INJECT_CONTENT]: VMInitInjection()(webId, contentId, bridge.onHandle),
    };
    const postViaBridge = bridge.post;
    bridge.invokableIds = invokableIds;
    bridge.post = (cmd, params, realm) => (invoke[realm] || postViaBridge)(cmd, params);
  }
}

function waitForDocElem(cb) {
  const observer = new MutationObserver(() => {
    if (document::getDocElem()) {
      observer.disconnect();
      cb();
    }
  });
  observer.observe(document, { childList: true });
}
