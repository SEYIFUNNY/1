import {
  compareVersion, i18n, getFullUrl, isRemote, getRnd4, sendCmd, trueJoin,
} from '#/common';
import {
  CMD_SCRIPT_ADD, CMD_SCRIPT_UPDATE, INJECT_PAGE, INJECT_AUTO, TIMEOUT_WEEK,
} from '#/common/consts';
import { forEachEntry, forEachKey, forEachValue } from '#/common/object';
import storage from '#/common/storage';
import ua from '#/common/ua';
import pluginEvents from '../plugin/events';
import { getNameURI, parseMeta, newScript, getDefaultCustom } from './script';
import { testScript, testBlacklist } from './tester';
import { preInitialize } from './init';
import { commands } from './message';
import patchDB from './patch-db';
import { setOption } from './options';
import './storage-fetch';

const store = {};

storage.script.onDump = (item) => {
  store.scriptMap[item.props.id] = item;
};

Object.assign(commands, {
  CheckPosition: sortScripts,
  CheckRemove: checkRemove,
  /** @return {?string} */
  CheckScript({ name, namespace }) {
    const script = getScript({ meta: { name, namespace } });
    return script && !script.config.removed
      ? script.meta.version
      : null;
  },
  /** @return {Promise<{ items: VMScript[], values? }>} */
  async ExportZip({ values }) {
    const scripts = getScripts();
    const ids = scripts.map(getPropsId);
    const codeMap = await storage.code.getMulti(ids);
    return {
      items: scripts.map(script => ({ script, code: codeMap[script.props.id] })),
      values: values ? await storage.value.getMulti(ids) : undefined,
    };
  },
  /** @return {Promise<string>} */
  GetScriptCode(id) {
    return storage.code.getOne(id);
  },
  /** @return {VMScript[]} */
  GetMetas(ids) {
    return ids.map(getScriptById).filter(Boolean);
  },
  /** @return {Promise<void>} */
  MarkRemoved({ id, removed }) {
    return updateScriptInfo(id, {
      config: { removed: removed ? 1 : 0 },
      props: { lastModified: Date.now() },
    });
  },
  /** @return {Promise<number>} */
  Move({ id, offset }) {
    const script = getScriptById(id);
    const index = store.scripts.indexOf(script);
    store.scripts.splice(index, 1);
    store.scripts.splice(index + offset, 0, script);
    return normalizePosition();
  },
  /** @return {Promise<void>} */
  async RemoveScript(id) {
    const i = store.scripts.indexOf(getScriptById(id));
    if (i >= 0) {
      store.scripts.splice(i, 1);
      await Promise.all([
        storage.script.remove(id),
        storage.code.remove(id),
        storage.value.remove(id),
      ]);
    }
    return sendCmd('RemoveScript', id);
  },
  ParseMeta: parseMeta,
  ParseScript: parseScript,
  /** @return {Promise<void>} */
  UpdateScriptInfo({ id, config }) {
    return updateScriptInfo(id, {
      config,
      props: { lastModified: Date.now() },
    });
  },
  /** @return {Promise<void>} */
  Vacuum: vacuum,
});

