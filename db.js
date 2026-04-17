// ══════════════════════════════════════════════════════
// Letrange Content Board — Database Layer
// Cloud first (Supabase), offline fallback (IndexedDB)
// ══════════════════════════════════════════════════════

const SUPABASE_URL = 'https://klisxxnjjhxuhnefqcst.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtsaXN4eG5qamh4dWhuZWZxY3N0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyNTE0NzEsImV4cCI6MjA5MTgyNzQ3MX0.GXqistGaLaIhIoRJQGhHEXJ0yln6nHTLhBvKvW3QBJc';
const STRICT_CLOUD_MODE = false;
const PROTECT_FROM_DELETION = false;
const CLOUD_ONLY = true;

const DB_NAME = 'Letrange Board';
const DB_VERSION = 2;

let _db = null;
let _supabase = null;
let _supabaseInitTried = false;
let _cloudDisabled = false;
let _activeUserId = null;
let _syncPromise = null;
let _lastDbError = '';
let _lastSyncTriggerAt = 0;
const ENABLE_BACKGROUND_MIGRATION = false;

function logDb(...args) {
    console.warn('[db]', ...args);
}

function setDbError(message) {
    _lastDbError = message || '';
    if (_lastDbError) logDb(_lastDbError);
}

function clearDbError() {
    _lastDbError = '';
}

function dbGetLastError() {
    return _lastDbError || '';
}

function isDataUrl(url) {
    return typeof url === 'string' && url.startsWith('data:');
}

function isDataUrlImage(url) {
    return typeof url === 'string' && url.startsWith('data:image/');
}

async function dbOptimizeImageDataUrl(url) {
    if (!isDataUrlImage(url)) return url;
    // Keep UI fast: only optimize very large images.
    if (url.length < 3500000) return url;

    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            try {
                let width = img.naturalWidth;
                let height = img.naturalHeight;
                const maxDim = 1920;
                if (width > maxDim || height > maxDim) {
                    if (width > height) {
                        height = Math.round((height * maxDim) / width);
                        width = maxDim;
                    } else {
                        width = Math.round((width * maxDim) / height);
                        height = maxDim;
                    }
                }

                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                if (!ctx) return resolve(url);
                ctx.drawImage(img, 0, 0, width, height);
                const optimized = canvas.toDataURL('image/jpeg', 0.92);
                if (optimized.length < url.length * 0.92) return resolve(optimized);
                return resolve(url);
            } catch (e) {
                return resolve(url);
            }
        };
        img.onerror = () => resolve(url);
        img.src = url;
    });
}

function getSupabase() {
    if (_cloudDisabled) return null;
    try {
        if (!_supabase && typeof supabase !== 'undefined') {
            _supabase = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        }
    } catch (e) {
        _cloudDisabled = true;
        logDb('Supabase init error, fallback local:', e?.message || e);
    }
    return _supabase;
}

async function ensureSupabaseSession() {
    const sb = getSupabase();
    if (!sb) return null;
    try {
        clearDbError();
        const { data: sessionData } = await sb.auth.getSession();
        _activeUserId = sessionData?.session?.user?.id || null;
        return _activeUserId;
    } catch (e) {
        setDbError(`Erreur session: ${e?.message || e}`);
    }
    return null;
}

async function dbLogin(email, password) {
    const sb = getSupabase();
    if (!sb) return null;
    try {
        clearDbError();
        // 1. Essayer de se connecter
        const { data, error } = await sb.auth.signInWithPassword({ email, password });
        
        if (!error && data?.user?.id) {
            _activeUserId = data.user.id;
            return _activeUserId;
        }

        // 2. Si échec, essayer de créer le compte automatiquement (cas du premier lancement)
        // Note: Cela fonctionne si "Confirm Email" est désactivé dans Supabase.
        const { data: signUpData, error: signUpError } = await sb.auth.signUp({ 
            email, 
            password,
            options: {
                data: { display_name: 'Studio LÉTRANGE' }
            }
        });

        if (!signUpError && signUpData?.user?.id) {
            _activeUserId = signUpData.user.id;
            return _activeUserId;
        }

        // 3. Si les deux échouent, rapporter l'erreur de connexion initiale
        setDbError(`Erreur de connexion : ${error?.message || 'Identifiants incorrects'}`);
        return null;
    } catch (e) {
        setDbError(`Exception connexion : ${e?.message || e}`);
        return null;
    }
}

