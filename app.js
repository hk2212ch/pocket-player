/* ==========================================================================
   Pocket Player — application principale
   --------------------------------------------------------------------------
   Organisation du fichier :
     1. Constantes et outils
     2. Journal des erreurs et notifications
     3. Base de données locale (IndexedDB)
     4. Lecture des métadonnées MP3 (ID3)
     5. Formats et analyse des fichiers
     6. Stockage : estimation et persistance
     7. Boîtes de dialogue
     8. Importation
     9. Écrans (rendu HTML)
    10. Lecteur audio
    11. Lecteur vidéo
    12. Favoris, playlists, suppression
    13. Sauvegarde et exportation
    14. Service worker et mises à jour
    15. Gestion des clics et démarrage
   Aucun fichier multimédia n'est envoyé sur Internet : tout reste dans
   IndexedDB, sur l'appareil.
   ========================================================================== */

(() => {
  'use strict';

  /* ------------------------------------------------------------------------
     1. Constantes et outils
     ------------------------------------------------------------------------ */

  const DB_NAME = 'pocket-player';
  const DB_VERSION = 1;
  const STORE_MEDIA = 'media';         // métadonnées (titre, artiste, favoris…)
  const STORE_FILES = 'files';         // contenu binaire des fichiers (Blob)
  const STORE_PLAYLISTS = 'playlists';
  const STORE_SETTINGS = 'settings';

  const PROBE_TIMEOUT_MS = 8000;              // délai max pour analyser un fichier
  const MAX_TAG_BYTES = 8 * 1024 * 1024;      // taille max lue pour les balises ID3
  const MAX_COVER_BYTES = 4 * 1024 * 1024;    // pochettes plus lourdes ignorées
  const POSITION_SAVE_INTERVAL_MS = 5000;     // sauvegarde de la position vidéo
  const RESUME_MIN_SECONDS = 5;
  const MAX_LOGGED_ERRORS = 50;

  // Extension -> [type de média, type MIME]. Sert quand iOS ne fournit pas de type.
  const EXTENSION_TYPES = {
    mp3: ['audio', 'audio/mpeg'],
    m4a: ['audio', 'audio/mp4'],
    aac: ['audio', 'audio/aac'],
    wav: ['audio', 'audio/wav'],
    aif: ['audio', 'audio/aiff'],
    aiff: ['audio', 'audio/aiff'],
    caf: ['audio', 'audio/x-caf'],
    flac: ['audio', 'audio/flac'],
    ogg: ['audio', 'audio/ogg'],
    opus: ['audio', 'audio/ogg; codecs=opus'],
    mp4: ['video', 'video/mp4'],
    m4v: ['video', 'video/x-m4v'],
    mov: ['video', 'video/quicktime'],
    webm: ['video', 'video/webm'],
    mkv: ['video', 'video/x-matroska'],
    avi: ['video', 'video/x-msvideo'],
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const elements = {
    view: $('#view'),
    audio: $('#audio-element'),
    video: $('#video-element'),
    audioInput: $('#audio-input'),
    videoInput: $('#video-input'),
    backupInput: $('#backup-input'),
    miniPlayer: $('#mini-player'),
    playerSheet: $('#player-sheet'),
    videoScreen: $('#video-screen'),
    seekBar: $('#seek-bar'),
    dialogRoot: $('#dialog-root'),
    toastRoot: $('#toast-root'),
    updateBanner: $('#update-banner'),
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function icon(name, extraClass = '') {
    return `<svg class="icon ${extraClass}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
  }

  function formatTime(totalSeconds) {
    if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00';
    const seconds = Math.floor(totalSeconds % 60);
    const minutes = Math.floor((totalSeconds / 60) % 60);
    const hours = Math.floor(totalSeconds / 3600);
    const paddedSeconds = String(seconds).padStart(2, '0');
    return hours > 0
      ? `${hours}:${String(minutes).padStart(2, '0')}:${paddedSeconds}`
      : `${minutes}:${paddedSeconds}`;
  }

  function formatSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 o';
    const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }
    const digits = value >= 100 || unitIndex === 0 ? 0 : 1;
    return `${value.toFixed(digits).replace('.', ',')} ${units[unitIndex]}`;
  }

  function plural(count, singular, pluralForm) {
    return `${count} ${count > 1 ? pluralForm : singular}`;
  }

  // Minuscules et sans accents, pour une recherche tolérante.
  function normalizeText(value) {
    return String(value ?? '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .trim();
  }

  const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });

  function createId() {
    if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function fileExtension(fileName) {
    const match = /\.([a-z0-9]+)$/i.exec(fileName || '');
    return match ? match[1].toLowerCase() : '';
  }

  function stripExtension(fileName) {
    return String(fileName || '').replace(/\.[a-z0-9]+$/i, '');
  }

  function shuffleArray(items) {
    const copy = items.slice();
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const randomIndex = Math.floor(Math.random() * (index + 1));
      [copy[index], copy[randomIndex]] = [copy[randomIndex], copy[index]];
    }
    return copy;
  }

  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  function isStandalone() {
    return window.navigator.standalone === true
      || window.matchMedia('(display-mode: standalone)').matches;
  }

  /* ------------------------------------------------------------------------
     État global de l'application
     ------------------------------------------------------------------------ */

  const state = {
    media: [],            // toutes les fiches (audio et vidéo), sans le contenu binaire
    playlists: [],
    preferences: {
      musicSort: 'name',
      videoSort: 'name',
      favoritesTab: 'audio',
      installHintDismissed: false,
    },
    search: { music: '', videos: '' },
    visibleTrackIds: [],  // morceaux affichés à l'écran (pour lancer la lecture)
    route: { view: 'library', param: null },
    errors: [],
    databaseReady: false,
    isImporting: false,
  };

  function findMedia(mediaId) {
    return state.media.find((item) => item.id === mediaId) || null;
  }

  function findPlaylist(playlistId) {
    return state.playlists.find((playlist) => playlist.id === playlistId) || null;
  }

  function audioTracks() {
    return state.media.filter((item) => item.kind === 'audio');
  }

  function videoItems() {
    return state.media.filter((item) => item.kind === 'video');
  }

  /* ------------------------------------------------------------------------
     2. Journal des erreurs et notifications
     ------------------------------------------------------------------------ */

  function describeError(error) {
    if (!error) return 'Erreur inconnue';
    if (typeof error === 'string') return error;
    const name = error.name && error.name !== 'Error' ? `${error.name} : ` : '';
    return `${name}${error.message || String(error)}`;
  }

  function logError(context, error) {
    state.errors.unshift({ time: new Date(), context, message: describeError(error) });
    state.errors.length = Math.min(state.errors.length, MAX_LOGGED_ERRORS);
    console.error(`[Pocket Player] ${context}`, error);
  }

  const MAX_VISIBLE_TOASTS = 2;

  function showToast(message, { isError = false, duration = 3500 } = {}) {
    // Au-delà de deux notifications, la plus ancienne disparaît.
    const visibleToasts = $$('.toast:not(.is-progress)', elements.toastRoot);
    visibleToasts.slice(0, Math.max(0, visibleToasts.length - MAX_VISIBLE_TOASTS + 1)).forEach((old) => old.remove());
    const toast = document.createElement('div');
    toast.className = `toast${isError ? ' is-error' : ''}`;
    toast.textContent = message;
    elements.toastRoot.appendChild(toast);
    setTimeout(() => toast.remove(), duration);
    return toast;
  }

  // Notification persistante mise à jour pendant l'importation.
  let progressToast = null;

  function showProgress(message) {
    if (!progressToast) {
      progressToast = document.createElement('div');
      progressToast.className = 'toast is-progress';
      elements.toastRoot.appendChild(progressToast);
    }
    progressToast.textContent = message;
  }

  function hideProgress() {
    if (progressToast) progressToast.remove();
    progressToast = null;
  }

  window.addEventListener('error', (event) => {
    logError('Erreur JavaScript', event.error || event.message);
  });

  window.addEventListener('unhandledrejection', (event) => {
    logError('Opération asynchrone échouée', event.reason);
  });

  /* ------------------------------------------------------------------------
     3. Base de données locale (IndexedDB)
     ------------------------------------------------------------------------
     - "media"     : une fiche par fichier (titre, artiste, durée, favori…).
     - "files"     : le Blob du fichier, rangé à part pour ne pas charger
                     des centaines de Mo quand on affiche la liste.
     - "playlists" : les playlists (liste ordonnée d'identifiants).
     - "settings"  : les préférences d'affichage.
     ------------------------------------------------------------------------ */

  let database = null;

  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('IndexedDB n\'est pas disponible dans ce navigateur.'));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const upgradeDb = request.result;
        if (!upgradeDb.objectStoreNames.contains(STORE_MEDIA)) {
          upgradeDb.createObjectStore(STORE_MEDIA, { keyPath: 'id' });
        }
        if (!upgradeDb.objectStoreNames.contains(STORE_FILES)) {
          upgradeDb.createObjectStore(STORE_FILES);
        }
        if (!upgradeDb.objectStoreNames.contains(STORE_PLAYLISTS)) {
          upgradeDb.createObjectStore(STORE_PLAYLISTS, { keyPath: 'id' });
        }
        if (!upgradeDb.objectStoreNames.contains(STORE_SETTINGS)) {
          upgradeDb.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => {
        database = request.result;
        // Si une autre version de l'app demande une mise à niveau, on libère la base.
        database.onversionchange = () => {
          database.close();
          showToast('La base locale a été mise à jour. Rechargez l\'application.');
        };
        resolve(database);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Base locale bloquée par un autre onglet ouvert.'));
    });
  }

  /**
   * Exécute un travail dans une transaction et attend sa validation complète.
   * `work` reçoit un objet { nomDuMagasin: IDBObjectStore } et peut renvoyer
   * une requête IDB : son résultat sera alors renvoyé par la promesse.
   */
  function runTransaction(storeNames, mode, work) {
    return new Promise((resolve, reject) => {
      let transaction;
      try {
        transaction = database.transaction(storeNames, mode);
      } catch (error) {
        reject(error);
        return;
      }
      const stores = {};
      [].concat(storeNames).forEach((name) => {
        stores[name] = transaction.objectStore(name);
      });
      let outcome;
      transaction.oncomplete = () => {
        resolve(outcome instanceof IDBRequest ? outcome.result : outcome);
      };
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => {
        reject(transaction.error || new DOMException('Transaction annulée', 'AbortError'));
      };
      try {
        outcome = work(stores, transaction);
      } catch (error) {
        transaction.abort();
        reject(error);
      }
    });
  }

  const dbApi = {
    getAllMedia: () => runTransaction(STORE_MEDIA, 'readonly', (s) => s[STORE_MEDIA].getAll()),
    getAllPlaylists: () => runTransaction(STORE_PLAYLISTS, 'readonly', (s) => s[STORE_PLAYLISTS].getAll()),
    getFile: (mediaId) => runTransaction(STORE_FILES, 'readonly', (s) => s[STORE_FILES].get(mediaId)),
    putMedia: (record) => runTransaction(STORE_MEDIA, 'readwrite', (s) => { s[STORE_MEDIA].put(record); }),
    putPlaylist: (playlist) => runTransaction(STORE_PLAYLISTS, 'readwrite', (s) => { s[STORE_PLAYLISTS].put(playlist); }),
    deletePlaylist: (playlistId) => runTransaction(STORE_PLAYLISTS, 'readwrite', (s) => { s[STORE_PLAYLISTS].delete(playlistId); }),
    getSetting: (key) => runTransaction(STORE_SETTINGS, 'readonly', (s) => s[STORE_SETTINGS].get(key)),
    putSetting: (key, value) => runTransaction(STORE_SETTINGS, 'readwrite', (s) => { s[STORE_SETTINGS].put({ key, value }); }),

    // Fiche + fichier dans la même transaction : soit tout est enregistré, soit rien.
    addMedia: (record, blob) => runTransaction([STORE_MEDIA, STORE_FILES], 'readwrite', (s) => {
      s[STORE_FILES].put(blob, record.id);
      s[STORE_MEDIA].put(record);
    }),

    // Supprime le média et le retire des playlists concernées, en une seule fois.
    deleteMedia: (mediaId, updatedPlaylists) => runTransaction(
      [STORE_MEDIA, STORE_FILES, STORE_PLAYLISTS],
      'readwrite',
      (s) => {
        s[STORE_MEDIA].delete(mediaId);
        s[STORE_FILES].delete(mediaId);
        updatedPlaylists.forEach((playlist) => s[STORE_PLAYLISTS].put(playlist));
      },
    ),

    clearLibrary: () => runTransaction([STORE_MEDIA, STORE_FILES, STORE_PLAYLISTS], 'readwrite', (s) => {
      s[STORE_MEDIA].clear();
      s[STORE_FILES].clear();
      s[STORE_PLAYLISTS].clear();
    }),
  };

  function isStorageError(error) {
    return Boolean(error) && (error.name === 'QuotaExceededError'
      || (error.name === 'UnknownError' && /quota|space|disk/i.test(error.message || ''))
      || /quota/i.test(error.message || ''));
  }

  async function savePreferences() {
    try {
      await dbApi.putSetting('preferences', state.preferences);
    } catch (error) {
      logError('Enregistrement des préférences', error);
    }
  }

  /* ------------------------------------------------------------------------
     4. Lecture des métadonnées MP3 (balises ID3v2.2 / 2.3 / 2.4 et ID3v1)
     ------------------------------------------------------------------------ */

  function readSyncSafeInteger(bytes, offset) {
    return ((bytes[offset] & 0x7f) << 21) | ((bytes[offset + 1] & 0x7f) << 14)
      | ((bytes[offset + 2] & 0x7f) << 7) | (bytes[offset + 3] & 0x7f);
  }

  function readUint32(bytes, offset) {
    return ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
  }

  function readAscii(bytes, start, length) {
    let text = '';
    for (let index = start; index < start + length && index < bytes.length; index += 1) {
      text += String.fromCharCode(bytes[index]);
    }
    return text;
  }

  // Annule la « désynchronisation » ID3 (0xFF 0x00 -> 0xFF).
  function removeUnsynchronisation(bytes) {
    const output = new Uint8Array(bytes.length);
    let outputLength = 0;
    for (let index = 0; index < bytes.length; index += 1) {
      output[outputLength] = bytes[index];
      outputLength += 1;
      if (bytes[index] === 0xff && bytes[index + 1] === 0x00) index += 1;
    }
    return output.subarray(0, outputLength);
  }

  function decodeId3Text(bytes, encoding) {
    let label = 'iso-8859-1';
    let content = bytes;
    if (encoding === 1) {
      if (bytes[0] === 0xfe && bytes[1] === 0xff) label = 'utf-16be';
      else label = 'utf-16le';
    } else if (encoding === 2) {
      label = 'utf-16be';
    } else if (encoding === 3) {
      label = 'utf-8';
    }
    if ((encoding === 1 || encoding === 2) && content.length % 2 === 1) {
      content = content.subarray(0, content.length - 1);
    }
    try {
      return new TextDecoder(label).decode(content);
    } catch (error) {
      return readAscii(content, 0, content.length);
    }
  }

  function cleanTagText(text) {
    return text.replace(/﻿/g, '').replace(/\u0000+$/g, '').replace(/\u0000/g, ', ').trim();
  }

  // Position de fin d'une chaîne terminée par un zéro (1 ou 2 octets selon l'encodage).
  function findTerminator(bytes, start, encoding) {
    if (encoding === 1 || encoding === 2) {
      for (let index = start; index + 1 < bytes.length; index += 2) {
        if (bytes[index] === 0 && bytes[index + 1] === 0) return { end: index, next: index + 2 };
      }
    } else {
      for (let index = start; index < bytes.length; index += 1) {
        if (bytes[index] === 0) return { end: index, next: index + 1 };
      }
    }
    return { end: bytes.length, next: bytes.length };
  }

  function guessImageType(bytes, declared) {
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
    if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
    const lower = (declared || '').toLowerCase();
    if (lower === 'image/jpg' || lower === 'jpg') return 'image/jpeg';
    if (lower === 'png') return 'image/png';
    return lower.startsWith('image/') ? lower : 'image/jpeg';
  }

  function parsePictureFrame(frame, isVersion22) {
    const encoding = frame[0];
    let cursor;
    let declaredType;
    if (isVersion22) {
      declaredType = readAscii(frame, 1, 3);
      cursor = 4;
    } else {
      const mimeEnd = findTerminator(frame, 1, 0);
      declaredType = readAscii(frame, 1, mimeEnd.end - 1);
      cursor = mimeEnd.next;
    }
    const pictureType = frame[cursor];
    cursor += 1;
    cursor = findTerminator(frame, cursor, encoding).next;
    const imageBytes = frame.subarray(cursor);
    if (imageBytes.length < 16 || imageBytes.length > MAX_COVER_BYTES) return null;
    return { pictureType, blob: new Blob([imageBytes], { type: guessImageType(imageBytes, declaredType) }) };
  }

  async function readId3v1(file) {
    if (file.size < 128) return {};
    const bytes = new Uint8Array(await file.slice(file.size - 128).arrayBuffer());
    if (readAscii(bytes, 0, 3) !== 'TAG') return {};
    const read = (start, length) => cleanTagText(decodeId3Text(bytes.subarray(start, start + length), 0));
    return { title: read(3, 30), artist: read(33, 30), album: read(63, 30) };
  }

  async function readMp3Tags(file) {
    const tags = { title: '', artist: '', album: '', cover: null };
    let coverPictureType = -1;
    try {
      const header = new Uint8Array(await file.slice(0, 10).arrayBuffer());
      if (readAscii(header, 0, 3) === 'ID3') {
        const majorVersion = header[3];
        const tagFlags = header[5];
        const tagSize = Math.min(readSyncSafeInteger(header, 6), MAX_TAG_BYTES);
        let data = new Uint8Array(await file.slice(10, 10 + tagSize).arrayBuffer());
        if ((tagFlags & 0x80) && majorVersion < 4) data = removeUnsynchronisation(data);

        let offset = 0;
        if (tagFlags & 0x40) {
          if (majorVersion === 3) offset = readUint32(data, 0) + 4;
          if (majorVersion === 4) offset = readSyncSafeInteger(data, 0);
        }

        const isVersion22 = majorVersion === 2;
        const idLength = isVersion22 ? 3 : 4;
        const headerLength = isVersion22 ? 6 : 10;

        while (offset + headerLength <= data.length) {
          const frameId = readAscii(data, offset, idLength);
          if (!/^[A-Z0-9]{3,4}$/.test(frameId)) break; // zone de remplissage atteinte
          let frameSize;
          if (isVersion22) frameSize = (data[offset + 3] << 16) | (data[offset + 4] << 8) | data[offset + 5];
          else if (majorVersion === 4) frameSize = readSyncSafeInteger(data, offset + 4);
          else frameSize = readUint32(data, offset + 4);
          const formatFlags = isVersion22 ? 0 : data[offset + 9];
          const frameStart = offset + headerLength;
          const frameEnd = frameStart + frameSize;
          if (frameSize <= 0 || frameEnd > data.length) break;

          // Cadres compressés ou chiffrés : ignorés.
          const skipFrame = (majorVersion === 3 && (formatFlags & 0xc0))
            || (majorVersion === 4 && (formatFlags & 0x0c));
          if (!skipFrame) {
            let frame = data.subarray(frameStart, frameEnd);
            if (majorVersion === 4 && (formatFlags & 0x02)) frame = removeUnsynchronisation(frame);
            if (majorVersion === 4 && (formatFlags & 0x01)) frame = frame.subarray(4);

            if (frameId === 'TIT2' || frameId === 'TT2') {
              tags.title = cleanTagText(decodeId3Text(frame.subarray(1), frame[0]));
            } else if (frameId === 'TPE1' || frameId === 'TP1') {
              tags.artist = cleanTagText(decodeId3Text(frame.subarray(1), frame[0]));
            } else if (frameId === 'TALB' || frameId === 'TAL') {
              tags.album = cleanTagText(decodeId3Text(frame.subarray(1), frame[0]));
            } else if ((frameId === 'APIC' || frameId === 'PIC') && coverPictureType !== 3) {
              // On garde de préférence la « couverture avant » (type 3).
              const picture = parsePictureFrame(frame, isVersion22);
              if (picture && (tags.cover === null || picture.pictureType === 3)) {
                tags.cover = picture.blob;
                coverPictureType = picture.pictureType;
              }
            }
          }
          offset = frameEnd;
        }
      }
      if (!tags.title || !tags.artist) {
        const fallback = await readId3v1(file);
        tags.title = tags.title || fallback.title || '';
        tags.artist = tags.artist || fallback.artist || '';
        tags.album = tags.album || fallback.album || '';
      }
    } catch (error) {
      // Des balises illisibles ne doivent jamais empêcher l'importation.
      logError(`Métadonnées illisibles : ${file.name}`, error);
    }
    return tags;
  }

  /* ------------------------------------------------------------------------
     5. Formats et analyse des fichiers
     ------------------------------------------------------------------------ */

  function detectMediaType(file) {
    const extensionInfo = EXTENSION_TYPES[fileExtension(file.name)];
    const declaredType = (file.type || '').toLowerCase();
    let kind = null;
    if (declaredType.startsWith('audio/')) kind = 'audio';
    else if (declaredType.startsWith('video/')) kind = 'video';
    else if (extensionInfo) kind = extensionInfo[0];
    // Un .m4a peut être annoncé comme vidéo : on se fie à l'extension audio.
    if (extensionInfo && extensionInfo[0] === 'audio') kind = 'audio';
    const mimeType = declaredType || (extensionInfo ? extensionInfo[1] : '');
    return { kind, mimeType, extensionMime: extensionInfo ? extensionInfo[1] : '' };
  }

  // Safari sait-il, a priori, lire ce type de fichier ?
  function browserMayPlay(kind, mimeTypes) {
    const tester = document.createElement(kind === 'video' ? 'video' : 'audio');
    return mimeTypes.filter(Boolean).some((type) => tester.canPlayType(type) !== '');
  }

  /**
   * Charge les métadonnées du fichier dans un lecteur temporaire pour vérifier
   * qu'il est lisible et connaître sa durée. Sur iOS, ce chargement peut ne
   * jamais aboutir : on n'en conclut alors rien (statut « unknown »).
   */
  function probeMedia(blob, kind) {
    return new Promise((resolve) => {
      const element = document.createElement(kind === 'video' ? 'video' : 'audio');
      element.preload = 'metadata';
      element.muted = true;
      if (kind === 'video') element.playsInline = true;
      const objectUrl = URL.createObjectURL(blob);
      let finished = false;
      let timer = null;

      const finish = (result) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        element.removeAttribute('src');
        element.load();
        URL.revokeObjectURL(objectUrl);
        resolve(result);
      };

      timer = setTimeout(() => finish({ status: 'unknown', duration: 0 }), PROBE_TIMEOUT_MS);
      element.addEventListener('loadedmetadata', () => finish({
        status: 'ok',
        duration: Number.isFinite(element.duration) ? element.duration : 0,
        width: element.videoWidth || 0,
        height: element.videoHeight || 0,
      }));
      element.addEventListener('error', () => finish({
        status: 'error',
        code: element.error ? element.error.code : 0,
      }));
      element.src = objectUrl;
      element.load();
    });
  }

  function mediaErrorMessage(errorCode, kind) {
    switch (errorCode) {
      case 1:
        return 'La lecture a été interrompue.';
      case 2:
        return 'Le fichier n\'a pas pu être chargé depuis le stockage local.';
      case 3:
        return kind === 'video'
          ? 'Safari n\'arrive pas à décoder cette vidéo. Le fichier est peut-être abîmé ou utilise un codec non pris en charge.'
          : 'Safari n\'arrive pas à décoder ce fichier audio (fichier abîmé ou codec non pris en charge).';
      case 4:
        return kind === 'video'
          ? 'Format vidéo non pris en charge par Safari. Sur iPhone, utilisez une vidéo MP4/MOV en H.264 ou HEVC (H.265) avec un son AAC.'
          : 'Format audio non pris en charge par Safari. Utilisez du MP3, AAC/M4A, WAV, AIFF ou FLAC.';
      default:
        return 'Erreur de lecture inconnue.';
    }
  }

  function displayTitle(item) {
    return item.title || stripExtension(item.fileName);
  }

  /* ------------------------------------------------------------------------
     6. Stockage : estimation et persistance
     ------------------------------------------------------------------------ */

  async function getStorageEstimate() {
    if (!navigator.storage || typeof navigator.storage.estimate !== 'function') return null;
    try {
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      return { usage, quota };
    } catch (error) {
      logError('Estimation du stockage', error);
      return null;
    }
  }

  async function isStoragePersisted() {
    if (!navigator.storage || typeof navigator.storage.persisted !== 'function') return null;
    try {
      return await navigator.storage.persisted();
    } catch (error) {
      return null;
    }
  }

  // Demande au navigateur de ne pas effacer nos données en cas de manque de place.
  // Ce n'est qu'une demande : le système ou l'utilisateur peuvent toujours les supprimer.
  async function requestPersistentStorage() {
    if (!navigator.storage || typeof navigator.storage.persist !== 'function') return null;
    try {
      return await navigator.storage.persist();
    } catch (error) {
      logError('Demande de stockage persistant', error);
      return null;
    }
  }

  /* ------------------------------------------------------------------------
     7. Boîtes de dialogue
     ------------------------------------------------------------------------
     openDialog renvoie une promesse résolue avec la valeur du bouton choisi.
     Chaque action peut définir :
       - value   : valeur renvoyée ;
       - collect : fonction qui lit le contenu de la boîte avant fermeture ;
       - run     : fonction appelée immédiatement au toucher (nécessaire pour
                   les API exigeant un geste de l'utilisateur, comme le partage).
     ------------------------------------------------------------------------ */

  let closeActiveDialog = null;

  function openDialog({ title, message = '', bodyHtml = '', actions, cancelValue = null }) {
    if (closeActiveDialog) closeActiveDialog(cancelValue);
    return new Promise((resolve) => {
      const root = elements.dialogRoot;
      const messageHtml = message
        ? message.split('\n').map((line) => `<p>${escapeHtml(line)}</p>`).join('')
        : '';
      root.innerHTML = `
        <div class="dialog-backdrop">
          <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
            <h2 id="dialog-title">${escapeHtml(title)}</h2>
            <div class="dialog-body">${messageHtml}${bodyHtml}</div>
            <div class="dialog-actions">
              ${actions.map((action, index) => `
                <button type="button" class="btn ${action.style || ''}" data-dialog-index="${index}">
                  ${escapeHtml(action.label)}
                </button>`).join('')}
            </div>
          </div>
        </div>`;
      root.hidden = false;
      document.body.classList.add('no-scroll');

      const close = (value) => {
        root.hidden = true;
        root.innerHTML = '';
        root.onclick = null;
        document.removeEventListener('keydown', onKeyDown);
        closeActiveDialog = null;
        if (!elements.playerSheet.classList.contains('is-open')
          && !elements.videoScreen.classList.contains('is-open')) {
          document.body.classList.remove('no-scroll');
        }
        resolve(value);
      };
      const onKeyDown = (event) => {
        if (event.key === 'Escape') close(cancelValue);
      };
      closeActiveDialog = close;
      document.addEventListener('keydown', onKeyDown);

      root.onclick = (event) => {
        const button = event.target.closest('[data-dialog-index]');
        if (button) {
          const action = actions[Number(button.dataset.dialogIndex)];
          if (typeof action.run === 'function') action.run();
          const value = typeof action.collect === 'function' ? action.collect(root) : action.value;
          close(value);
          return;
        }
        if (event.target.classList.contains('dialog-backdrop')) close(cancelValue);
      };

      const field = $('input.field', root);
      if (field) {
        field.focus();
        field.select();
      } else {
        const firstButton = $('[data-dialog-index]', root);
        if (firstButton) firstButton.focus({ preventScroll: true });
      }
    });
  }

  function alertDialog(title, message, bodyHtml = '') {
    return openDialog({ title, message, bodyHtml, actions: [{ label: 'OK', value: true, style: 'btn-accent' }] });
  }

  function confirmDialog(title, message, confirmLabel, { danger = false } = {}) {
    return openDialog({
      title,
      message,
      cancelValue: false,
      actions: [
        { label: confirmLabel, value: true, style: danger ? 'btn-danger' : 'btn-accent' },
        { label: 'Annuler', value: false },
      ],
    });
  }

  function promptDialog(title, fieldLabel, defaultValue, confirmLabel) {
    const bodyHtml = `
      <label class="small muted" for="dialog-field">${escapeHtml(fieldLabel)}</label>
      <input class="field" id="dialog-field" type="text" maxlength="80" autocomplete="off" value="${escapeHtml(defaultValue)}">`;
    return openDialog({
      title,
      bodyHtml,
      actions: [
        {
          label: confirmLabel,
          style: 'btn-accent',
          collect: (root) => {
            const text = $('#dialog-field', root).value.trim();
            return text || null;
          },
        },
        { label: 'Annuler', value: null },
      ],
    });
  }

  // Menu d'actions présenté depuis le bas de l'écran.
  function actionSheet(title, items) {
    return openDialog({
      title,
      actions: [
        ...items.map((item) => ({
          label: item.label,
          value: item.value,
          run: item.run,
          style: item.danger ? 'btn-danger' : '',
        })),
        { label: 'Annuler', value: null, style: 'btn-ghost' },
      ],
    });
  }

  /* ------------------------------------------------------------------------
     8. Importation
     ------------------------------------------------------------------------ */

  async function importFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    if (!state.databaseReady) {
      await alertDialog('Stockage indisponible', 'La base de données locale n\'a pas pu être ouverte. L\'importation est impossible.');
      return;
    }
    if (state.isImporting) {
      showToast('Une importation est déjà en cours.');
      return;
    }

    // Vérification de l'espace disponible (estimation fournie par le navigateur).
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    const estimate = await getStorageEstimate();
    if (estimate && estimate.quota > 0) {
      const freeBytes = Math.max(0, estimate.quota - estimate.usage);
      if (totalBytes > freeBytes) {
        const goOn = await confirmDialog(
          'Espace probablement insuffisant',
          `Ces fichiers pèsent ${formatSize(totalBytes)}, mais l'espace disponible pour Pocket Player est estimé à ${formatSize(freeBytes)}.\n`
          + 'L\'estimation d\'iOS est approximative : vous pouvez essayer, mais l\'importation risque d\'échouer en cours de route.',
          'Essayer quand même',
        );
        if (!goOn) return;
      }
    }

    state.isImporting = true;
    const imported = [];
    const skipped = [];
    let storageFull = false;
    // Si iOS ne charge pas les métadonnées du premier fichier, inutile d'attendre
    // le délai maximal pour chacun des suivants.
    let probingAvailable = true;

    try {
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        showProgress(`Importation ${index + 1}/${files.length} : ${file.name}`);

        const { kind, mimeType, extensionMime } = detectMediaType(file);
        if (!kind) {
          skipped.push({ name: file.name, reason: 'type de fichier non reconnu' });
          continue;
        }
        if (!browserMayPlay(kind, [mimeType, extensionMime])) {
          skipped.push({
            name: file.name,
            reason: kind === 'video'
              ? 'format vidéo non pris en charge par Safari (utilisez du MP4/MOV en H.264 ou HEVC)'
              : 'format audio non pris en charge par Safari (utilisez MP3, M4A, WAV, AIFF ou FLAC)',
          });
          continue;
        }
        const isDuplicate = state.media.some((item) => item.fileName === file.name && item.size === file.size);
        if (isDuplicate) {
          skipped.push({ name: file.name, reason: 'déjà présent dans la bibliothèque' });
          continue;
        }

        const probe = probingAvailable ? await probeMedia(file, kind) : { status: 'unknown', duration: 0 };
        if (probe.status === 'unknown') probingAvailable = false;
        if (probe.status === 'error') {
          skipped.push({ name: file.name, reason: mediaErrorMessage(probe.code, kind) });
          continue;
        }

        const tags = kind === 'audio' && fileExtension(file.name) === 'mp3'
          ? await readMp3Tags(file)
          : { title: '', artist: '', album: '', cover: null };

        const record = {
          id: createId(),
          kind,
          fileName: file.name,
          title: tags.title || stripExtension(file.name),
          artist: tags.artist || '',
          album: tags.album || '',
          cover: tags.cover || null,
          mimeType: mimeType || 'application/octet-stream',
          size: file.size,
          duration: probe.duration || 0,
          width: probe.width || 0,
          height: probe.height || 0,
          // Vidéo dont aucune image n'a été détectée (piste vidéo illisible ou absente).
          noVideoTrack: kind === 'video' && probe.status === 'ok' && !probe.width,
          addedAt: Date.now(),
          favorite: false,
          lastPosition: 0,
        };

        try {
          // Le fichier est stocké tel quel (Blob) : aucune copie n'est envoyée en ligne.
          await dbApi.addMedia(record, file);
          state.media.push(record);
          imported.push(record);
        } catch (error) {
          logError(`Enregistrement de ${file.name}`, error);
          if (isStorageError(error)) {
            storageFull = true;
            skipped.push({ name: file.name, reason: 'espace de stockage insuffisant' });
            files.slice(index + 1).forEach((rest) => skipped.push({ name: rest.name, reason: 'non traité (stockage plein)' }));
            break;
          }
          skipped.push({ name: file.name, reason: `erreur d'enregistrement (${describeError(error)})` });
        }
      }
    } finally {
      state.isImporting = false;
      hideProgress();
    }

    if (imported.length) {
      // Première importation : on demande au navigateur de conserver les données.
      requestPersistentStorage();
      render();
    }
    reportImportResult(imported, skipped, storageFull);
  }

  function reportImportResult(imported, skipped, storageFull) {
    const videosWithoutImage = imported.filter((item) => item.noVideoTrack);
    const videoHelp = videosWithoutImage.length
      ? `<p>Attention : aucune image n'a été détectée dans ${plural(videosWithoutImage.length, 'vidéo importée', 'vidéos importées')}
         (${videosWithoutImage.map((item) => escapeHtml(item.fileName)).join(', ')}). Elles pourraient être lues sans image.</p>`
      : '';
    if (!skipped.length) {
      if (videoHelp) alertDialog('Résultat de l\'importation', `${plural(imported.length, 'fichier importé', 'fichiers importés')}.`, videoHelp);
      else if (imported.length) showToast(`${plural(imported.length, 'fichier importé', 'fichiers importés')}.`);
      return;
    }
    const lines = skipped.map((item) => `<li><strong>${escapeHtml(item.name)}</strong> — ${escapeHtml(item.reason)}</li>`).join('');
    const intro = imported.length
      ? `${plural(imported.length, 'fichier importé', 'fichiers importés')}, ${plural(skipped.length, 'ignoré', 'ignorés')} :`
      : `Aucun fichier importé (${plural(skipped.length, 'fichier ignoré', 'fichiers ignorés')}) :`;
    const storageHelp = storageFull
      ? '<p>Le stockage local est plein. Libérez de l\'espace sur l\'iPhone ou supprimez des médias de la bibliothèque, puis réessayez.</p>'
      : '';
    alertDialog('Résultat de l\'importation', intro, `<ul>${lines}</ul>${storageHelp}${videoHelp}`);
  }

  function openFilePicker(kind) {
    const input = kind === 'video' ? elements.videoInput : elements.audioInput;
    input.value = '';
    input.click();
  }

  /* ------------------------------------------------------------------------
     9. Écrans (rendu HTML)
     ------------------------------------------------------------------------ */

  // Les URL d'objet des pochettes sont gardées en mémoire et libérées
  // quand le morceau est supprimé.
  const coverUrls = new Map();

  function coverUrl(item) {
    if (!item || !item.cover) return null;
    if (!coverUrls.has(item.id)) coverUrls.set(item.id, URL.createObjectURL(item.cover));
    return coverUrls.get(item.id);
  }

  function releaseCoverUrl(mediaId) {
    if (coverUrls.has(mediaId)) {
      URL.revokeObjectURL(coverUrls.get(mediaId));
      coverUrls.delete(mediaId);
    }
  }

  function thumbHtml(item) {
    const url = coverUrl(item);
    if (url) return `<img src="${url}" alt="" loading="lazy">`;
    return icon(item.kind === 'video' ? 'video' : 'music');
  }

  function viewHeader(title, { back = null, actionsHtml = '' } = {}) {
    const backButton = back
      ? `<button type="button" class="icon-btn back-btn" data-action="navigate" data-view="${back.view}"
           ${back.param ? `data-param="${escapeHtml(back.param)}"` : ''} aria-label="Retour">${icon('chevron-left')}</button>`
      : '';
    return `<header class="view-header">${backButton}<h1>${escapeHtml(title)}</h1>${actionsHtml}</header>`;
  }

  function emptyState(iconName, message, buttonHtml = '') {
    return `<div class="empty-state">${icon(iconName)}<p>${escapeHtml(message)}</p>${buttonHtml}</div>`;
  }

  function favoriteButton(item) {
    const label = item.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris';
    return `<button type="button" class="icon-btn ${item.favorite ? 'is-favorite' : ''}" data-action="toggle-favorite"
      data-id="${item.id}" aria-label="${label}" aria-pressed="${item.favorite}">${icon(item.favorite ? 'heart-fill' : 'heart')}</button>`;
  }

  function trackRow(track, index, { playlistId = null, position = 0, count = 0 } = {}) {
    const subParts = [track.artist || 'Artiste inconnu'];
    if (track.duration) subParts.push(formatTime(track.duration));
    const reorderButtons = playlistId ? `
      <button type="button" class="icon-btn" data-action="playlist-move" data-playlist="${playlistId}" data-position="${position}"
        data-direction="-1" aria-label="Monter" ${position === 0 ? 'disabled' : ''}>${icon('up')}</button>
      <button type="button" class="icon-btn" data-action="playlist-move" data-playlist="${playlistId}" data-position="${position}"
        data-direction="1" aria-label="Descendre" ${position === count - 1 ? 'disabled' : ''}>${icon('chevron-down')}</button>` : '';
    const menuAction = playlistId
      ? `data-action="playlist-track-menu" data-playlist="${playlistId}" data-position="${position}"`
      : 'data-action="track-menu"';
    return `
      <li class="row ${audioPlayer.currentId === track.id ? 'is-current' : ''}" data-action="play-from-list" data-index="${index}" data-id="${track.id}">
        <span class="thumb">${thumbHtml(track)}</span>
        <span class="row-text">
          <span class="row-title">${escapeHtml(displayTitle(track))}</span>
          <span class="row-sub">${escapeHtml(subParts.join(' · '))}</span>
        </span>
        <span class="row-actions">
          ${reorderButtons}
          ${playlistId ? '' : favoriteButton(track)}
          <button type="button" class="icon-btn" ${menuAction} data-id="${track.id}" aria-label="Options">${icon('more')}</button>
        </span>
      </li>`;
  }

  function videoRow(item) {
    const subParts = [];
    if (item.duration) subParts.push(formatTime(item.duration));
    subParts.push(formatSize(item.size));
    if (item.lastPosition > RESUME_MIN_SECONDS) subParts.push(`reprise à ${formatTime(item.lastPosition)}`);
    const resumePercent = item.duration && item.lastPosition > RESUME_MIN_SECONDS
      ? Math.min(100, (item.lastPosition / item.duration) * 100)
      : 0;
    const warning = item.noVideoTrack ? ' <span class="badge">image ?</span>' : '';
    return `
      <li class="row" data-action="open-video" data-id="${item.id}">
        <span class="thumb thumb-video">${icon('video')}${resumePercent ? `<span class="resume-bar" style="width:${resumePercent}%"></span>` : ''}</span>
        <span class="row-text">
          <span class="row-title">${escapeHtml(displayTitle(item))}${warning}</span>
          <span class="row-sub">${escapeHtml(subParts.join(' · '))}</span>
        </span>
        <span class="row-actions">
          ${favoriteButton(item)}
          <button type="button" class="icon-btn" data-action="video-menu" data-id="${item.id}" aria-label="Options">${icon('more')}</button>
        </span>
      </li>`;
  }

  function sortItems(items, sortMode) {
    const sorted = items.slice();
    if (sortMode === 'date') sorted.sort((a, b) => b.addedAt - a.addedAt);
    else sorted.sort((a, b) => collator.compare(displayTitle(a), displayTitle(b)));
    return sorted;
  }

  function matchesSearch(item, query) {
    if (!query) return true;
    const haystack = normalizeText([item.title, item.artist, item.album, item.fileName].join(' '));
    return normalizeText(query).split(/\s+/).every((word) => haystack.includes(word));
  }

  function sortSelect(id, value) {
    return `
      <select class="select" id="${id}" aria-label="Trier">
        <option value="name" ${value === 'name' ? 'selected' : ''}>Nom</option>
        <option value="date" ${value === 'date' ? 'selected' : ''}>Ajout récent</option>
      </select>`;
  }

  function searchField(id, value, placeholder) {
    return `
      <label class="search-field">
        ${icon('search')}
        <span class="visually-hidden">Rechercher</span>
        <input class="search-input" id="${id}" type="search" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}"
          autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="search">
      </label>`;
  }

  /* ---- Écran : Bibliothèque (accueil) ---- */

  function renderLibrary() {
    const tracks = audioTracks();
    const videos = videoItems();
    const favoritesCount = state.media.filter((item) => item.favorite).length;
    const totalBytes = state.media.reduce((sum, item) => sum + item.size, 0);

    const installHint = isIos && !isStandalone() && !state.preferences.installHintDismissed ? `
      <div class="card hint-card">
        <button type="button" class="icon-btn" data-action="dismiss-install-hint" aria-label="Masquer ce conseil">${icon('close')}</button>
        <p><strong>Installez Pocket Player :</strong> touchez Partager, puis « Sur l'écran d'accueil ».</p>
        <p class="muted">Importez vos fichiers depuis l'application installée : sur iPhone, les fichiers importés dans Safari ne sont pas partagés avec l'icône de l'écran d'accueil.</p>
      </div>` : '';

    const databaseWarning = state.databaseReady ? '' : `
      <div class="card hint-card">
        <p><strong>Stockage local indisponible.</strong></p>
        <p class="muted">IndexedDB n'a pas pu être ouvert (navigation privée ou stockage bloqué ?). Les fichiers ne peuvent pas être conservés.</p>
      </div>`;

    const recent = state.media.slice().sort((a, b) => b.addedAt - a.addedAt).slice(0, 5);
    const recentHtml = recent.length ? `
      <section class="section">
        <h2 class="section-title">Ajouts récents</h2>
        <ul class="media-list">
          ${recent.map((item) => (item.kind === 'video' ? videoRow(item) : `
            <li class="row ${audioPlayer.currentId === item.id ? 'is-current' : ''}" data-action="play-single" data-id="${item.id}">
              <span class="thumb">${thumbHtml(item)}</span>
              <span class="row-text">
                <span class="row-title">${escapeHtml(displayTitle(item))}</span>
                <span class="row-sub">${escapeHtml(item.artist || 'Artiste inconnu')}</span>
              </span>
            </li>`)).join('')}
        </ul>
      </section>` : emptyState('library', 'Aucun média pour le moment. Importez vos premiers morceaux ou vos vidéos.');

    elements.view.innerHTML = `
      ${viewHeader('Pocket Player', {
        actionsHtml: `<button type="button" class="icon-btn" data-action="navigate" data-view="settings" aria-label="Réglages">${icon('settings')}</button>`,
      })}
      ${databaseWarning}
      ${installHint}
      <div class="btn-row section" style="margin-top:12px">
        <button type="button" class="btn btn-accent" data-action="import" data-kind="audio">${icon('upload')}Importer de la musique</button>
        <button type="button" class="btn" data-action="import" data-kind="video">${icon('upload')}Importer des vidéos</button>
      </div>
      <section class="section">
        <div class="stat-grid">
          <button type="button" class="stat-card" data-action="navigate" data-view="music">
            ${icon('music')}<span><span class="stat-label">Musique</span><br><span class="stat-value">${plural(tracks.length, 'morceau', 'morceaux')}</span></span>
          </button>
          <button type="button" class="stat-card" data-action="navigate" data-view="videos">
            ${icon('video')}<span><span class="stat-label">Vidéos</span><br><span class="stat-value">${plural(videos.length, 'vidéo', 'vidéos')}</span></span>
          </button>
          <button type="button" class="stat-card" data-action="navigate" data-view="favorites">
            ${icon('heart')}<span><span class="stat-label">Favoris</span><br><span class="stat-value">${plural(favoritesCount, 'élément', 'éléments')}</span></span>
          </button>
          <button type="button" class="stat-card" data-action="navigate" data-view="playlists">
            ${icon('list')}<span><span class="stat-label">Playlists</span><br><span class="stat-value">${plural(state.playlists.length, 'playlist', 'playlists')}</span></span>
          </button>
        </div>
      </section>
      ${recentHtml}
      <p class="storage-line">${plural(state.media.length, 'fichier importé', 'fichiers importés')} · ${formatSize(totalBytes)} sur cet appareil</p>`;
  }

  /* ---- Écran : Musique ---- */

  function renderMusic() {
    const hasTracks = audioTracks().length > 0;
    elements.view.innerHTML = `
      ${viewHeader('Musique', {
        actionsHtml: `<button type="button" class="icon-btn" data-action="import" data-kind="audio" aria-label="Importer de la musique">${icon('plus')}</button>`,
      })}
      ${hasTracks ? `
        <div class="toolbar">
          ${searchField('music-search', state.search.music, 'Titre, artiste, fichier…')}
          ${sortSelect('music-sort', state.preferences.musicSort)}
        </div>
        <div class="btn-row" style="margin-bottom:8px">
          <button type="button" class="btn" data-action="play-visible" data-shuffle="false">${icon('play')}Tout lire</button>
          <button type="button" class="btn" data-action="play-visible" data-shuffle="true">${icon('shuffle')}Aléatoire</button>
        </div>
        <div class="list-meta" id="music-count"></div>
        <ul class="media-list" id="music-list"></ul>`
        : emptyState('music', 'Aucune musique pour le moment. Importez vos premiers morceaux.',
          `<button type="button" class="btn btn-accent" data-action="import" data-kind="audio">${icon('upload')}Importer de la musique</button>`)}`;
    if (hasTracks) updateMusicList();
  }

  // Ne redessine que la liste (garde le clavier ouvert pendant la recherche).
  function updateMusicList() {
    const list = $('#music-list');
    if (!list) return;
    const query = state.search.music;
    const tracks = sortItems(audioTracks(), state.preferences.musicSort).filter((track) => matchesSearch(track, query));
    state.visibleTrackIds = tracks.map((track) => track.id);
    $('#music-count').textContent = query
      ? `${plural(tracks.length, 'résultat', 'résultats')}`
      : plural(tracks.length, 'morceau', 'morceaux');
    list.innerHTML = tracks.length
      ? tracks.map((track, index) => trackRow(track, index)).join('')
      : `<li>${emptyState('search', `Aucun résultat pour « ${query} ».`)}</li>`;
  }

  /* ---- Écran : Vidéos ---- */

  function renderVideos() {
    const hasVideos = videoItems().length > 0;
    elements.view.innerHTML = `
      ${viewHeader('Vidéos', {
        actionsHtml: `<button type="button" class="icon-btn" data-action="import" data-kind="video" aria-label="Importer des vidéos">${icon('plus')}</button>`,
      })}
      ${hasVideos ? `
        <div class="toolbar">
          ${searchField('video-search', state.search.videos, 'Nom de la vidéo…')}
          ${sortSelect('video-sort', state.preferences.videoSort)}
        </div>
        <div class="list-meta" id="video-count"></div>
        <ul class="media-list" id="video-list"></ul>`
        : emptyState('video', 'Aucune vidéo pour le moment. Importez vos premières vidéos MP4.',
          `<button type="button" class="btn btn-accent" data-action="import" data-kind="video">${icon('upload')}Importer des vidéos</button>`)}`;
    if (hasVideos) updateVideoList();
  }

  function updateVideoList() {
    const list = $('#video-list');
    if (!list) return;
    const query = state.search.videos;
    const videos = sortItems(videoItems(), state.preferences.videoSort).filter((item) => matchesSearch(item, query));
    $('#video-count').textContent = query
      ? plural(videos.length, 'résultat', 'résultats')
      : plural(videos.length, 'vidéo', 'vidéos');
    list.innerHTML = videos.length
      ? videos.map(videoRow).join('')
      : `<li>${emptyState('search', `Aucun résultat pour « ${query} ».`)}</li>`;
  }

  /* ---- Écran : Favoris ---- */

  function renderFavorites() {
    const tab = state.preferences.favoritesTab;
    const favoriteTracks = sortItems(audioTracks().filter((item) => item.favorite), 'name');
    const favoriteVideos = sortItems(videoItems().filter((item) => item.favorite), 'name');
    let listHtml;
    if (tab === 'audio') {
      state.visibleTrackIds = favoriteTracks.map((track) => track.id);
      listHtml = favoriteTracks.length
        ? `<ul class="media-list">${favoriteTracks.map((track, index) => trackRow(track, index)).join('')}</ul>`
        : emptyState('heart', 'Aucun morceau favori. Touchez le cœur à côté d\'un morceau pour l\'ajouter ici.');
    } else {
      listHtml = favoriteVideos.length
        ? `<ul class="media-list">${favoriteVideos.map(videoRow).join('')}</ul>`
        : emptyState('heart', 'Aucune vidéo favorite. Touchez le cœur à côté d\'une vidéo pour l\'ajouter ici.');
    }
    elements.view.innerHTML = `
      ${viewHeader('Favoris', { back: { view: 'library' } })}
      <div class="segmented" role="group" aria-label="Type de favoris">
        <button type="button" data-action="favorites-tab" data-tab-value="audio" aria-pressed="${tab === 'audio'}">Musique (${favoriteTracks.length})</button>
        <button type="button" data-action="favorites-tab" data-tab-value="video" aria-pressed="${tab === 'video'}">Vidéos (${favoriteVideos.length})</button>
      </div>
      ${tab === 'audio' && favoriteTracks.length ? `
        <div class="btn-row" style="margin-bottom:8px">
          <button type="button" class="btn" data-action="play-visible" data-shuffle="false">${icon('play')}Tout lire</button>
          <button type="button" class="btn" data-action="play-visible" data-shuffle="true">${icon('shuffle')}Aléatoire</button>
        </div>` : ''}
      ${listHtml}`;
  }

  /* ---- Écran : Playlists ---- */

  function playlistTracks(playlist) {
    return playlist.trackIds.map(findMedia).filter(Boolean);
  }

  function renderPlaylists() {
    const playlists = state.playlists.slice().sort((a, b) => collator.compare(a.name, b.name));
    elements.view.innerHTML = `
      ${viewHeader('Playlists', {
        back: { view: 'library' },
        actionsHtml: `<button type="button" class="icon-btn" data-action="create-playlist" aria-label="Nouvelle playlist">${icon('plus')}</button>`,
      })}
      ${playlists.length ? `
        <ul class="media-list">
          ${playlists.map((playlist) => {
            const tracks = playlistTracks(playlist);
            const duration = tracks.reduce((sum, track) => sum + (track.duration || 0), 0);
            const firstCover = tracks.find((track) => track.cover);
            return `
              <li class="row" data-action="navigate" data-view="playlist" data-param="${playlist.id}">
                <span class="thumb">${firstCover ? thumbHtml(firstCover) : icon('list')}</span>
                <span class="row-text">
                  <span class="row-title">${escapeHtml(playlist.name)}</span>
                  <span class="row-sub">${plural(tracks.length, 'morceau', 'morceaux')}${duration ? ` · ${formatTime(duration)}` : ''}</span>
                </span>
                <span class="row-actions">${icon('chevron-right')}</span>
              </li>`;
          }).join('')}
        </ul>`
        : emptyState('list', 'Aucune playlist pour le moment.',
          `<button type="button" class="btn btn-accent" data-action="create-playlist">${icon('plus')}Créer une playlist</button>`)}`;
  }

  function renderPlaylistDetail() {
    const playlist = findPlaylist(state.route.param);
    if (!playlist) {
      elements.view.innerHTML = `${viewHeader('Playlist', { back: { view: 'playlists' } })}
        ${emptyState('list', 'Cette playlist n\'existe plus.')}`;
      return;
    }
    const tracks = playlistTracks(playlist);
    state.visibleTrackIds = tracks.map((track) => track.id);
    elements.view.innerHTML = `
      ${viewHeader(playlist.name, {
        back: { view: 'playlists' },
        actionsHtml: `<button type="button" class="icon-btn" data-action="playlist-menu" data-playlist="${playlist.id}" aria-label="Options de la playlist">${icon('more')}</button>`,
      })}
      <div class="btn-row" style="margin-bottom:8px">
        <button type="button" class="btn" data-action="play-visible" data-shuffle="false" ${tracks.length ? '' : 'disabled'}>${icon('play')}Lire</button>
        <button type="button" class="btn" data-action="play-visible" data-shuffle="true" ${tracks.length ? '' : 'disabled'}>${icon('shuffle')}Aléatoire</button>
        <button type="button" class="btn" data-action="playlist-add-tracks" data-playlist="${playlist.id}">${icon('plus')}Ajouter</button>
      </div>
      <div class="list-meta">${plural(tracks.length, 'morceau', 'morceaux')}</div>
      ${tracks.length
        ? `<ul class="media-list">${tracks.map((track, index) => trackRow(track, index, {
          playlistId: playlist.id, position: index, count: tracks.length,
        })).join('')}</ul>`
        : emptyState('music', 'Cette playlist est vide. Ajoutez-y des morceaux de votre bibliothèque.')}`;
  }

  /* ---- Écran : Réglages et stockage ---- */

  function renderSettings() {
    const totalBytes = state.media.reduce((sum, item) => sum + item.size, 0);
    const errorsHtml = state.errors.length
      ? `<ul class="error-log">${state.errors.map((entry) => `
          <li><time>${entry.time.toLocaleTimeString('fr-FR')}</time> — <strong>${escapeHtml(entry.context)}</strong> : ${escapeHtml(entry.message)}</li>`).join('')}</ul>
         <button type="button" class="btn btn-small" data-action="clear-errors">Effacer le journal</button>`
      : '<p class="text-block">Aucune erreur enregistrée pendant cette session.</p>';

    elements.view.innerHTML = `
      ${viewHeader('Réglages', { back: { view: 'library' } })}

      <section class="section">
        <h2 class="section-title">Stockage sur l'iPhone</h2>
        <div class="card">
          <ul class="settings-list">
            <li><span>Morceaux</span><span class="value">${audioTracks().length}</span></li>
            <li><span>Vidéos</span><span class="value">${videoItems().length}</span></li>
            <li><span>Taille de la bibliothèque</span><span class="value">${formatSize(totalBytes)}</span></li>
            <li><span>Espace utilisé / quota estimé</span><span class="value" id="storage-estimate">calcul…</span></li>
            <li><span>Stockage persistant</span><span class="value" id="storage-persisted">vérification…</span></li>
          </ul>
          <div class="meter" aria-hidden="true"><div class="meter-fill" id="storage-meter" style="width:0%"></div></div>
          <button type="button" class="btn btn-small" data-action="request-persist">Demander le stockage persistant</button>
        </div>
        <p class="text-block" style="margin-top:12px">
          Les fichiers sont copiés dans le stockage du navigateur (IndexedDB), uniquement sur cet appareil.
          iOS limite cet espace et peut l'effacer si l'iPhone manque de place, si vous effacez les données de Safari
          ou si vous supprimez l'icône de l'écran d'accueil. <strong>Gardez toujours vos fichiers originaux</strong>
          dans l'application Fichiers.
        </p>
      </section>

      <section class="section">
        <h2 class="section-title">Sauvegarde</h2>
        <div class="card">
          <p class="text-block">Exporte vos favoris, playlists et positions de lecture dans un petit fichier .json
            (sans les médias). Après une réinstallation, réimportez vos fichiers puis cette sauvegarde.</p>
          <div class="btn-row">
            <button type="button" class="btn" data-action="export-backup">Exporter</button>
            <button type="button" class="btn" data-action="import-backup">Importer une sauvegarde</button>
          </div>
        </div>
      </section>

      <section class="section">
        <h2 class="section-title">Hors ligne et mises à jour</h2>
        <div class="card">
          <ul class="settings-list">
            <li><span>Mode hors ligne</span><span class="value" id="offline-status">vérification…</span></li>
            <li><span>Version de l'application</span><span class="value" id="app-version">—</span></li>
            <li><span>Lancée depuis l'écran d'accueil</span><span class="value">${isStandalone() ? 'oui' : 'non'}</span></li>
          </ul>
          <button type="button" class="btn btn-small" data-action="check-update" style="margin-top:10px">Rechercher une mise à jour</button>
        </div>
      </section>

      <section class="section">
        <h2 class="section-title">Lecture en arrière-plan</h2>
        <div class="card">
          <p class="text-block">Pocket Player transmet le titre, l'artiste et la pochette à iOS et répond aux commandes
            lecture, pause, précédent, suivant (écran verrouillé, Centre de contrôle, écouteurs) quand iOS les propose.</p>
          <p class="text-block"><strong>Limite d'iOS :</strong> pour une application web, iOS ne garantit pas que la
            musique continue lorsque l'écran est verrouillé ou que vous changez d'application, ni que le morceau suivant
            démarre tout seul en arrière-plan. Le comportement varie selon la version d'iOS.</p>
        </div>
      </section>

      <section class="section">
        <h2 class="section-title">Confidentialité</h2>
        <div class="card">
          <p class="text-block">Aucun compte, aucune publicité, aucune mesure d'audience. Vos fichiers ne quittent jamais
            l'appareil : le site ne contient que le code de l'application.</p>
        </div>
      </section>

      <section class="section">
        <h2 class="section-title">Journal des erreurs</h2>
        <div class="card">${errorsHtml}</div>
      </section>

      <section class="section">
        <h2 class="section-title">Zone de danger</h2>
        <button type="button" class="btn btn-danger btn-block" data-action="clear-library">${icon('trash')}Supprimer toute la bibliothèque</button>
      </section>`;

    fillSettingsAsync();
  }

  async function fillSettingsAsync() {
    const estimate = await getStorageEstimate();
    const estimateCell = $('#storage-estimate');
    if (estimateCell) {
      if (estimate && estimate.quota) {
        estimateCell.textContent = `${formatSize(estimate.usage)} / ${formatSize(estimate.quota)}`;
        $('#storage-meter').style.width = `${Math.min(100, (estimate.usage / estimate.quota) * 100).toFixed(1)}%`;
      } else {
        estimateCell.textContent = 'non communiqué';
      }
    }
    const persisted = await isStoragePersisted();
    const persistedCell = $('#storage-persisted');
    if (persistedCell) persistedCell.textContent = persisted === null ? 'non pris en charge' : (persisted ? 'accordé' : 'non accordé');

    const offlineCell = $('#offline-status');
    if (offlineCell) {
      if (!('serviceWorker' in navigator)) offlineCell.textContent = 'non pris en charge';
      else offlineCell.textContent = navigator.serviceWorker.controller ? 'prêt' : 'pas encore prêt (rechargez une fois)';
    }
    const version = await getServiceWorkerVersion();
    const versionCell = $('#app-version');
    if (versionCell) versionCell.textContent = version || 'inconnue';
  }

  /* ---- Routeur : l'écran affiché dépend de l'adresse après le « # » ---- */

  const views = {
    library: renderLibrary,
    music: renderMusic,
    videos: renderVideos,
    favorites: renderFavorites,
    playlists: renderPlaylists,
    playlist: renderPlaylistDetail,
    settings: renderSettings,
  };

  const tabForView = {
    library: 'library', favorites: 'library', playlists: 'library', playlist: 'library', settings: 'library',
    music: 'music', videos: 'videos',
  };

  function parseRoute() {
    const [viewName, param] = location.hash.replace(/^#\/?/, '').split('/');
    if (views[viewName]) return { view: viewName, param: param ? decodeURIComponent(param) : null };
    return { view: 'library', param: null };
  }

  function navigate(viewName, param = null) {
    const hash = `#/${viewName}${param ? `/${encodeURIComponent(param)}` : ''}`;
    if (location.hash === hash) render();
    else location.hash = hash;
  }

  function render() {
    state.route = parseRoute();
    views[state.route.view]();
    const activeTab = tabForView[state.route.view];
    $$('.tab').forEach((tab) => {
      if (tab.dataset.tab === activeTab) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    });
  }

  /* ------------------------------------------------------------------------
     10. Lecteur audio
     ------------------------------------------------------------------------
     Un seul élément <audio> sert pour tous les morceaux. Sur iOS, un élément
     qui a déjà été lancé par un geste de l'utilisateur peut ensuite enchaîner
     les morceaux sans nouveau geste : c'est ce qui permet la lecture suivante
     automatique.
     ------------------------------------------------------------------------ */

  const audioPlayer = {
    queue: [],            // ordre de lecture effectif (mélangé ou non)
    originalQueue: [],    // ordre d'origine, pour désactiver l'aléatoire
    index: -1,
    currentId: null,
    currentUrl: null,     // URL d'objet du morceau en cours
    shuffle: false,
    repeat: 'off',        // 'off' | 'all' | 'one'
    contextLabel: '',
    isSeeking: false,
    loadToken: 0,         // empêche deux chargements simultanés de se croiser
    unlocked: false,
    lastPositionStateUpdate: 0,
  };

  // Petit son silencieux généré localement, utilisé une seule fois pour
  // « déverrouiller » l'élément audio au premier toucher (exigence d'iOS).
  let silentAudioUrl = null;

  function getSilentAudioUrl() {
    if (silentAudioUrl) return silentAudioUrl;
    const sampleRate = 8000;
    const sampleCount = 800;
    const buffer = new ArrayBuffer(44 + sampleCount * 2);
    const view = new DataView(buffer);
    const writeText = (offset, text) => [...text].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
    writeText(0, 'RIFF');
    view.setUint32(4, 36 + sampleCount * 2, true);
    writeText(8, 'WAVE');
    writeText(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeText(36, 'data');
    view.setUint32(40, sampleCount * 2, true);
    silentAudioUrl = URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
    return silentAudioUrl;
  }

  // À appeler directement dans un gestionnaire de toucher, avant toute attente.
  function unlockAudioElement() {
    if (audioPlayer.unlocked) return;
    audioPlayer.unlocked = true;
    const audio = elements.audio;
    if (!audio.getAttribute('src')) audio.src = getSilentAudioUrl();
    const attempt = audio.play();
    if (attempt && typeof attempt.catch === 'function') attempt.catch(() => {});
  }

  function isPlayingRealTrack() {
    return Boolean(audioPlayer.currentId) && elements.audio.src === audioPlayer.currentUrl;
  }

  async function playQueue(trackIds, startIndex, contextLabel, { forceShuffle = null } = {}) {
    if (!trackIds.length) return;
    unlockAudioElement();
    if (forceShuffle !== null) audioPlayer.shuffle = forceShuffle;
    audioPlayer.originalQueue = trackIds.slice();
    audioPlayer.contextLabel = contextLabel;
    const startId = trackIds[startIndex] || trackIds[0];
    if (audioPlayer.shuffle) {
      audioPlayer.queue = forceShuffle
        ? shuffleArray(trackIds)
        : [startId, ...shuffleArray(trackIds.filter((id) => id !== startId))];
      await loadTrackAt(0, true);
    } else {
      audioPlayer.queue = trackIds.slice();
      await loadTrackAt(Math.max(0, trackIds.indexOf(startId)), true);
    }
  }

  async function loadTrackAt(queueIndex, autoplay) {
    const trackId = audioPlayer.queue[queueIndex];
    const track = findMedia(trackId);
    if (!track) return;
    const token = audioPlayer.loadToken + 1;
    audioPlayer.loadToken = token;

    let blob = null;
    try {
      blob = await dbApi.getFile(trackId);
    } catch (error) {
      logError(`Lecture de ${track.fileName}`, error);
    }
    if (token !== audioPlayer.loadToken) return; // un autre morceau a été demandé entre-temps
    if (!blob) {
      showToast(`Fichier introuvable dans le stockage local : ${track.fileName}`, { isError: true });
      return;
    }

    const previousUrl = audioPlayer.currentUrl;
    audioPlayer.currentUrl = URL.createObjectURL(blob);
    audioPlayer.index = queueIndex;
    audioPlayer.currentId = trackId;
    elements.audio.src = audioPlayer.currentUrl;
    // L'ancienne URL n'est plus utilisée par le lecteur : on peut la libérer.
    if (previousUrl) URL.revokeObjectURL(previousUrl);

    $('#player-hint').textContent = '';
    updateMediaSessionMetadata(track);
    updatePlayerUi();
    highlightCurrentRows();

    if (autoplay) {
      try {
        await elements.audio.play();
      } catch (error) {
        if (error.name === 'NotAllowedError') {
          $('#player-hint').textContent = 'Touchez le bouton lecture pour démarrer.';
        } else if (error.name !== 'AbortError') {
          logError(`Démarrage de ${track.fileName}`, error);
        }
      }
    }
  }

  function stopAudio() {
    audioPlayer.loadToken += 1;
    elements.audio.pause();
    elements.audio.removeAttribute('src');
    elements.audio.load();
    if (audioPlayer.currentUrl) URL.revokeObjectURL(audioPlayer.currentUrl);
    Object.assign(audioPlayer, { queue: [], originalQueue: [], index: -1, currentId: null, currentUrl: null });
    if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
    closePlayerSheet();
    updatePlayerUi();
    highlightCurrentRows();
  }

  function togglePlay() {
    const audio = elements.audio;
    if (!audioPlayer.currentId) {
      const tracks = sortItems(audioTracks(), state.preferences.musicSort);
      if (!tracks.length) {
        showToast('Importez d\'abord de la musique.');
        return;
      }
      playQueue(tracks.map((track) => track.id), 0, 'Musique');
      return;
    }
    if (audio.paused) {
      audio.play().catch((error) => {
        if (error.name !== 'AbortError') logError('Reprise de la lecture', error);
      });
    } else {
      audio.pause();
    }
  }

  function playNext({ fromEnded = false } = {}) {
    if (!audioPlayer.currentId) return;
    if (audioPlayer.index < audioPlayer.queue.length - 1) {
      loadTrackAt(audioPlayer.index + 1, true);
    } else if (audioPlayer.repeat === 'all' || !fromEnded) {
      // Fin de file : on repart du début (automatiquement si « répéter tout »).
      loadTrackAt(0, audioPlayer.repeat === 'all' || !elements.audio.paused || fromEnded);
    } else {
      elements.audio.currentTime = 0;
      updatePlayerUi();
    }
  }

  function playPrevious() {
    if (!audioPlayer.currentId) return;
    const audio = elements.audio;
    if (audio.currentTime > 3 || (audioPlayer.index === 0 && audioPlayer.repeat !== 'all')) {
      audio.currentTime = 0;
      return;
    }
    const previousIndex = audioPlayer.index > 0 ? audioPlayer.index - 1 : audioPlayer.queue.length - 1;
    loadTrackAt(previousIndex, true);
  }

  function handleTrackEnded() {
    if (audioPlayer.repeat === 'one') {
      elements.audio.currentTime = 0;
      elements.audio.play().catch(() => {});
      return;
    }
    if (audioPlayer.index >= audioPlayer.queue.length - 1 && audioPlayer.repeat !== 'all') {
      // Fin de la file sans répétition : on s'arrête sur le premier morceau.
      loadTrackAt(0, false);
      return;
    }
    playNext({ fromEnded: true });
  }

  function toggleShuffle() {
    audioPlayer.shuffle = !audioPlayer.shuffle;
    if (audioPlayer.currentId) {
      if (audioPlayer.shuffle) {
        const others = audioPlayer.originalQueue.filter((id) => id !== audioPlayer.currentId);
        audioPlayer.queue = [audioPlayer.currentId, ...shuffleArray(others)];
        audioPlayer.index = 0;
      } else {
        audioPlayer.queue = audioPlayer.originalQueue.slice();
        audioPlayer.index = Math.max(0, audioPlayer.queue.indexOf(audioPlayer.currentId));
      }
    }
    showToast(audioPlayer.shuffle ? 'Lecture aléatoire activée' : 'Lecture aléatoire désactivée', { duration: 1500 });
    updatePlayerUi();
  }

  function cycleRepeat() {
    const order = ['off', 'all', 'one'];
    audioPlayer.repeat = order[(order.indexOf(audioPlayer.repeat) + 1) % order.length];
    const labels = { off: 'Répétition désactivée', all: 'Répéter la liste', one: 'Répéter le morceau' };
    showToast(labels[audioPlayer.repeat], { duration: 1500 });
    updatePlayerUi();
  }

  function seekTo(seconds) {
    const audio = elements.audio;
    if (!Number.isFinite(audio.duration)) return;
    audio.currentTime = Math.max(0, Math.min(seconds, audio.duration));
  }

  function setPlayIcon(button, isPlaying) {
    button.innerHTML = icon(isPlaying ? 'pause' : 'play');
    button.setAttribute('aria-label', isPlaying ? 'Pause' : 'Lecture');
  }

  function updatePlayerUi() {
    const track = findMedia(audioPlayer.currentId);
    const isPlaying = isPlayingRealTrack() && !elements.audio.paused;
    const showMini = Boolean(track) && !elements.videoScreen.classList.contains('is-open');
    elements.miniPlayer.hidden = !showMini;
    document.body.classList.toggle('has-mini-player', showMini);

    setPlayIcon($('#mini-play'), isPlaying);
    setPlayIcon($('#player-play'), isPlaying);

    const title = track ? displayTitle(track) : '—';
    const artist = track ? (track.artist || 'Artiste inconnu') : '';
    $('#mini-title').textContent = title;
    $('#mini-artist').textContent = artist;
    $('#player-title').textContent = title;
    $('#player-artist').textContent = artist;
    const queuePosition = track ? ` · ${audioPlayer.index + 1}/${audioPlayer.queue.length}` : '';
    $('#player-context').textContent = track ? `${audioPlayer.contextLabel}${queuePosition}` : '';

    const url = coverUrl(track);
    $('#mini-cover').innerHTML = url ? `<img src="${url}" alt="">` : icon('music');
    $('#player-cover').innerHTML = url ? `<img src="${url}" alt="Pochette">` : icon('music');

    const favoriteBtn = $('#player-favorite');
    const isFavorite = Boolean(track && track.favorite);
    favoriteBtn.innerHTML = icon(isFavorite ? 'heart-fill' : 'heart');
    favoriteBtn.setAttribute('aria-pressed', String(isFavorite));
    favoriteBtn.setAttribute('aria-label', isFavorite ? 'Retirer des favoris' : 'Ajouter aux favoris');

    const shuffleBtn = $('#shuffle-btn');
    shuffleBtn.setAttribute('aria-pressed', String(audioPlayer.shuffle));
    const repeatBtn = $('#repeat-btn');
    repeatBtn.setAttribute('aria-pressed', String(audioPlayer.repeat !== 'off'));
    repeatBtn.innerHTML = icon(audioPlayer.repeat === 'one' ? 'repeat-one' : 'repeat');
    repeatBtn.setAttribute('aria-label', {
      off: 'Répétition désactivée', all: 'Répéter la liste', one: 'Répéter le morceau',
    }[audioPlayer.repeat]);

    updateProgressUi();
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = track ? (isPlaying ? 'playing' : 'paused') : 'none';
    }
  }

  function updateProgressUi() {
    const audio = elements.audio;
    const hasTrack = isPlayingRealTrack();
    const duration = hasTrack && Number.isFinite(audio.duration) ? audio.duration : 0;
    const current = hasTrack ? audio.currentTime : 0;
    const seekBar = elements.seekBar;
    if (!audioPlayer.isSeeking) {
      seekBar.max = String(duration || 0);
      seekBar.value = String(current);
      $('#time-current').textContent = formatTime(current);
    }
    $('#time-total').textContent = formatTime(duration);
    const percent = duration ? (Number(seekBar.value) / duration) * 100 : 0;
    seekBar.style.setProperty('--progress', `${percent}%`);
    $('#mini-progress').style.width = `${duration ? (current / duration) * 100 : 0}%`;
  }

  function highlightCurrentRows() {
    $$('.row[data-id]').forEach((row) => {
      const isTrackRow = row.dataset.action === 'play-from-list' || row.dataset.action === 'play-single';
      row.classList.toggle('is-current', isTrackRow && row.dataset.id === audioPlayer.currentId);
    });
  }

  function openPlayerSheet() {
    if (!audioPlayer.currentId) return;
    elements.playerSheet.classList.add('is-open');
    elements.playerSheet.setAttribute('aria-hidden', 'false');
    document.body.classList.add('no-scroll');
    updatePlayerUi();
  }

  function closePlayerSheet() {
    elements.playerSheet.classList.remove('is-open');
    elements.playerSheet.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('no-scroll');
  }

  /* ---- Commandes système (écran verrouillé, Centre de contrôle, écouteurs) ---- */

  function activeMediaElement() {
    return elements.videoScreen.classList.contains('is-open') ? elements.video : elements.audio;
  }

  function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const handlers = {
      play: () => activeMediaElement().play().catch(() => {}),
      pause: () => activeMediaElement().pause(),
      previoustrack: () => { if (activeMediaElement() === elements.audio) playPrevious(); },
      nexttrack: () => { if (activeMediaElement() === elements.audio) playNext(); },
      seekto: (details) => {
        const element = activeMediaElement();
        if (details.fastSeek && typeof element.fastSeek === 'function') element.fastSeek(details.seekTime);
        else element.currentTime = details.seekTime;
      },
    };
    Object.entries(handlers).forEach(([action, handler]) => {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch (error) {
        // Action non prise en charge par cette version d'iOS : on l'ignore.
      }
    });
  }

  function updateMediaSessionMetadata(item) {
    if (!('mediaSession' in navigator) || typeof window.MediaMetadata !== 'function') return;
    const url = coverUrl(item);
    const artwork = url
      ? [{ src: url, sizes: '512x512', type: item.cover.type || 'image/jpeg' }]
      : [{ src: new URL('icons/icon-512.png', document.baseURI).href, sizes: '512x512', type: 'image/png' }];
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: displayTitle(item),
        artist: item.artist || (item.kind === 'video' ? 'Vidéo' : ''),
        album: item.album || 'Pocket Player',
        artwork,
      });
    } catch (error) {
      logError('Informations de lecture système', error);
    }
  }

  function updatePositionState(element) {
    if (!('mediaSession' in navigator) || typeof navigator.mediaSession.setPositionState !== 'function') return;
    const now = Date.now();
    if (now - audioPlayer.lastPositionStateUpdate < 1000) return;
    audioPlayer.lastPositionStateUpdate = now;
    if (!Number.isFinite(element.duration) || element.duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: element.duration,
        playbackRate: element.playbackRate || 1,
        position: Math.min(element.currentTime, element.duration),
      });
    } catch (error) {
      // Certaines versions d'iOS refusent des valeurs transitoires : sans gravité.
    }
  }

  function bindAudioEvents() {
    const audio = elements.audio;
    audio.addEventListener('play', updatePlayerUi);
    audio.addEventListener('pause', updatePlayerUi);
    audio.addEventListener('playing', updatePlayerUi);
    audio.addEventListener('timeupdate', () => {
      if (!isPlayingRealTrack()) return;
      updateProgressUi();
      updatePositionState(audio);
    });
    audio.addEventListener('loadedmetadata', () => {
      if (!isPlayingRealTrack()) return;
      const track = findMedia(audioPlayer.currentId);
      // Durée inconnue à l'importation : on la complète maintenant.
      if (track && !track.duration && Number.isFinite(audio.duration)) {
        track.duration = audio.duration;
        dbApi.putMedia(track).catch((error) => logError('Mise à jour de la durée', error));
      }
      updateProgressUi();
    });
    audio.addEventListener('ended', () => {
      if (isPlayingRealTrack()) handleTrackEnded();
    });
    audio.addEventListener('error', () => {
      if (!isPlayingRealTrack()) return; // erreurs du son silencieux de déverrouillage ignorées
      const track = findMedia(audioPlayer.currentId);
      const message = mediaErrorMessage(audio.error ? audio.error.code : 0, 'audio');
      logError(`Lecture audio : ${track ? track.fileName : ''}`, message);
      $('#player-hint').textContent = message;
      showToast(`${track ? displayTitle(track) : 'Morceau'} : ${message}`, { isError: true, duration: 6000 });
      updatePlayerUi();
    });

    const seekBar = elements.seekBar;
    seekBar.addEventListener('input', () => {
      audioPlayer.isSeeking = true;
      $('#time-current').textContent = formatTime(Number(seekBar.value));
      updateProgressUi();
    });
    seekBar.addEventListener('change', () => {
      seekTo(Number(seekBar.value));
      audioPlayer.isSeeking = false;
      updateProgressUi();
    });
  }

  /* ------------------------------------------------------------------------
     11. Lecteur vidéo
     ------------------------------------------------------------------------ */

  const videoPlayer = {
    currentId: null,
    currentUrl: null,
    pendingResumePosition: null, // position à restaurer une fois la vidéo prête
    lastSavedAt: 0,
  };

  async function openVideo(mediaId) {
    const item = findMedia(mediaId);
    if (!item) return;
    const video = elements.video;

    // Une seule lecture à la fois : la musique est mise en pause.
    if (!elements.audio.paused) elements.audio.pause();
    closePlayerSheet();

    $('#video-title').textContent = displayTitle(item);
    $('#video-error').hidden = true;
    $('#video-info').textContent = `${item.fileName} · ${formatSize(item.size)}`;
    updateVideoFavoriteButton(item);
    elements.videoScreen.classList.add('is-open');
    elements.videoScreen.setAttribute('aria-hidden', 'false');
    document.body.classList.add('no-scroll');
    updatePlayerUi();

    let blob = null;
    try {
      blob = await dbApi.getFile(mediaId);
    } catch (error) {
      logError(`Ouverture de ${item.fileName}`, error);
    }
    if (!elements.videoScreen.classList.contains('is-open')) return; // fermé entre-temps
    if (!blob) {
      showVideoError('Fichier introuvable', 'Ce fichier n\'est plus présent dans le stockage local. Supprimez-le puis importez-le à nouveau.');
      return;
    }

    const previousUrl = videoPlayer.currentUrl;
    videoPlayer.currentUrl = URL.createObjectURL(blob);
    videoPlayer.currentId = mediaId;
    videoPlayer.pendingResumePosition = item.lastPosition > RESUME_MIN_SECONDS ? item.lastPosition : null;
    video.src = videoPlayer.currentUrl;
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    updateMediaSessionMetadata(item);

    // Démarrage automatique si iOS l'autorise ; sinon l'utilisateur touche lecture.
    video.play().catch(() => {});
  }

  function showVideoError(title, message) {
    const box = $('#video-error');
    box.innerHTML = `<strong>${escapeHtml(title)}</strong>${escapeHtml(message)}`;
    box.hidden = false;
  }

  function updateVideoFavoriteButton(item) {
    const button = $('#video-favorite');
    const isFavorite = Boolean(item && item.favorite);
    button.innerHTML = icon(isFavorite ? 'heart-fill' : 'heart');
    button.setAttribute('aria-pressed', String(isFavorite));
    button.setAttribute('aria-label', isFavorite ? 'Retirer des favoris' : 'Ajouter aux favoris');
  }

  async function saveVideoPosition({ reset = false } = {}) {
    const item = findMedia(videoPlayer.currentId);
    if (!item) return;
    if (videoPlayer.pendingResumePosition !== null && !reset) return; // pas encore repositionnée
    const position = reset ? 0 : elements.video.currentTime;
    if (!Number.isFinite(position)) return;
    item.lastPosition = position;
    videoPlayer.lastSavedAt = Date.now();
    try {
      await dbApi.putMedia(item);
    } catch (error) {
      logError('Enregistrement de la position vidéo', error);
    }
  }

  function closeVideo() {
    const video = elements.video;
    if (videoPlayer.currentId && !video.ended) saveVideoPosition();
    video.pause();
    video.removeAttribute('src');
    video.load();
    if (videoPlayer.currentUrl) URL.revokeObjectURL(videoPlayer.currentUrl);
    videoPlayer.currentUrl = null;
    videoPlayer.currentId = null;
    videoPlayer.pendingResumePosition = null;
    elements.videoScreen.classList.remove('is-open');
    elements.videoScreen.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('no-scroll');
    const track = findMedia(audioPlayer.currentId);
    if (track) updateMediaSessionMetadata(track);
    else if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
    updatePlayerUi();
    refreshCurrentView(); // met à jour l'indicateur de reprise dans la liste
  }

  function enterVideoFullscreen() {
    const video = elements.video;
    try {
      if (typeof video.webkitEnterFullscreen === 'function') {
        video.webkitEnterFullscreen();       // iPhone
      } else if (typeof video.requestFullscreen === 'function') {
        video.requestFullscreen().catch((error) => {
          showToast('Plein écran refusé par le navigateur.', { isError: true });
          logError('Plein écran', error);
        });
      } else {
        showToast('Le plein écran n\'est pas pris en charge ici.', { isError: true });
      }
    } catch (error) {
      // Sur iPhone, le plein écran échoue tant que la vidéo n'est pas chargée.
      showToast('Lancez d\'abord la vidéo, puis réessayez le plein écran.');
      logError('Plein écran', error);
    }
  }

  /**
   * Replace la vidéo à la dernière position connue. Appelée une première fois
   * quand les métadonnées sont prêtes, puis au démarrage effectif de la lecture,
   * car certaines versions d'iOS ignorent un repositionnement trop précoce.
   */
  function applyPendingResume(isPlaybackStarting) {
    const video = elements.video;
    const target = videoPlayer.pendingResumePosition;
    if (target === null) return;
    if (!Number.isFinite(video.duration) || target >= video.duration - RESUME_MIN_SECONDS) {
      videoPlayer.pendingResumePosition = null;
      return;
    }
    if (Math.abs(video.currentTime - target) > 2) video.currentTime = target;
    if (isPlaybackStarting) {
      videoPlayer.pendingResumePosition = null;
      showToast(`Reprise à ${formatTime(target)}`, { duration: 2000 });
    }
  }

  function bindVideoEvents() {
    const video = elements.video;
    video.addEventListener('loadedmetadata', () => {
      const item = findMedia(videoPlayer.currentId);
      if (!item) return;
      if (!item.duration && Number.isFinite(video.duration)) {
        item.duration = video.duration;
        dbApi.putMedia(item).catch((error) => logError('Mise à jour de la durée', error));
      }
      if (!video.videoWidth) {
        $('#video-info').textContent = 'Aucune image détectée : la piste vidéo est peut-être dans un codec non pris en charge (seul le son sera lu).';
      }
      applyPendingResume(false);
    });
    video.addEventListener('playing', () => applyPendingResume(true));
    video.addEventListener('timeupdate', () => {
      updatePositionState(video);
      if (Date.now() - videoPlayer.lastSavedAt > POSITION_SAVE_INTERVAL_MS) saveVideoPosition();
    });
    video.addEventListener('pause', () => {
      if (!video.ended) saveVideoPosition();
    });
    video.addEventListener('ended', () => saveVideoPosition({ reset: true }));
    video.addEventListener('error', () => {
      if (!videoPlayer.currentId) return;
      const item = findMedia(videoPlayer.currentId);
      const message = mediaErrorMessage(video.error ? video.error.code : 0, 'video');
      logError(`Lecture vidéo : ${item ? item.fileName : ''}`, message);
      showVideoError('Lecture impossible', `${message} Astuce : le logiciel gratuit HandBrake (préréglage « Fast 1080p30 ») convertit une vidéo en MP4 compatible.`);
    });
  }

  /* ------------------------------------------------------------------------
     12. Favoris, playlists, suppression
     ------------------------------------------------------------------------ */

  async function toggleFavorite(mediaId) {
    const item = findMedia(mediaId);
    if (!item) return;
    item.favorite = !item.favorite;
    try {
      await dbApi.putMedia(item);
    } catch (error) {
      item.favorite = !item.favorite;
      logError('Mise à jour des favoris', error);
      showToast('Impossible d\'enregistrer le favori.', { isError: true });
      return;
    }
    refreshCurrentView();
    updatePlayerUi();
    if (videoPlayer.currentId === mediaId) updateVideoFavoriteButton(item);
  }

  // Redessine l'écran courant sans perdre la position de défilement ni la recherche.
  function refreshCurrentView() {
    const scrollY = window.scrollY;
    if (state.route.view === 'music' && $('#music-list')) updateMusicList();
    else if (state.route.view === 'videos' && $('#video-list')) updateVideoList();
    else render();
    window.scrollTo(0, scrollY);
  }

  async function savePlaylist(playlist) {
    playlist.updatedAt = Date.now();
    try {
      await dbApi.putPlaylist(playlist);
      return true;
    } catch (error) {
      logError('Enregistrement de la playlist', error);
      showToast('Impossible d\'enregistrer la playlist.', { isError: true });
      return false;
    }
  }

  async function createPlaylist({ initialTrackId = null, openAfter = true } = {}) {
    const name = await promptDialog('Nouvelle playlist', 'Nom de la playlist', `Playlist ${state.playlists.length + 1}`, 'Créer');
    if (!name) return null;
    const playlist = {
      id: createId(),
      name,
      trackIds: initialTrackId ? [initialTrackId] : [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    if (!(await savePlaylist(playlist))) return null;
    state.playlists.push(playlist);
    if (openAfter) navigate('playlist', playlist.id);
    else refreshCurrentView();
    showToast(`Playlist « ${name} » créée.`);
    return playlist;
  }

  async function addTrackToPlaylistMenu(trackId) {
    const items = state.playlists
      .slice()
      .sort((a, b) => collator.compare(a.name, b.name))
      .map((playlist) => ({ label: playlist.name, value: playlist.id }));
    items.push({ label: '+ Nouvelle playlist…', value: '__new__' });
    const choice = await actionSheet('Ajouter à une playlist', items);
    if (!choice) return;
    if (choice === '__new__') {
      await createPlaylist({ initialTrackId: trackId, openAfter: false });
      return;
    }
    const playlist = findPlaylist(choice);
    if (!playlist) return;
    if (playlist.trackIds.includes(trackId)) {
      showToast('Ce morceau est déjà dans la playlist.');
      return;
    }
    playlist.trackIds.push(trackId);
    if (await savePlaylist(playlist)) showToast(`Ajouté à « ${playlist.name} ».`);
  }

  async function addTracksToPlaylistDialog(playlistId) {
    const playlist = findPlaylist(playlistId);
    if (!playlist) return;
    const candidates = sortItems(audioTracks(), 'name').filter((track) => !playlist.trackIds.includes(track.id));
    if (!candidates.length) {
      await alertDialog('Ajouter des morceaux', audioTracks().length
        ? 'Tous vos morceaux sont déjà dans cette playlist.'
        : 'Importez d\'abord de la musique.');
      return;
    }
    const bodyHtml = `<ul class="check-list">${candidates.map((track) => `
      <li><label>
        <input type="checkbox" value="${track.id}">
        <span class="row-text">
          <span class="row-title">${escapeHtml(displayTitle(track))}</span>
          <span class="row-sub">${escapeHtml(track.artist || 'Artiste inconnu')}</span>
        </span>
      </label></li>`).join('')}</ul>`;
    const selectedIds = await openDialog({
      title: `Ajouter à « ${playlist.name} »`,
      bodyHtml,
      actions: [
        {
          label: 'Ajouter la sélection',
          style: 'btn-accent',
          collect: (root) => $$('input[type="checkbox"]:checked', root).map((input) => input.value),
        },
        { label: 'Annuler', value: null },
      ],
    });
    if (!selectedIds || !selectedIds.length) return;
    playlist.trackIds.push(...selectedIds);
    if (await savePlaylist(playlist)) {
      showToast(`${plural(selectedIds.length, 'morceau ajouté', 'morceaux ajoutés')}.`);
      refreshCurrentView();
    }
  }

  async function playlistMenu(playlistId) {
    const playlist = findPlaylist(playlistId);
    if (!playlist) return;
    const choice = await actionSheet(playlist.name, [
      { label: 'Renommer', value: 'rename' },
      { label: 'Supprimer la playlist', value: 'delete', danger: true },
    ]);
    if (choice === 'rename') {
      const name = await promptDialog('Renommer la playlist', 'Nouveau nom', playlist.name, 'Renommer');
      if (!name) return;
      const previousName = playlist.name;
      playlist.name = name;
      if (!(await savePlaylist(playlist))) playlist.name = previousName;
      render();
    } else if (choice === 'delete') {
      const confirmed = await confirmDialog('Supprimer la playlist ?',
        `« ${playlist.name} » sera supprimée. Les morceaux restent dans votre bibliothèque.`, 'Supprimer', { danger: true });
      if (!confirmed) return;
      try {
        await dbApi.deletePlaylist(playlistId);
      } catch (error) {
        logError('Suppression de la playlist', error);
        showToast('Impossible de supprimer la playlist.', { isError: true });
        return;
      }
      state.playlists = state.playlists.filter((item) => item.id !== playlistId);
      navigate('playlists');
      showToast('Playlist supprimée.');
    }
  }

  async function movePlaylistTrack(playlistId, position, direction) {
    const playlist = findPlaylist(playlistId);
    if (!playlist) return;
    // On travaille sur les morceaux encore existants pour que les positions correspondent à l'écran.
    const ids = playlist.trackIds.filter((id) => findMedia(id));
    const target = position + direction;
    if (target < 0 || target >= ids.length) return;
    [ids[position], ids[target]] = [ids[target], ids[position]];
    const previousIds = playlist.trackIds;
    playlist.trackIds = ids;
    if (!(await savePlaylist(playlist))) playlist.trackIds = previousIds;
    refreshCurrentView();
  }

  async function playlistTrackMenu(playlistId, position) {
    const playlist = findPlaylist(playlistId);
    if (!playlist) return;
    const ids = playlist.trackIds.filter((id) => findMedia(id));
    const track = findMedia(ids[position]);
    if (!track) return;
    const choice = await actionSheet(displayTitle(track), [
      { label: track.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris', value: 'favorite' },
      { label: 'Retirer de la playlist', value: 'remove', danger: true },
    ]);
    if (choice === 'favorite') {
      await toggleFavorite(track.id);
    } else if (choice === 'remove') {
      ids.splice(position, 1);
      const previousIds = playlist.trackIds;
      playlist.trackIds = ids;
      if (!(await savePlaylist(playlist))) playlist.trackIds = previousIds;
      refreshCurrentView();
    }
  }

  async function trackMenu(trackId) {
    const track = findMedia(trackId);
    if (!track) return;
    const choice = await actionSheet(displayTitle(track), [
      { label: 'Ajouter à une playlist', value: 'playlist' },
      { label: track.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris', value: 'favorite' },
      { label: 'Infos du fichier', value: 'info' },
      { label: 'Exporter une copie', value: 'export' },
      { label: 'Supprimer de la bibliothèque', value: 'delete', danger: true },
    ]);
    if (choice === 'playlist') await addTrackToPlaylistMenu(trackId);
    else if (choice === 'favorite') await toggleFavorite(trackId);
    else if (choice === 'info') await showMediaInfo(track);
    else if (choice === 'export') await exportMediaFile(track);
    else if (choice === 'delete') await deleteMedia(trackId);
  }

  async function videoMenu(videoId) {
    const item = findMedia(videoId);
    if (!item) return;
    const options = [
      { label: item.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris', value: 'favorite' },
      { label: 'Infos du fichier', value: 'info' },
      { label: 'Exporter une copie', value: 'export' },
    ];
    if (item.lastPosition > RESUME_MIN_SECONDS) options.push({ label: 'Reprendre du début la prochaine fois', value: 'reset' });
    options.push({ label: 'Supprimer de la bibliothèque', value: 'delete', danger: true });
    const choice = await actionSheet(displayTitle(item), options);
    if (choice === 'favorite') {
      await toggleFavorite(videoId);
    } else if (choice === 'info') {
      await showMediaInfo(item);
    } else if (choice === 'export') {
      await exportMediaFile(item);
    } else if (choice === 'reset') {
      item.lastPosition = 0;
      await dbApi.putMedia(item).catch((error) => logError('Remise à zéro de la position', error));
      refreshCurrentView();
    } else if (choice === 'delete') {
      await deleteMedia(videoId);
    }
  }

  function showMediaInfo(item) {
    const rows = [
      ['Fichier', item.fileName],
      ['Titre', displayTitle(item)],
      ['Artiste', item.artist || '—'],
      ['Album', item.album || '—'],
      ['Durée', item.duration ? formatTime(item.duration) : 'inconnue'],
      ['Taille', formatSize(item.size)],
      ['Type', item.mimeType],
      ['Ajouté le', new Date(item.addedAt).toLocaleString('fr-FR')],
    ];
    if (item.kind === 'video') rows.splice(2, 2, ['Dimensions', item.width ? `${item.width} × ${item.height}` : 'inconnues']);
    const bodyHtml = `<ul class="settings-list">${rows.map(([label, value]) => `
      <li><span>${escapeHtml(label)}</span><span class="value">${escapeHtml(value)}</span></li>`).join('')}</ul>`;
    return alertDialog('Infos du fichier', '', bodyHtml);
  }

  async function deleteMedia(mediaId) {
    const item = findMedia(mediaId);
    if (!item) return;
    const confirmed = await confirmDialog('Supprimer ce fichier ?',
      `« ${displayTitle(item)} » sera retiré de Pocket Player (et de vos playlists). Le fichier original dans l'app Fichiers n'est pas touché.`,
      'Supprimer', { danger: true });
    if (!confirmed) return;

    const updatedPlaylists = state.playlists
      .filter((playlist) => playlist.trackIds.includes(mediaId))
      .map((playlist) => ({ ...playlist, trackIds: playlist.trackIds.filter((id) => id !== mediaId), updatedAt: Date.now() }));

    try {
      await dbApi.deleteMedia(mediaId, updatedPlaylists);
    } catch (error) {
      logError(`Suppression de ${item.fileName}`, error);
      showToast('La suppression a échoué. Réessayez.', { isError: true });
      return;
    }

    // Arrête la lecture si l'on supprime le média en cours, puis libère ses URL.
    if (audioPlayer.currentId === mediaId) {
      stopAudio();
    } else {
      removeFromQueue(mediaId);
    }
    if (videoPlayer.currentId === mediaId) closeVideo();
    releaseCoverUrl(mediaId);

    state.media = state.media.filter((media) => media.id !== mediaId);
    updatedPlaylists.forEach((updated) => {
      const index = state.playlists.findIndex((playlist) => playlist.id === updated.id);
      if (index >= 0) state.playlists[index] = updated;
    });
    refreshCurrentView();
    updatePlayerUi();
    showToast('Fichier supprimé.');
  }

  function removeFromQueue(mediaId) {
    const currentId = audioPlayer.currentId;
    audioPlayer.queue = audioPlayer.queue.filter((id) => id !== mediaId);
    audioPlayer.originalQueue = audioPlayer.originalQueue.filter((id) => id !== mediaId);
    if (currentId) audioPlayer.index = audioPlayer.queue.indexOf(currentId);
  }

  async function clearLibrary() {
    if (!state.media.length && !state.playlists.length) {
      showToast('La bibliothèque est déjà vide.');
      return;
    }
    const confirmed = await confirmDialog('Tout supprimer ?',
      `Les ${plural(state.media.length, 'fichier', 'fichiers')} et ${plural(state.playlists.length, 'playlist', 'playlists')} seront effacés de Pocket Player. Cette action est définitive.\nVos fichiers originaux dans l'app Fichiers ne sont pas touchés.`,
      'Tout supprimer', { danger: true });
    if (!confirmed) return;
    try {
      await dbApi.clearLibrary();
    } catch (error) {
      logError('Suppression de la bibliothèque', error);
      showToast('La suppression a échoué.', { isError: true });
      return;
    }
    stopAudio();
    if (videoPlayer.currentId) closeVideo();
    Array.from(coverUrls.keys()).forEach(releaseCoverUrl);
    state.media = [];
    state.playlists = [];
    navigate('library');
    showToast('Bibliothèque vidée.');
  }

  /* ------------------------------------------------------------------------
     13. Sauvegarde et exportation
     ------------------------------------------------------------------------
     Sur iPhone, les API de partage exigent un toucher direct : on prépare
     d'abord le fichier, puis on propose un bouton qui ouvre le partage.
     ------------------------------------------------------------------------ */

  function downloadFile(file) {
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Laisse le temps au navigateur de lire le fichier avant de libérer l'URL.
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function offerFile(file, title) {
    const canShareFile = typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
    const actions = [];
    if (canShareFile) {
      actions.push({
        label: 'Partager / Enregistrer dans Fichiers',
        style: 'btn-accent',
        value: 'share',
        run: () => {
          navigator.share({ files: [file], title: file.name }).catch((error) => {
            if (error.name !== 'AbortError') {
              logError('Partage du fichier', error);
              showToast('Le partage a échoué.', { isError: true });
            }
          });
        },
      });
    }
    actions.push({ label: 'Télécharger', value: 'download', style: canShareFile ? '' : 'btn-accent', run: () => downloadFile(file) });
    actions.push({ label: 'Annuler', value: null, style: 'btn-ghost' });
    return openDialog({ title, message: `${file.name} (${formatSize(file.size)})`, actions });
  }

  async function exportMediaFile(item) {
    let blob = null;
    try {
      blob = await dbApi.getFile(item.id);
    } catch (error) {
      logError(`Export de ${item.fileName}`, error);
    }
    if (!blob) {
      showToast('Fichier introuvable dans le stockage local.', { isError: true });
      return;
    }
    const file = new File([blob], item.fileName, { type: item.mimeType || blob.type });
    await offerFile(file, 'Exporter une copie');
  }

  async function exportBackup() {
    const backup = {
      app: 'pocket-player',
      format: 1,
      exportedAt: new Date().toISOString(),
      media: state.media.map((item) => ({
        fileName: item.fileName,
        size: item.size,
        kind: item.kind,
        favorite: item.favorite,
        lastPosition: item.lastPosition,
      })),
      playlists: state.playlists.map((playlist) => ({
        name: playlist.name,
        tracks: playlist.trackIds.map(findMedia).filter(Boolean).map((track) => ({ fileName: track.fileName, size: track.size })),
      })),
    };
    const date = new Date().toISOString().slice(0, 10);
    const file = new File([JSON.stringify(backup, null, 2)], `pocket-player-sauvegarde-${date}.json`, { type: 'application/json' });
    await offerFile(file, 'Exporter la sauvegarde');
  }

  async function importBackup(file) {
    if (!file) return;
    let backup;
    try {
      backup = JSON.parse(await file.text());
    } catch (error) {
      await alertDialog('Sauvegarde illisible', 'Ce fichier n\'est pas une sauvegarde Pocket Player valide.');
      return;
    }
    if (!backup || backup.app !== 'pocket-player' || !Array.isArray(backup.media)) {
      await alertDialog('Sauvegarde illisible', 'Ce fichier n\'est pas une sauvegarde Pocket Player valide.');
      return;
    }
    // Les médias sont retrouvés par nom de fichier + taille.
    const findByFile = (entry) => state.media.find((item) => item.fileName === entry.fileName && item.size === entry.size);
    let restoredMedia = 0;
    let missingMedia = 0;
    let restoredPlaylists = 0;
    try {
      for (const entry of backup.media) {
        const item = findByFile(entry);
        if (!item) {
          missingMedia += 1;
          continue;
        }
        item.favorite = Boolean(entry.favorite);
        item.lastPosition = Number(entry.lastPosition) || 0;
        await dbApi.putMedia(item);
        restoredMedia += 1;
      }
      for (const entry of backup.playlists || []) {
        const trackIds = (entry.tracks || []).map(findByFile).filter(Boolean).map((track) => track.id);
        let playlist = state.playlists.find((existing) => existing.name === entry.name);
        if (playlist) {
          trackIds.forEach((id) => { if (!playlist.trackIds.includes(id)) playlist.trackIds.push(id); });
        } else {
          playlist = { id: createId(), name: String(entry.name || 'Playlist'), trackIds, createdAt: Date.now(), updatedAt: Date.now() };
          state.playlists.push(playlist);
        }
        await dbApi.putPlaylist(playlist);
        restoredPlaylists += 1;
      }
    } catch (error) {
      logError('Restauration de la sauvegarde', error);
      showToast('La restauration a été interrompue par une erreur.', { isError: true });
    }
    render();
    await alertDialog('Sauvegarde restaurée',
      `${plural(restoredMedia, 'fichier mis à jour', 'fichiers mis à jour')}, ${plural(restoredPlaylists, 'playlist restaurée', 'playlists restaurées')}.`
      + (missingMedia ? `\n${plural(missingMedia, 'fichier absent', 'fichiers absents')} de la bibliothèque : importez-les puis restaurez à nouveau la sauvegarde.` : ''));
  }

  /* ------------------------------------------------------------------------
     14. Service worker et mises à jour
     ------------------------------------------------------------------------ */

  let serviceWorkerRegistration = null;
  let waitingWorker = null;

  function showUpdateBanner(worker) {
    waitingWorker = worker;
    elements.updateBanner.hidden = false;
  }

  function applyUpdate() {
    if (!waitingWorker) {
      location.reload();
      return;
    }
    waitingWorker.postMessage({ type: 'SKIP_WAITING' });
  }

  function getServiceWorkerVersion() {
    return new Promise((resolve) => {
      const controller = navigator.serviceWorker && navigator.serviceWorker.controller;
      if (!controller) {
        resolve(null);
        return;
      }
      const channel = new MessageChannel();
      const timer = setTimeout(() => resolve(null), 2000);
      channel.port1.onmessage = (event) => {
        clearTimeout(timer);
        resolve(event.data && event.data.version);
      };
      controller.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
    });
  }

  async function checkForUpdate() {
    if (!serviceWorkerRegistration) {
      showToast('Le mode hors ligne n\'est pas actif sur ce navigateur.');
      return;
    }
    try {
      await serviceWorkerRegistration.update();
      if (serviceWorkerRegistration.waiting || serviceWorkerRegistration.installing) {
        showToast('Mise à jour trouvée : elle se prépare…');
      } else {
        showToast('Pocket Player est à jour.');
      }
    } catch (error) {
      showToast('Vérification impossible (pas de connexion ?).');
    }
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    const hadController = Boolean(navigator.serviceWorker.controller);
    let isReloading = false;
    // Quand la nouvelle version prend la main, on recharge une seule fois.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || isReloading) return;
      isReloading = true;
      location.reload();
    });

    navigator.serviceWorker.register('./service-worker.js', { scope: './' })
      .then((registration) => {
        serviceWorkerRegistration = registration;
        if (registration.waiting && navigator.serviceWorker.controller) showUpdateBanner(registration.waiting);
        registration.addEventListener('updatefound', () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) showUpdateBanner(installing);
          });
        });
        // Vérifie les mises à jour quand on revient dans l'application.
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible' && navigator.onLine) registration.update().catch(() => {});
        });
      })
      .catch((error) => logError('Activation du mode hors ligne', error));
  }

  /* ------------------------------------------------------------------------
     15. Gestion des clics et démarrage
     ------------------------------------------------------------------------ */

  // Libellé affiché en haut du lecteur (« Musique », « Favoris » ou nom de la playlist).
  function currentContextLabel() {
    if (state.route.view === 'favorites') return 'Favoris';
    if (state.route.view === 'playlist') return (findPlaylist(state.route.param) || {}).name || 'Playlist';
    return 'Musique';
  }

  const clickActions = {
    'navigate': (target) => navigate(target.dataset.view, target.dataset.param || null),
    'import': (target) => openFilePicker(target.dataset.kind),
    'play-from-list': (target) => playQueue(state.visibleTrackIds, Number(target.dataset.index), currentContextLabel()),
    'play-single': (target) => {
      const tracks = sortItems(audioTracks(), state.preferences.musicSort).map((track) => track.id);
      playQueue(tracks, tracks.indexOf(target.dataset.id), 'Musique');
    },
    'play-visible': (target) => playQueue(state.visibleTrackIds, 0, currentContextLabel(), {
      forceShuffle: target.dataset.shuffle === 'true',
    }),
    'toggle-favorite': (target) => toggleFavorite(target.dataset.id),
    'toggle-favorite-current': () => { if (audioPlayer.currentId) toggleFavorite(audioPlayer.currentId); },
    'toggle-favorite-video': () => { if (videoPlayer.currentId) toggleFavorite(videoPlayer.currentId); },
    'track-menu': (target) => trackMenu(target.dataset.id),
    'current-track-menu': () => { if (audioPlayer.currentId) trackMenu(audioPlayer.currentId); },
    'video-menu': (target) => videoMenu(target.dataset.id),
    'open-video': (target) => openVideo(target.dataset.id),
    'close-video': () => closeVideo(),
    'video-fullscreen': () => enterVideoFullscreen(),
    'toggle-play': () => togglePlay(),
    'next-track': () => playNext(),
    'previous-track': () => playPrevious(),
    'toggle-shuffle': () => toggleShuffle(),
    'cycle-repeat': () => cycleRepeat(),
    'open-player': () => openPlayerSheet(),
    'close-player': () => closePlayerSheet(),
    'favorites-tab': (target) => {
      state.preferences.favoritesTab = target.dataset.tabValue;
      savePreferences();
      render();
    },
    'create-playlist': () => createPlaylist(),
    'playlist-menu': (target) => playlistMenu(target.dataset.playlist),
    'playlist-add-tracks': (target) => addTracksToPlaylistDialog(target.dataset.playlist),
    'playlist-move': (target) => movePlaylistTrack(target.dataset.playlist, Number(target.dataset.position), Number(target.dataset.direction)),
    'playlist-track-menu': (target) => playlistTrackMenu(target.dataset.playlist, Number(target.dataset.position)),
    'dismiss-install-hint': () => {
      state.preferences.installHintDismissed = true;
      savePreferences();
      render();
    },
    'request-persist': async () => {
      const granted = await requestPersistentStorage();
      if (granted === null) showToast('Ce navigateur ne gère pas cette demande.');
      else showToast(granted ? 'Stockage persistant accordé.' : 'iOS n\'a pas accordé le stockage persistant pour le moment.');
      fillSettingsAsync();
    },
    'export-backup': () => exportBackup(),
    'import-backup': () => {
      elements.backupInput.value = '';
      elements.backupInput.click();
    },
    'check-update': () => checkForUpdate(),
    'apply-update': () => applyUpdate(),
    'clear-errors': () => {
      state.errors = [];
      render();
    },
    'clear-library': () => clearLibrary(),
  };

  function bindGlobalEvents() {
    document.addEventListener('click', (event) => {
      const target = event.target.closest('[data-action]');
      if (!target || target.disabled) return;
      const handler = clickActions[target.dataset.action];
      if (!handler) return;
      event.preventDefault();
      try {
        const result = handler(target);
        if (result && typeof result.catch === 'function') {
          result.catch((error) => {
            logError(`Action « ${target.dataset.action} »`, error);
            showToast('Une erreur est survenue. Détails dans Réglages > Journal des erreurs.', { isError: true });
          });
        }
      } catch (error) {
        logError(`Action « ${target.dataset.action} »`, error);
        showToast('Une erreur est survenue. Détails dans Réglages > Journal des erreurs.', { isError: true });
      }
    });

    // Recherche et tri : on ne redessine que la liste.
    document.addEventListener('input', (event) => {
      if (event.target.id === 'music-search') {
        state.search.music = event.target.value;
        updateMusicList();
      } else if (event.target.id === 'video-search') {
        state.search.videos = event.target.value;
        updateVideoList();
      }
    });
    document.addEventListener('change', (event) => {
      if (event.target.id === 'music-sort') {
        state.preferences.musicSort = event.target.value;
        savePreferences();
        updateMusicList();
      } else if (event.target.id === 'video-sort') {
        state.preferences.videoSort = event.target.value;
        savePreferences();
        updateVideoList();
      }
    });

    elements.audioInput.addEventListener('change', () => importFiles(elements.audioInput.files));
    elements.videoInput.addEventListener('change', () => importFiles(elements.videoInput.files));
    elements.backupInput.addEventListener('change', () => importBackup(elements.backupInput.files[0]));

    window.addEventListener('hashchange', () => {
      closePlayerSheet();
      render();
      window.scrollTo(0, 0);
    });

    // Enregistre la position de la vidéo si l'application passe en arrière-plan.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && videoPlayer.currentId) saveVideoPosition();
    });

    window.addEventListener('offline', () => showToast('Hors ligne : vos médias importés restent disponibles.'));
  }

  async function loadLibrary() {
    try {
      await openDatabase();
      state.databaseReady = true;
    } catch (error) {
      logError('Ouverture de la base locale', error);
      return;
    }
    try {
      const [media, playlists, preferences] = await Promise.all([
        dbApi.getAllMedia(),
        dbApi.getAllPlaylists(),
        dbApi.getSetting('preferences'),
      ]);
      state.media = media || [];
      state.playlists = playlists || [];
      if (preferences && preferences.value) Object.assign(state.preferences, preferences.value);
    } catch (error) {
      logError('Chargement de la bibliothèque', error);
      showToast('La bibliothèque n\'a pas pu être chargée.', { isError: true });
    }
  }

  async function start() {
    bindGlobalEvents();
    bindAudioEvents();
    bindVideoEvents();
    setupMediaSession();
    await loadLibrary();
    render();
    updatePlayerUi();
    registerServiceWorker();
  }

  start();
})();