preInitialize.push(async () => {
  const { version: lastVersion } = await browser.storage.local.get('version');
  const version = process.env.VM_VER;
  if (!lastVersion) await patchDB();
  if (version !== lastVersion) browser.storage.local.set({ version });
  const data = await browser.storage.local.get();
  const scripts = [];
  const storeInfo = {
    id: 0,
    position: 0,
  };
  const idMap = {};
  const uriMap = {};
  const mods = [];
  const resUrls = [];
  /** @this VMScriptCustom.pathMap */
  const rememberUrl = function _(url) { resUrls.push(this[url] || url); };
  data::forEachEntry(([key, script]) => {
    if (key.startsWith(storage.script.prefix)) {
      // {
      //   meta,
      //   custom,
      //   props: { id, position, uri },
      //   config: { enabled, shouldUpdate },
      // }
      const id = getInt(key.slice(storage.script.prefix.length));
      if (!id || idMap[id]) {
        // ID conflicts!
        // Should not happen, discard duplicates.
        return;
      }
      idMap[id] = script;
      const uri = getNameURI(script);
      if (uriMap[uri]) {
        // Namespace conflicts!
        // Should not happen, discard duplicates.
        return;
      }
      uriMap[uri] = script;
      script.props = {
        ...script.props,
        id,
        uri,
      };
      script.custom = {
        ...getDefaultCustom(),
        ...script.custom,
      };
      storeInfo.id = Math.max(storeInfo.id, id);
      storeInfo.position = Math.max(storeInfo.position, getInt(script.props.position));
      scripts.push(script);
      // listing all known resource urls in order to remove unused mod keys
      const {
        custom: { pathMap = {} } = {},
        meta = {},
      } = script;
      meta.require?.forEach(rememberUrl, pathMap);
      Object.values(meta.resources || {}).forEach(rememberUrl, pathMap);
      pathMap::rememberUrl(meta.icon);
    } else if (key.startsWith(storage.mod.prefix)) {
      mods.push(key.slice(storage.mod.prefix.length));
    }
  });
  storage.mod.removeMulti(mods.filter(url => !resUrls.includes(url)));
  Object.assign(store, {
    scripts,
    storeInfo,
    scriptMap: scripts.reduce((map, item) => {
      map[item.props.id] = item;
      return map;
    }, {}),
  });
  // Switch defaultInjectInto from `page` to `auto` when upgrading VM2.12.7 or older
  if (version !== lastVersion
  && ua.isFirefox
  && data.options?.defaultInjectInto === INJECT_PAGE
  && compareVersion(lastVersion, '2.12.7') <= 0) {
    setOption('defaultInjectInto', INJECT_AUTO);
  }
  if (process.env.DEBUG) {
    console.log('store:', store); // eslint-disable-line no-console
  }
  return sortScripts();
});

/** @return {number} */
function getInt(val) {
  return +val || 0;
}

/** @return {?number} */
function getPropsId(script) {
  return script?.props.id;
}

/** @return {void} */
function updateLastModified() {
  setOption('lastModified', Date.now());
}

/** @return {Promise<number>} */
export async function normalizePosition() {
  const updates = store.scripts.filter(({ props }, index) => {
    const position = index + 1;
    const res = props.position !== position;
    if (res) props.position = position;
    return res;
  });
  store.storeInfo.position = store.scripts.length;
  if (updates.length) {
    await storage.script.dump(updates);
    updateLastModified();
  }
  return updates.length;
}

/** @return {Promise<number>} */
export async function sortScripts() {
  store.scripts.sort((a, b) => getInt(a.props.position) - getInt(b.props.position));
  const changed = await normalizePosition();
  sendCmd('ScriptsUpdated', null);
  return changed;
}

/** @return {?VMScript} */
export function getScriptById(id) {
  return store.scriptMap[id];
}

/** @return {?VMScript} */
export function getScript({ id, uri, meta }) {
  let script;
  if (id) {
    script = getScriptById(id);
  } else {
    if (!uri) uri = getNameURI({ meta, id: '@@should-have-name' });
    script = store.scripts.find(({ props }) => uri === props.uri);
  }
  return script;
}

/** @return {VMScript[]} */
export function getScripts() {
  return store.scripts.filter(script => !script.config.removed);
}

/**
 * @desc Load values for batch updates.
 * @param {number[]} ids
 * @return {Promise<Object>}
 */
export function getValueStoresByIds(ids) {
  return storage.value.getMulti(ids);
}

/**
 * @desc Dump values for batch updates.
 * @param {Object} valueDict { id1: value1, id2: value2, ... }
 * @return {Promise<Object>}
 */
export async function dumpValueStores(valueDict) {
  if (process.env.DEBUG) console.info('Update value stores', valueDict);
  await storage.value.dump(valueDict);
  return valueDict;
}

const gmValues = [
  'GM_getValue', 'GM.getValue',
  'GM_setValue', 'GM.setValue',
  'GM_listValues', 'GM.listValues',
  'GM_deleteValue', 'GM.deleteValue',
];

/**
 * @desc Get scripts to be injected to page with specific URL.
 * @return {Promise<Object>}
 */
