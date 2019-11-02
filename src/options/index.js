import Vue from 'vue';
import {
  sendCmd, i18n, getLocaleString, cache2blobUrl,
} from '#/common';
import handlers from '#/common/handlers';
import loadZip from '#/common/zip';
import '#/common/ui/style';
import { store } from './utils';
import App from './views/app';

Vue.prototype.i18n = i18n;

Object.assign(store, {
  loading: false,
  cache: {},
  scripts: [],
  sync: [],
  title: null,
});
initialize();

function initialize() {
  initMain();
  const vm = new Vue({
    render: h => h(App),
  })
  .$mount();
  document.body.append(vm.$el);
  loadZip()
  .then((zip) => {
    store.zip = zip;
    zip.workerScriptsPath = '/public/lib/zip.js/';
  });
}

function initScript(script) {
  const meta = script.meta || {};
  const localeName = getLocaleString(meta, 'name');
  const search = [
    meta.name,
    localeName,
    meta.description,
    getLocaleString(meta, 'description'),
    script.custom.name,
    script.custom.description,
  ].filter(Boolean).join('\n').toLowerCase();
  const name = script.custom.name || localeName;
  const lowerName = name.toLowerCase();
  script.$cache = { search, name, lowerName };
}

function loadData() {
  sendCmd('GetData', null, { retry: true })
  .then((data) => {
    const oldCache = store.cache || {};
    store.cache = data.cache;
    store.sync = data.sync;
    store.scripts = data.scripts;
    if (store.scripts) {
      store.scripts.forEach(initScript);
    }
    if (store.cache) {
      Object.keys(store.cache).forEach((url) => {
        const raw = store.cache[url];
        if (oldCache[url]) {
          store.cache[url] = oldCache[url];
          delete oldCache[url];
        } else {
          store.cache[url] = cache2blobUrl(raw, { defaultType: 'image/png' });
        }
      });
    }
    Object.values(oldCache).forEach((blobUrl) => {
      URL.revokeObjectURL(blobUrl);
    });
    store.loading = false;
  });
}

function initMain() {
  store.loading = true;
  loadData();
  Object.assign(handlers, {
    ScriptsUpdated() {
      loadData();
    },
    UpdateSync(data) {
      store.sync = data;
    },
    AddScript({ update }) {
      update.message = '';
      initScript(update);
      store.scripts.push(update);
    },
    UpdateScript(data) {
      if (!data) return;
      const index = store.scripts.findIndex(item => item.props.id === data.where.id);
      if (index >= 0) {
        const updated = Object.assign({}, store.scripts[index], data.update);
        Vue.set(store.scripts, index, updated);
        initScript(updated);
      }
    },
    RemoveScript(id) {
      const i = store.scripts.findIndex(script => script.props.id === id);
      if (i >= 0) store.scripts.splice(i, 1);
    },
  });
}