async function dbLogout() {
    const sb = getSupabase();
    if (sb) {
        await sb.auth.signOut();
        _activeUserId = null;
        window.location.reload();
    }
}

function toCloudWeekPayload(weekData, userId) {
    return {
        number: weekData.number || 0,
        cards: Array.isArray(weekData.cards) ? weekData.cards : []
    };
}

function fromCloudWeek(row) {
    return {
        id: row.id,
        number: row.number || 0,
        cards: Array.isArray(row.cards) ? row.cards : [],
        createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
        user_id: row.user_id || null
    };
}

function toCloudImagePayload(imageData, userId) {
    const payload = {
        url: imageData.url,
        cat: imageData.cat || 'produit'
    };
    if (imageData.name) payload.name = imageData.name;
    return payload;
}

function fromCloudImage(row) {
    return {
        id: row.id,
        url: row.url || '',
        cat: row.cat || 'produit',
        name: row.name || '',
        createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
        user_id: row.user_id || null
    };
}

function openDB() {
    if (CLOUD_ONLY) return Promise.resolve(null);
    return new Promise((resolve) => {
        if (_db) return resolve(_db);
        let req;
        try {
            req = indexedDB.open(DB_NAME, DB_VERSION);
        } catch (e) {
            setDbError(`IndexedDB indisponible: ${e?.message || e}`);
            return resolve(null);
        }
        req.onsuccess = () => {
            _db = req.result;
            resolve(_db);
        };
        req.onerror = () => {
            setDbError(`Erreur IndexedDB: ${req.error?.message || req.error || 'inconnue'}`);
            resolve(null);
        };
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('weeks')) db.createObjectStore('weeks', { keyPath: 'id', autoIncrement: true });
            if (!db.objectStoreNames.contains('images')) db.createObjectStore('images', { keyPath: 'id', autoIncrement: true });
        };
    });
}

async function saveWeekLocal(weekData) {
    if (CLOUD_ONLY) return null;
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction('weeks', 'readwrite');
        const store = tx.objectStore('weeks');
        const req = weekData.id ? store.put(weekData) : store.add(weekData);
        req.onsuccess = () => {
            if (!weekData.id) weekData.id = req.result;
            resolve(weekData.id);
        };
        req.onerror = () => resolve(null);
    });
}

async function saveImageLocal(imageData) {
    if (CLOUD_ONLY) return null;
    const db = await openDB();
    if (!db) return null;
    return new Promise((resolve) => {
        const tx = db.transaction('images', 'readwrite');
        const store = tx.objectStore('images');
        const req = imageData.id ? store.put(imageData) : store.add(imageData);
        req.onsuccess = () => {
            if (!imageData.id) imageData.id = req.result;
            resolve(imageData.id);
        };
        req.onerror = () => resolve(null);
    });
}

async function getAllLocalWeeksRaw() {
    if (CLOUD_ONLY) return [];
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction('weeks', 'readonly');
        const req = tx.objectStore('weeks').getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
    });
}

async function getAllLocalImagesRaw() {
    if (CLOUD_ONLY) return [];
    const db = await openDB();
    if (!db) return [];
    return new Promise((resolve) => {
        const tx = db.transaction('images', 'readonly');
        const req = tx.objectStore('images').getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
    });
}

function weekFingerprint(week) {
    const cards = Array.isArray(week.cards) ? week.cards : [];
    return `${week.number || 0}::${JSON.stringify(cards)}`;
}

function dedupeWeeks(weeks) {
    const byFingerprint = new Map();
    for (const week of weeks || []) {
        const fp = weekFingerprint(week);
        const existing = byFingerprint.get(fp);
        if (!existing) {
            byFingerprint.set(fp, week);
            continue;
        }
        // Keep the newest-ish row (highest numeric id when available).
        const currentId = Number(week?.id || 0);
        const existingId = Number(existing?.id || 0);
        if (currentId >= existingId) byFingerprint.set(fp, week);
    }
    return Array.from(byFingerprint.values()).sort((a, b) => (a.number || 0) - (b.number || 0));
}