export async function getScriptsByURL(url, isTop) {
  const allScripts = testBlacklist(url)
    ? []
    : store.scripts.filter(script => (
      !script.config.removed
      && (isTop || !script.meta.noframes)
      && testScript(url, script)
    ));
  const reqKeys = {};
  const cacheKeys = {};
  const scripts = allScripts.filter(script => script.config.enabled);
  scripts.forEach((script) => {
    const { meta, custom } = script;
    const { pathMap = buildPathMap(script) } = custom;
    meta.require.forEach((key) => {
      reqKeys[pathMap[key] || key] = 1;
    });
    meta.resources::forEachValue((key) => {
      cacheKeys[pathMap[key] || key] = 1;
    });
  });
  const ids = allScripts.map(getPropsId);
  const enabledIds = scripts.map(getPropsId);
  const withValueIds = scripts
  .filter(script => script.meta.grant?.some(gm => gmValues.includes(gm)))
  .map(getPropsId);
  const [require, cache, values, code] = await Promise.all([
    storage.require.getMulti(Object.keys(reqKeys)),
    storage.cache.getMulti(Object.keys(cacheKeys)),
    storage.value.getMulti(withValueIds, {}),
    storage.code.getMulti(enabledIds),
  ]);
  return {
    // these will be sent to injectScripts()
    inject: {
      cache,
      ids,
      scripts,
    },
    // these will be used only by bg/* and to augment the data above
    code,
    enabledIds,
    require,
    values,
    withValueIds,
  };
}

/** @return {string[]} */
function getIconUrls() {
  return store.scripts.reduce((res, script) => {
    const { icon } = script.meta;
    if (isRemote(icon)) {
      res.push(script.custom.pathMap?.[icon] || icon);
    }
    return res;
  }, []);
}

/**
 * @desc Get data for dashboard.
 * @return {Promise<{ scripts: VMScript[], cache: Object }>}
 */
export async function getData() {
  return {
    scripts: store.scripts,
    cache: await storage.cache.getMulti(getIconUrls()),
  };
}

/** @return {number} */
export function checkRemove({ force } = {}) {
  const now = Date.now();
  const toRemove = store.scripts.filter(script => script.config.removed && (
    force || now - getInt(script.props.lastModified) > TIMEOUT_WEEK
  ));
  if (toRemove.length) {
    store.scripts = store.scripts.filter(script => !script.config.removed);
    const ids = toRemove.map(getPropsId);
    storage.script.removeMulti(ids);
    storage.code.removeMulti(ids);
    storage.value.removeMulti(ids);
  }
  return toRemove.length;
}

/** @return {string} */
function getUUID(id) {
  const idSec = (id + 0x10bde6a2).toString(16).slice(-8);
  return `${idSec}-${getRnd4()}-${getRnd4()}-${getRnd4()}-${getRnd4()}${getRnd4()}${getRnd4()}`;
}

/**
 * @param {VMScript} script
 * @param {string} code
 * @return {Promise<VMScript[]>}
 */
async function saveScript(script, code) {
  const config = script.config || {};
  config.enabled = getInt(config.enabled);
  config.shouldUpdate = getInt(config.shouldUpdate);
  const props = script.props || {};
  let oldScript;
  if (!props.id) {
    store.storeInfo.id += 1;
    props.id = store.storeInfo.id;
  } else {
    oldScript = store.scriptMap[props.id];
  }
  props.uri = getNameURI(script);
  props.uuid = props.uuid || getUUID(props.id);
  // Do not allow script with same name and namespace
  if (store.scripts.some(({ props: { id, uri } = {} }) => props.id !== id && props.uri === uri)) {
    throw i18n('msgNamespaceConflict');
  }
  if (oldScript) {
    script.config = { ...oldScript.config, ...config };
    script.props = { ...oldScript.props, ...props };
    const index = store.scripts.indexOf(oldScript);
    store.scripts[index] = script;
  } else {
    if (!props.position) {
      store.storeInfo.position += 1;
      props.position = store.storeInfo.position;
    } else if (store.storeInfo.position < props.position) {
      store.storeInfo.position = props.position;
    }
    script.config = config;
    script.props = props;
    store.scripts.push(script);
  }
  return Promise.all([
    storage.script.dump(script),
    storage.code.set(props.id, code),
  ]);
}

