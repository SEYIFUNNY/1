import bridge, { addBackgroundHandlers, addHandlers } from './bridge';
import { decodeResource, elemByTag, makeElem, nextTask, sendCmd } from './util';

const menus = createNullObj();
let setPopupThrottle;
let isPopupShown;

addBackgroundHandlers({
  PopupShown(state) {
    isPopupShown = state;
    sendSetPopup();
  },
}, true);

addHandlers({
  /** @this {Node} */
  AddElement({ tag, attrs, cbId }, realm) {
    let el;
    let res;
    try {
      const parent = this
        || /^(script|style|link|meta)$/i::regexpTest(tag) && elemByTag('head')
        || elemByTag('body')
        || elemByTag('*');
      el = makeElem(tag, attrs);
      parent::appendChild(el);
    } catch (e) {
      // A page-mode userscript can't catch DOM errors in a content script so we pass it explicitly
      // TODO: maybe move try/catch to bridge.onHandle and use bridge.sendSync in all web commands
      res = [`${e}`, e.stack];
    }
    bridge.post('Callback', { id: cbId, data: res }, realm, el);
  },

  GetResource({ id, isBlob, key, raw }) {
    if (!raw) raw = bridge.cache[bridge.pathMaps[id]?.[key] || key];
    return raw ? decodeResource(raw, isBlob) : true;
  },

  RegisterMenu({ id, cap }) {
    if (IS_TOP) {
      ensureNestedProp(menus, id, cap, 1);
      sendSetPopup(true);
    }
  },

  UnregisterMenu({ id, cap }) {
    if (IS_TOP) {
      delete menus[id]?.[cap];
      sendSetPopup(true);
    }
  },
});

export async function sendSetPopup(isDelayed) {
  if (isPopupShown) {
    if (isDelayed) {
      if (setPopupThrottle) return;
      // Preventing flicker in popup when scripts re-register menus
      setPopupThrottle = nextTask;
      await setPopupThrottle;
      setPopupThrottle = null;
    }
    sendCmd('SetPopup', safePickInto({ menus }, bridge, ['ids', INJECT_INTO]));
  }
}