function dedupeImages(images) {
    const byUrl = new Map();
    for (const image of images || []) {
        const url = String(image?.url || '').trim();
        if (!url) continue;
        const existing = byUrl.get(url);
        if (!existing) {
            byUrl.set(url, image);
            continue;
        }
        const currentId = Number(image?.id || 0);
        const existingId = Number(existing?.id || 0);
        if (currentId >= existingId) byUrl.set(url, image);
    }
    return Array.from(byUrl.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

async function refreshLocalCacheFromCloud() {
    const cloudWeeks = await dbGetAllWeeksCloudOnly();
    const cloudImages = await dbGetAllImagesCloudOnly();

    const db = await openDB();
    await new Promise((resolve) => {
        const tx = db.transaction('weeks', 'readwrite');
        const store = tx.objectStore('weeks');
        for (const week of cloudWeeks) store.put(week);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
    });
    await new Promise((resolve) => {
        const tx = db.transaction('images', 'readwrite');
        const store = tx.objectStore('images');
        for (const image of cloudImages) store.put(image);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
    });
}

async function syncLocalToCloud() {
    if (!ENABLE_BACKGROUND_MIGRATION) return true;
    if (_syncPromise) return _syncPromise;
    _syncPromise = (async () => {
        const sb = getSupabase();
        if (!sb) return false;

        try {
            const localWeeks = await getAllLocalWeeksRaw();
            const localImages = await getAllLocalImagesRaw();
            const cloudWeeks = await dbGetAllWeeksCloudOnly();
            const cloudImages = await dbGetAllImagesCloudOnly();
            let hadCloudWriteErrors = false;

            const cloudWeekFingerprints = new Set(cloudWeeks.map(weekFingerprint));
            for (const localWeek of localWeeks) {
                const fp = weekFingerprint(localWeek);
                if (cloudWeekFingerprints.has(fp)) continue;
                const payload = toCloudWeekPayload(localWeek, null);
                const { data, error } = await sb.from('weeks').insert([payload]).select('*').single();
                if (!error && data) cloudWeekFingerprints.add(weekFingerprint(fromCloudWeek(data)));
                if (error) hadCloudWriteErrors = true;
            }

            const cloudImageUrls = new Set(cloudImages.map((img) => img.url));
            for (const localImage of localImages) {
                const url = localImage?.url;
                if (!url || cloudImageUrls.has(url)) continue;
                const payload = toCloudImagePayload(localImage, null);
                const { error } = await sb.from('images').insert([payload]).select('id').single();
                if (!error) cloudImageUrls.add(url);
                if (error) hadCloudWriteErrors = true;
            }

            // Never overwrite local cache after cloud write errors.
            if (!hadCloudWriteErrors) {
                await refreshLocalCacheFromCloud();
            }
            return true;
        } catch (e) {
            logDb('syncLocalToCloud failed:', e?.message || e);
            return false;
        } finally {
            _syncPromise = null;
        }
    })();
    return _syncPromise;
}

function triggerBackgroundSync(minIntervalMs = 15000) {
    if (!ENABLE_BACKGROUND_MIGRATION) return;
    const now = Date.now();
    if (now - _lastSyncTriggerAt < minIntervalMs) return;
    _lastSyncTriggerAt = now;
    syncLocalToCloud().catch(() => {});
}

// ── WEEKS ─────────────────────────────────────────────

async function dbGetAllWeeks(limit = null, offset = null) {
    const sb = getSupabase();
    if (sb) {
        try {
            let query = sb
                .from('weeks')
                .select('*')
                .order('number', { ascending: false }); // Show newest first for better UX
            
            if (limit !== null) query = query.limit(limit);
            if (offset !== null) query = query.range(offset, offset + (limit || 1) - 1);

            const { data, error } = await query;
            
            if (!error && Array.isArray(data)) {
                const cloudWeeks = dedupeWeeks(data.map(fromCloudWeek));
                clearDbError();
                return cloudWeeks;
            }
            if (error) setDbError(`Lecture weeks echouee: ${error.message || error}`);
        } catch (e) {
            setDbError(`Lecture weeks exception: ${e?.message || e}`);
        }
    }

    setDbError('Lecture weeks impossible: Supabase indisponible');
    return [];
}

async function dbGetTotalWeeksCount() {
    const sb = getSupabase();
    if (!sb) return 0;
    try {
        const { count, error } = await sb
            .from('weeks')
            .select('*', { count: 'exact', head: true });
        if (error) return 0;
        return count || 0;
    } catch (e) {
        return 0;
    }
}

async function dbAddWeek(weekData) {
    const week = {
        number: weekData.number || 0,
        cards: Array.isArray(weekData.cards) ? weekData.cards : [],
        createdAt: weekData.createdAt || Date.now()
    };

    const sb = getSupabase();
    if (sb) {
        try {
            // Optimization: Detect and upload embedded base64 images in cards
            for (const card of week.cards) {
                if (isDataUrl(card.image)) {
                    card.image = await dbUploadImage(card.image);
                }
                if (isDataUrl(card.resultVideo)) {
                    card.resultVideo = await dbUploadFile(card.resultVideo);
                }
                if (Array.isArray(card.gallery)) {
                    for (let i = 0; i < card.gallery.length; i++) {
                        const item = card.gallery[i];
                        const url = item && typeof item === 'object' ? item.url : item;
                        if (isDataUrl(url)) {
                            const newUrl = await dbUploadImage(url);
                            if (item && typeof item === 'object') item.url = newUrl;
                            else card.gallery[i] = newUrl;
                        }
                    }
                }
            }

            const payload = toCloudWeekPayload(week, null);
            const { data, error } = await sb.from('weeks').insert([payload]).select('*').single();
            if (!error && data) {
                clearDbError();
                const saved = fromCloudWeek(data);
                weekData.id = saved.id;
                return saved.id;
            }
            if (error) setDbError(`Insert week echoue: ${error.message || error}`);
        } catch (e) {
            setDbError(`Insert week exception: ${e?.message || e}`);
        }
    }

    setDbError('Insert week impossible: Supabase indisponible');
    return null;
}

async function dbUpdateWeek(weekData) {
    if (!weekData?.id) return false;

    const sb = getSupabase();
    let cloudWriteOk = false;
    if (sb) {
        try {
            // Optimization: Detect and upload embedded base64 images in cards
            for (const card of weekData.cards) {
                if (isDataUrl(card.image)) {
                    card.image = await dbUploadImage(card.image);
                }
                if (isDataUrl(card.resultVideo)) {
                    card.resultVideo = await dbUploadFile(card.resultVideo);
                }
                if (Array.isArray(card.gallery)) {
                    for (let i = 0; i < card.gallery.length; i++) {
                        const item = card.gallery[i];
                        const url = item && typeof item === 'object' ? item.url : item;
                        if (isDataUrl(url)) {
                            const newUrl = await dbUploadImage(url);
                            if (item && typeof item === 'object') item.url = newUrl;
                            else card.gallery[i] = newUrl;
                        }
                    }
                }
            }

            const payload = toCloudWeekPayload(weekData, null);
            const { data: updatedRows, error } = await sb
                .from('weeks')
                .update(payload)
                .eq('id', weekData.id)
                .select('id');

            if (error) {
                setDbError(`Update week echoue: ${error.message || error}`);
            } else if (!updatedRows || updatedRows.length === 0) {
                // If row does not exist in cloud (old local id), create it.
                const { data: inserted, error: insertError } = await sb
                    .from('weeks')
                    .insert([payload])
                    .select('*')
                    .single();
                if (!insertError && inserted) {
                    weekData.id = inserted.id;
                    cloudWriteOk = true;
                    clearDbError();
                } else if (insertError) {
                    setDbError(`Insert fallback week echoue: ${insertError.message || insertError}`);
                }
            } else {
                cloudWriteOk = true;
                clearDbError();
            }
        } catch (e) {
            setDbError(`Update week exception: ${e?.message || e}`);
        }
    }

    if (!sb) setDbError('Update week impossible: Supabase indisponible');
    return cloudWriteOk;
}

async function dbDeleteWeek(id) {
    if (!id) return;
    if (PROTECT_FROM_DELETION) {
        setDbError('Suppression bloquee: mode anti-perte actif');
        return false;
    }

    const sb = getSupabase();
    if (sb) {
        try {
            const { error } = await sb.from('weeks').delete().eq('id', id);
            if (error) logDb('dbDeleteWeek cloud error:', error.message || error);
        } catch (e) {
            logDb('dbDeleteWeek cloud exception:', e?.message || e);
        }
    }

    if (!STRICT_CLOUD_MODE) {
        const db = await openDB();
        const tx = db.transaction('weeks', 'readwrite');
        tx.objectStore('weeks').delete(id);
    }
    return true;
}

async function dbClearAllWeeks() {
    if (PROTECT_FROM_DELETION) {
        setDbError('Reset bloque: mode anti-perte actif');
        return false;
    }
    const sb = getSupabase();
    if (sb) {
        try {
            const { error } = await sb.from('weeks').delete().gt('id', 0);
            if (error) logDb('dbClearAllWeeks cloud error:', error.message || error);
        } catch (e) {
            logDb('dbClearAllWeeks cloud exception:', e?.message || e);
        }
    }

    if (!STRICT_CLOUD_MODE) {
        const db = await openDB();
        await new Promise((resolve) => {
            const tx = db.transaction('weeks', 'readwrite');
            const req = tx.objectStore('weeks').clear();
            req.onsuccess = () => resolve(true);
            req.onerror = () => resolve(false);
        });
    }
    return true;
}

async function dbClearAllImages() {
    if (PROTECT_FROM_DELETION) {
        setDbError('Suppression images bloquee: mode anti-perte actif');
        return false;
    }
    const sb = getSupabase();
    if (sb) {
        try {
            const { error } = await sb.from('images').delete().gt('id', 0);
            if (error) logDb('dbClearAllImages cloud error:', error.message || error);
        } catch (e) {
            logDb('dbClearAllImages cloud exception:', e?.message || e);
        }
    }

    const db = await openDB();
    await new Promise((resolve) => {
        const tx = db.transaction('images', 'readwrite');
        const req = tx.objectStore('images').clear();
        req.onsuccess = () => resolve(true);
        req.onerror = () => resolve(false);
    });
    return true;
}

async function dbWipeAllData() {
    if (PROTECT_FROM_DELETION) {
        setDbError('Nettoyage total bloque: mode anti-perte actif');
        return false;
    }
    await dbClearAllWeeks();
    await dbClearAllImages();
    return true;
}

async function dbGetWeekById(id) {
    const sb = getSupabase();
    if (!sb) {
        setDbError('Lecture week impossible: Supabase indisponible');
        return null;
    }
    try {
        const { data, error } = await sb.from('weeks').select('*').eq('id', id).single();
        if (error) {
            setDbError(`Lecture week echouee: ${error.message || error}`);
            return null;
        }
        clearDbError();
        return fromCloudWeek(data);
    } catch (e) {
        setDbError(`Lecture week exception: ${e?.message || e}`);
        return null;
    }
}

// ── STORAGE ───────────────────────────────────────────

function dbDataUrlToBlob(dataUrl) {
    const arr = dataUrl.split(',');
    const mime = arr[0].match(/:(.*?);/)[1];
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
        u8arr[n] = bstr.charCodeAt(n);
    }
    return new Blob([u8arr], { type: mime });
}

async function dbUploadImage(dataUrl) {
    if (!isDataUrlImage(dataUrl)) return dataUrl;
    const sb = getSupabase();
    if (!sb) return dataUrl;

    try {
        const blob = dbDataUrlToBlob(dataUrl);
        const ext = blob.type.split('/')[1] || 'jpg';
        const fileName = `${Date.now()}-${Math.random().toString(36).substring(2)}.${ext}`;
        const filePath = `${_activeUserId || 'guest'}/${fileName}`;

        const { data, error } = await sb.storage
            .from('gallery')
            .upload(filePath, blob, { contentType: blob.type });

        if (error) {
            logDb('Upload storage error:', error.message);
            return dataUrl; 
        }

        const { data: publicData } = sb.storage.from('gallery').getPublicUrl(filePath);
        return publicData.publicUrl;
    } catch (e) {
        logDb('Upload storage exception:', e?.message || e);
        return dataUrl;
    }
}

// ── VIDEOS (TABLE STORAGE FALLBACK) ───────────────────

async function dbSaveVideoData(base64Data) {
    if (!base64Data) return null;
    const sb = getSupabase();
    if (!sb) {
        setDbError("Supabase non disponible pour l'enregistrement vidéo");
        return null;
    }

    try {
        console.log(`[DB] Enregistrement vidéo dans la table videos_data (${Math.round(base64Data.length/1024)} KB)`);
        const { data, error } = await sb
            .from('videos_data')
            .insert([{ data: base64Data }])
            .select('id')
            .single();

        if (error) {
            console.error("[DB] Erreur sauvegarde vidéo table :", error);
            setDbError(`Erreur table vidéos: ${error.message}`);
            return null;
        }

        return data.id; // Returns the UUID
    } catch (e) {
        console.error("[DB] Exception sauvegarde vidéo table :", e);
        setDbError(`Exception table vidéos: ${e?.message || e}`);
        return null;
    }
}

async function dbGetVideoData(id) {
    if (!id) return null;
    const sb = getSupabase();
    if (!sb) return null;

    try {
        const { data, error } = await sb
            .from('videos_data')
            .select('data')
            .eq('id', id)
            .single();

        if (error || !data) {
            console.error("[DB] Erreur lecture vidéo table :", error);
            return null;
        }
        return data.data; // Returns the Base64 string
    } catch (e) {
        console.error("[DB] Exception lecture vidéo table :", e);
        return null;
    }
}

async function dbDeleteVideoData(id) {
    if (!id) return;
    const sb = getSupabase();
    if (sb) {
        await sb.from('videos_data').delete().eq('id', id);
    }
}

async function dbUploadFile(file) {
    // Keep this for potential future use or fallback, 
    // but the main flow will now use dbSaveVideoData for videos.
    if (!file) return null;
    const sb = getSupabase();
    if (!sb) {
        setDbError("Supabase non disponible pour l'upload");
        return null;
    }

    try {
        console.log(`[Storage] Préparation upload : ${file.name} (${file.size} bytes)`);
        const ext = file.name ? file.name.split('.').pop() : (file.type ? file.type.split('/')[1] : 'bin');
        const fileName = `${Date.now()}-${Math.random().toString(36).substring(2)}.${ext}`;
        const filePath = `${_activeUserId || 'guest'}/${fileName}`;

        const { data, error } = await sb.storage
            .from('gallery')
            .upload(filePath, file, { 
                contentType: file.type || 'application/octet-stream',
                upsert: true
            });

        if (error) {
            console.error("[Storage] Erreur fatale upload :", error);
            setDbError(`Erreur upload fichier: ${error.message}`);
            return null;
        }

        console.log("[Storage] Upload réussi, récupération de l'URL publique");
        const { data: publicData } = sb.storage.from('gallery').getPublicUrl(filePath);
        return publicData.publicUrl;
    } catch (e) {
        console.error("[Storage] Exception lors de l'upload :", e);
        setDbError(`Exception upload fichier: ${e?.message || e}`);
        return null;
    }
}

// ── IMAGES ────────────────────────────────────────────

async function dbGetAllImages() {
    const sb = getSupabase();
    if (sb) {
        try {
            const { data, error } = await sb
                .from('images')
                .select('*')
                .order('id', { ascending: false })
                .limit(100); // Optimization: avoid loading thousands of images at once
            if (!error && Array.isArray(data)) {
                const cloudImages = dedupeImages(data.map(fromCloudImage));
                clearDbError();
                return cloudImages;
            }
            if (error) setDbError(`Lecture images echouee: ${error.message || error}`);
        } catch (e) {
            setDbError(`Lecture images exception: ${e?.message || e}`);
        }
    }

    setDbError('Lecture images impossible: Supabase indisponible');
    return [];
}

async function dbGetAllImagesCloudOnly() {
    const sb = getSupabase();
    if (!sb) return [];
    try {
        const { data, error } = await sb
            .from('images')
            .select('*')
            .order('id', { ascending: false });
        if (error || !Array.isArray(data)) return [];
        return data.map(fromCloudImage);
    } catch (e) {
        return [];
    }
}

async function dbGetImagesByCategory(cat) {
    const all = await dbGetAllImages();
    if (!cat || cat === 'tous') return all;
    return all.filter((img) => (img.cat || '').toLowerCase() === String(cat).toLowerCase());
}

async function dbAddImage(url, cat, name = '') {
    let normalizedUrl = String(url || '').trim();
    if (!normalizedUrl) return null;

    // Optimization: Upload to Supabase Storage if it's a Base64 string
    if (isDataUrlImage(normalizedUrl)) {
        normalizedUrl = await dbUploadImage(normalizedUrl);
    }

    const imgObj = { url: normalizedUrl, cat, name: String(name || '').trim(), createdAt: Date.now() };

    const sb = getSupabase();
    if (sb) {
        try {
            const payload = toCloudImagePayload(imgObj, null);
            let insertResult = await sb.from('images').insert([payload]).select('*').single();
            // Backward compatibility: if "name" column is missing, retry without it.
            if (insertResult.error && payload.name) {
                const fallbackPayload = { url: payload.url, cat: payload.cat };
                insertResult = await sb.from('images').insert([fallbackPayload]).select('*').single();
            }
            const { data, error } = insertResult;
            if (!error && data) {
                clearDbError();
                const cloudImg = fromCloudImage(data);
                return cloudImg.id;
            }
            if (error) setDbError(`Insert image echoue: ${error.message || error}`);
        } catch (e) {
            setDbError(`Insert image exception: ${e?.message || e}`);
        }
    }

    setDbError('Insert image impossible: Supabase indisponible');
    return null;
}

// ── CLEANUP TOOLS ──────────────────────────────────────

async function dbCleanupBase64() {
    if (!confirm('Voulez-vous nettoyer la base de données ? Les images en Base64 seront migrées vers le Storage. Cela peut prendre un peu de temps.')) return;
    
    // 1. Cleanup Images Table
    const allImages = await dbGetAllImages();
    for (const img of allImages) {
        if (isDataUrlImage(img.url)) {
            console.log('Migrating image:', img.id);
            const newUrl = await dbUploadImage(img.url);
            const sb = getSupabase();
            await sb.from('images').update({ url: newUrl }).eq('id', img.id);
        }
    }

    // 2. Cleanup Weeks Table
    const allWeeks = await dbGetAllWeeks();
    for (const week of allWeeks) {
        let changed = false;
        for (const card of week.cards) {
            if (isDataUrlImage(card.image)) {
                card.image = await dbUploadImage(card.image);
                changed = true;
            }
            if (Array.isArray(card.gallery)) {
                for (let i = 0; i < card.gallery.length; i++) {
                    const item = card.gallery[i];
                    const url = item && typeof item === 'object' ? item.url : item;
                    if (isDataUrlImage(url)) {
                        const newUrl = await dbUploadImage(url);
                        if (item && typeof item === 'object') item.url = newUrl;
                        else card.gallery[i] = newUrl;
                        changed = true;
                    }
                }
            }
        }
        if (changed) {
            await dbUpdateWeek(week);
        }
    }
    
    alert('Nettoyage terminé. La base de données est maintenant optimisée.');
    window.location.reload();
}

async function dbDeleteImage(id) {
    if (!id) return;
    if (PROTECT_FROM_DELETION) {
        setDbError('Suppression image bloquee: mode anti-perte actif');
        return false;
    }

    const sb = getSupabase();
    if (sb) {
        try {
            const { error } = await sb.from('images').delete().eq('id', id);
            if (error) logDb('dbDeleteImage cloud error:', error.message || error);
        } catch (e) {
            logDb('dbDeleteImage cloud exception:', e?.message || e);
        }
    }

    if (!STRICT_CLOUD_MODE) {
        const db = await openDB();
        const tx = db.transaction('images', 'readwrite');
        tx.objectStore('images').delete(id);
    }
    return true;
}

async function dbUpdateImage(img) {
    if (!img || !img.id) return false;
    const sb = getSupabase();
    if (sb) {
        try {
            const payload = toCloudImagePayload(img, null);
            const { error } = await sb.from('images').update(payload).eq('id', img.id);
            if (error) {
                setDbError(`Update image echoue: ${error.message}`);
                return false;
            }
            clearDbError();
        } catch (e) {
            setDbError(`Update image exception: ${e?.message}`);
            return false;
        }
    }
    return true;
}

async function migrateToCloud() {
    triggerBackgroundSync(0);
    return true;
}