/** @return {Promise<void>} */
export async function updateScriptInfo(id, data) {
  const script = store.scriptMap[id];
  if (!script) throw null;
  script.props = { ...script.props, ...data.props };
  script.config = { ...script.config, ...data.config };
  await storage.script.dump(script);
  return sendCmd(CMD_SCRIPT_UPDATE, { where: { id }, update: script });
}

/** @return {Promise<{ isNew?, update, where }>} */
export async function parseScript(src) {
  const meta = parseMeta(src.code);
  if (!meta.name) throw i18n('msgInvalidScript');
  const result = {
    update: {
      message: src.message == null ? i18n('msgUpdated') : src.message || '',
    },
  };
  let cmd = CMD_SCRIPT_UPDATE;
  let script;
  const oldScript = await getScript({ id: src.id, meta });
  if (oldScript) {
    if (src.isNew) throw i18n('msgNamespaceConflict');
    script = { ...oldScript };
  } else {
    ({ script } = newScript());
    cmd = CMD_SCRIPT_ADD;
    result.isNew = true;
    result.update.message = i18n('msgInstalled');
  }
  script.config = {
    ...script.config,
    ...src.config,
    removed: 0, // force reset `removed` since this is an installation
  };
  script.custom = {
    ...script.custom,
    ...src.custom,
  };
  script.props = {
    ...script.props,
    lastModified: Date.now(),
    lastUpdated: Date.now(),
    ...src.props,
  };
  script.meta = meta;
  if (!meta.homepageURL && !script.custom.homepageURL && isRemote(src.from)) {
    script.custom.homepageURL = src.from;
  }
  if (isRemote(src.url)) script.custom.lastInstallURL = src.url;
  if (src.position) script.props.position = +src.position;
  buildPathMap(script, src.url);
  await saveScript(script, src.code);
  fetchResources(script, src);
  Object.assign(result.update, script, src.update);
  result.where = { id: script.props.id };
  sendCmd(cmd, result);
  pluginEvents.emit('scriptChanged', result);
  return result;
}

/** @return {Object} */
function buildPathMap(script, base) {
  const { meta } = script;
  const baseUrl = base || script.custom.lastInstallURL;
  const pathMap = baseUrl ? [
    ...meta.require,
    ...Object.values(meta.resources),
    meta.icon,
  ].reduce((map, key) => {
    if (key) {
      const fullUrl = getFullUrl(key, baseUrl);
      if (fullUrl !== key) map[key] = fullUrl;
    }
    return map;
  }, {}) : {};
  script.custom.pathMap = pathMap;
  return pathMap;
}

/** @return {Promise<?string>} resolves to error text if `resourceCache` is absent */
export async function fetchResources(script, resourceCache, reqOptions) {
  const { custom: { pathMap }, meta } = script;
  const snatch = (url, type, validator) => {
    url = pathMap[url] || url;
    const contents = resourceCache?.[type]?.[url];
    return contents != null && !validator
      ? storage[type].set(url, contents) && null
      : storage[type].fetch(url, reqOptions, validator).catch(err => err);
  };
  const errors = await Promise.all([
    ...meta.require.map(url => snatch(url, 'require')),
    ...Object.values(meta.resources).map(url => snatch(url, 'cache')),
    isRemote(meta.icon) && snatch(meta.icon, 'cache', validateImage),
  ]);
  if (!resourceCache) {
    const error = errors.map(formatHttpError)::trueJoin('\n');
    if (error) {
      const message = i18n('msgErrorFetchingResource');
      sendCmd(CMD_SCRIPT_UPDATE, {
        update: { error, message },
        where: { id: script.props.id },
      });
      return `${message}\n${error}`;
    }
  }
}

/** @return {Promise<void>} resolves on success, rejects on error */
function validateImage(url, buf, type) {
  return new Promise((resolve, reject) => {
    const blobUrl = URL.createObjectURL(new Blob([buf], { type }));
    const onDone = (e) => {
      URL.revokeObjectURL(blobUrl);
      if (e.type === 'load') resolve();
      else reject({ type: 'IMAGE_ERROR', url });
    };
    const image = new Image();
    image.onload = onDone;
    image.onerror = onDone;
    image.src = blobUrl;
  });
}

function formatHttpError(e) {
  return e && [e.status && `HTTP${e.status}`, e.url]::trueJoin(' ') || e;
}

/** @return {Promise<void>} */
export async function vacuum() {
  const valueKeys = {};
  const cacheKeys = {};
  const requireKeys = {};
  const codeKeys = {};
  const mappings = [
    [storage.value, valueKeys],
    [storage.cache, cacheKeys],
    [storage.require, requireKeys],
    [storage.code, codeKeys],
  ];
  const data = await browser.storage.local.get();
  data::forEachKey((key) => {
    mappings.some(([substore, map]) => {
      const { prefix } = substore;
      if (key.startsWith(prefix)) {
        // -1 for untouched, 1 for touched, 2 for missing
        map[key.slice(prefix.length)] = -1;
        return true;
      }
      return false;
    });
  });
  const touch = (obj, key) => {
    if (obj[key] < 0) {
      obj[key] = 1;
    } else if (!obj[key]) {
      obj[key] = 2;
    }
  };
  store.scripts.forEach((script) => {
    const { id } = script.props;
    touch(codeKeys, id);
    touch(valueKeys, id);
    if (!script.custom.pathMap) buildPathMap(script);
    const { pathMap } = script.custom;
    script.meta.require.forEach((url) => {
      touch(requireKeys, pathMap[url] || url);
    });
    script.meta.resources::forEachValue((url) => {
      touch(cacheKeys, pathMap[url] || url);
    });
    const { icon } = script.meta;
    if (isRemote(icon)) {
      const fullUrl = pathMap[icon] || icon;
      touch(cacheKeys, fullUrl);
    }
  });
  mappings.forEach(([substore, map]) => {
    map::forEachEntry(([key, value]) => {
      if (value < 0) {
        // redundant value
        substore.remove(key);
      } else if (value === 2 && substore.fetch) {
        // missing resource
        substore.fetch(key);
      }
    });
  });
}

/** @typedef VMScript
 * @property {VMScriptConfig} config
 * @property {VMScriptCustom} custom
 * @property {VMScriptMeta} meta
 * @property {VMScriptProps} props
 */
/** @typedef VMScriptConfig *
 * @property {Boolean} enabled - stored as 0 or 1
 * @property {Boolean} removed - stored as 0 or 1
 * @property {Boolean} shouldUpdate - stored as 0 or 1
 * @property {Boolean | null} notifyUpdates - stored as 0 or 1 or null (default) which means "use global setting"
 */
/** @typedef VMScriptCustom *
 * @property {string} name
 * @property {string} downloadURL
 * @property {string} homepageURL
 * @property {string} lastInstallURL
 * @property {string} updateURL
 * @property {'auto' | 'page' | 'content'} injectInto
 * @property {string[]} exclude
 * @property {string[]} excludeMatch
 * @property {string[]} include
 * @property {string[]} match
 * @property {boolean} origExclude
 * @property {boolean} origExcludeMatch
 * @property {boolean} origInclude
 * @property {boolean} origMatch
 * @property {Object} pathMap
 * @property {VMScriptRunAt} runAt
 */
/** @typedef VMScriptMeta *
 * @property {string} description
 * @property {string} downloadURL
 * @property {string[]} exclude
 * @property {string[]} excludeMatch
 * @property {string[]} grant
 * @property {string} homepageURL
 * @property {string} icon
 * @property {string[]} include
 * @property {'auto' | 'page' | 'content'} injectInto
 * @property {string[]} match
 * @property {string} namespace
 * @property {string} name
 * @property {boolean} noframes
 * @property {string[]} require
 * @property {Object} resource
 * @property {VMScriptRunAt} runAt
 * @property {string} supportURL
 * @property {string} version
 */
/** @typedef VMScriptProps *
 * @property {number} id
 * @property {number} lastModified
 * @property {number} lastUpdated
 * @property {number} position
 * @property {string} uri
 * @property {string} uuid
 */
/** @typedef {'document-start' | 'document-end' | 'document-idle'} VMScriptRunAt */
