const md = window.markdownit({
    html: false,
    breaks: true,
    linkify: true,
    typographer: true,
});

const DRAFT_CHAT_ID = "__draft__";
const ATTACHMENT_DB_NAME = "jobbr-local-files";
const ATTACHMENT_DB_VERSION = 2;
const ATTACHMENT_STORE_NAME = "attachments";
const ATTACHMENT_META_STORE_NAME = "meta";
const ATTACHMENT_VAULT_CONFIG_KEY = "vault-config";
const ATTACHMENT_KEY_DERIVATION_ITERATIONS = 250000;

const elements = {
    appLayout: document.querySelector(".app-layout"),
    sidebarBackdrop: document.getElementById("sidebar-backdrop"),
    settingsBackdrop: document.getElementById("settings-backdrop"),
    settingsDrawer: document.getElementById("settings-drawer"),
    chatList: document.getElementById("chat-list"),
    thread: document.getElementById("chat-thread"),
    emptyState: document.getElementById("empty-state"),
    title: document.getElementById("chat-title"),
    userName: document.getElementById("user-name"),
    userEmail: document.getElementById("user-email"),
    userAvatar: document.getElementById("user-avatar"),
    adminButton: document.getElementById("admin-button"),
    newChatButton: document.getElementById("new-chat-button"),
    renameChatButton: document.getElementById("rename-chat-button"),
    deleteChatButton: document.getElementById("delete-chat-button"),
    settingsToggleButton: document.getElementById("settings-toggle-button"),
    sidebarToggleButton: document.getElementById("sidebar-toggle-button"),
    logoutButton: document.getElementById("logout-button"),
    composer: document.getElementById("composer"),
    input: document.getElementById("input-box"),
    sendButton: document.getElementById("send-button"),
    attachmentInput: document.getElementById("attachment-input"),
    attachmentSecurity: document.getElementById("attachment-security"),
    attachmentTray: document.getElementById("attachment-tray"),
    attachmentStatus: document.getElementById("attachment-status"),
    attachmentPrivacy: document.getElementById("attachment-privacy"),
    settingsForm: document.getElementById("settings-form"),
    settingsCloseButton: document.getElementById("settings-close-button"),
    settingsTargetTitle: document.getElementById("settings-target-title"),
    settingsTargetDetail: document.getElementById("settings-target-detail"),
    providerSelect: document.getElementById("settings-provider"),
    modelSelect: document.getElementById("settings-model-select"),
    modelInput: document.getElementById("settings-model"),
    systemPromptInput: document.getElementById("settings-system-prompt"),
    temperatureInput: document.getElementById("settings-temperature"),
    reasoningSelect: document.getElementById("settings-reasoning"),
    settingsHint: document.getElementById("settings-hint"),
    settingsNotice: document.getElementById("settings-notice"),
    saveSettingsButton: document.getElementById("save-settings-button"),
    saveDefaultsButton: document.getElementById("save-defaults-button"),
};

const state = {
    user: null,
    chats: [],
    currentChatId: null,
    messages: [],
    hasDraft: false,
    draftInput: "",
    streaming: false,
    providers: [],
    defaultSettings: null,
    userPreferences: null,
    draftSettings: null,
    chatSettings: null,
    modelSelectionMode: "preset",
    settingsDirty: false,
    settingsSaving: false,
    settingsFeedback: "",
    settingsFeedbackTone: "muted",
    activeRunId: null,
    attachments: [],
    attachmentSessionNeedsSync: false,
    toolStatuses: [],
    attachmentSupport: {
        supported: typeof Worker !== "undefined" && typeof WebAssembly !== "undefined",
        persistenceSupported: typeof indexedDB !== "undefined" && Boolean(window.crypto?.subtle),
        ready: false,
        busy: false,
        message: "Local analysis loads on first file add and stays in this page session.",
    },
    attachmentSecurity: {
        persistentOptIn: false,
        unlocked: false,
        lockedRecordCount: 0,
        hasEncryptedVault: false,
        legacyRecordCount: 0,
    },
};

let renderQueued = false;
let pyodideBridge = null;
let attachmentVaultKey = null;
let attachmentVaultConfig = null;

const SUPPORTED_ATTACHMENT_TYPES = new Set([
    "csv",
    "tsv",
    "json",
    "txt",
    "md",
    "xlsx",
    "pdf",
    "docx",
]);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(render);
}

function createRequestId(prefix = "id") {
    if (window.crypto?.randomUUID) {
        return `${prefix}_${window.crypto.randomUUID()}`;
    }
    return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function sanitizeFileName(name) {
    return (name || "file")
        .replace(/[^a-zA-Z0-9._-]+/g, "_")
        .replace(/^_+/, "")
        || "file";
}

function fileExtension(name) {
    const parts = String(name || "").toLowerCase().split(".");
    return parts.length > 1 ? parts.at(-1) : "";
}

function attachmentKind(file) {
    const extension = fileExtension(file.name);
    return SUPPORTED_ATTACHMENT_TYPES.has(extension) ? extension : "";
}

function formatFileSize(bytes) {
    if (!Number.isFinite(bytes)) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function attachmentCountLabel(count) {
    return `${count} workspace file${count === 1 ? "" : "s"}`;
}

function totalAttachmentBytes() {
    return state.attachments.reduce((total, attachment) => total + (attachment.size_bytes || 0), 0);
}

function defaultAttachmentStatusMessage() {
    if (!state.attachments.length) {
        if (state.attachmentSecurity.lockedRecordCount > 0) {
            return `${attachmentCountLabel(state.attachmentSecurity.lockedRecordCount)} remembered on this device and locked.`;
        }
        return "Local analysis keeps files in this session unless you turn on encrypted device storage.";
    }

    const persistedCount = state.attachments.filter((attachment) => attachment.persistence === "browser").length;
    let storageCopy = "Session only.";
    if (persistedCount === state.attachments.length) {
        storageCopy = "Encrypted copy remembered on this device.";
    } else if (persistedCount > 0) {
        storageCopy = `${persistedCount} remembered on this device.`;
    }
    return `${attachmentCountLabel(state.attachments.length)} ready for local analysis. ${storageCopy}`;
}

function defaultAttachmentPrivacyMessage() {
    return state.attachmentSupport.persistenceSupported
        ? "Files are session-only by default. If you turn on Remember on this device, they are encrypted in this browser with your passphrase and never uploaded to the Jobbr website."
        : "Files are not uploaded to the internet or stored on the Jobbr website. They only exist while this page stays open.";
}

function setDefaultAttachmentStatus({ busy = false, ready = state.attachmentSupport.ready } = {}) {
    setAttachmentStatus(defaultAttachmentStatusMessage(), { busy, ready });
}

function attachmentPersistenceAvailable() {
    return Boolean(state.attachmentSupport.persistenceSupported);
}

function bytesToBase64(bytes) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
        const chunk = bytes.subarray(index, index + chunkSize);
        binary += String.fromCharCode(...chunk);
    }
    return window.btoa(binary);
}

function base64ToBytes(value) {
    const binary = window.atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}

function randomBase64(byteLength) {
    const bytes = new Uint8Array(byteLength);
    window.crypto.getRandomValues(bytes);
    return bytesToBase64(bytes);
}

function isEncryptedStoredRecord(record) {
    return Boolean(record?.scheme === "aes-gcm-v1" && record?.blob_ciphertext && record?.meta_ciphertext);
}

function isLegacyStoredRecord(record) {
    return Boolean(record?.blob);
}

async function deriveAttachmentVaultKey(passphrase, saltBase64) {
    const keyMaterial = await window.crypto.subtle.importKey(
        "raw",
        textEncoder.encode(passphrase),
        "PBKDF2",
        false,
        ["deriveKey"],
    );
    return window.crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt: base64ToBytes(saltBase64),
            iterations: ATTACHMENT_KEY_DERIVATION_ITERATIONS,
            hash: "SHA-256",
        },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
    );
}

async function encryptBytesWithVaultKey(key, bytesLike) {
    const iv = randomBase64(12);
    const ciphertext = await window.crypto.subtle.encrypt(
        { name: "AES-GCM", iv: base64ToBytes(iv) },
        key,
        bytesLike,
    );
    return {
        iv,
        ciphertext,
    };
}

async function decryptBytesWithVaultKey(key, ivBase64, bytesLike) {
    return window.crypto.subtle.decrypt(
        { name: "AES-GCM", iv: base64ToBytes(ivBase64) },
        key,
        bytesLike,
    );
}

async function promptForPassphrase({ confirm = false, existing = false } = {}) {
    const firstPrompt = existing
        ? "Enter the passphrase for remembered files on this device."
        : "Create a passphrase for remembered files on this device.";
    const passphrase = window.prompt(firstPrompt) || "";
    if (!passphrase.trim()) {
        return null;
    }
    if (!confirm) {
        return passphrase;
    }
    const confirmation = window.prompt("Re-enter that passphrase to confirm.") || "";
    if (passphrase !== confirmation) {
        throw new Error("Passphrases did not match.");
    }
    return passphrase;
}

class AttachmentVault {
    constructor() {
        this.supported = attachmentPersistenceAvailable();
        this.dbPromise = null;
    }

    disable() {
        this.supported = false;
        this.dbPromise = null;
    }

    async open() {
        if (!this.supported) {
            throw new Error("Browser file persistence is unavailable.");
        }
        if (this.dbPromise) {
            return this.dbPromise;
        }

        this.dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(ATTACHMENT_DB_NAME, ATTACHMENT_DB_VERSION);
            request.addEventListener("upgradeneeded", () => {
                const database = request.result;
                if (!database.objectStoreNames.contains(ATTACHMENT_STORE_NAME)) {
                    database.createObjectStore(ATTACHMENT_STORE_NAME, { keyPath: "id" });
                }
                if (!database.objectStoreNames.contains(ATTACHMENT_META_STORE_NAME)) {
                    database.createObjectStore(ATTACHMENT_META_STORE_NAME);
                }
            });
            request.addEventListener("success", () => {
                resolve(request.result);
            });
            request.addEventListener("error", () => {
                reject(request.error || new Error("Unable to open browser file storage."));
            });
        }).catch((error) => {
            this.disable();
            throw error;
        });

        return this.dbPromise;
    }

    async list() {
        const database = await this.open();
        return new Promise((resolve, reject) => {
            const transaction = database.transaction(ATTACHMENT_STORE_NAME, "readonly");
            const store = transaction.objectStore(ATTACHMENT_STORE_NAME);
            const request = store.getAll();
            request.addEventListener("success", () => resolve(request.result || []));
            request.addEventListener("error", () => reject(request.error || new Error("Unable to read browser files.")));
        });
    }

    async getConfig() {
        const database = await this.open();
        return new Promise((resolve, reject) => {
            const transaction = database.transaction(ATTACHMENT_META_STORE_NAME, "readonly");
            const store = transaction.objectStore(ATTACHMENT_META_STORE_NAME);
            const request = store.get(ATTACHMENT_VAULT_CONFIG_KEY);
            request.addEventListener("success", () => resolve(request.result || null));
            request.addEventListener("error", () => reject(request.error || new Error("Unable to read vault settings.")));
        });
    }

    async saveConfig(config) {
        const database = await this.open();
        return new Promise((resolve, reject) => {
            const transaction = database.transaction(ATTACHMENT_META_STORE_NAME, "readwrite");
            const store = transaction.objectStore(ATTACHMENT_META_STORE_NAME);
            const request = store.put(config, ATTACHMENT_VAULT_CONFIG_KEY);
            request.addEventListener("success", () => resolve(true));
            request.addEventListener("error", () => reject(request.error || new Error("Unable to save vault settings.")));
        });
    }

    async saveEncrypted(record, key) {
        const metadata = {
            name: record.name,
            mime_type: record.mime_type,
            size_bytes: record.size_bytes,
            kind: record.kind,
            path: record.path,
            last_modified: record.last_modified,
            saved_at: record.saved_at,
        };
        const encryptedMetadata = await encryptBytesWithVaultKey(key, textEncoder.encode(JSON.stringify(metadata)));
        const encryptedFile = await encryptBytesWithVaultKey(key, await record.file.arrayBuffer());
        const database = await this.open();
        return new Promise((resolve, reject) => {
            const transaction = database.transaction(ATTACHMENT_STORE_NAME, "readwrite");
            const store = transaction.objectStore(ATTACHMENT_STORE_NAME);
            const request = store.put({
                id: record.id,
                scheme: "aes-gcm-v1",
                meta_iv: encryptedMetadata.iv,
                meta_ciphertext: bytesToBase64(new Uint8Array(encryptedMetadata.ciphertext)),
                blob_iv: encryptedFile.iv,
                blob_ciphertext: new Blob([encryptedFile.ciphertext], { type: "application/octet-stream" }),
            });
            request.addEventListener("success", () => resolve(true));
            request.addEventListener("error", () => reject(request.error || new Error("Unable to persist encrypted file.")));
        });
    }

    async delete(attachmentId) {
        const database = await this.open();
        return new Promise((resolve, reject) => {
            const transaction = database.transaction(ATTACHMENT_STORE_NAME, "readwrite");
            const store = transaction.objectStore(ATTACHMENT_STORE_NAME);
            const request = store.delete(attachmentId);
            request.addEventListener("success", () => resolve(true));
            request.addEventListener("error", () => reject(request.error || new Error("Unable to remove browser file.")));
        });
    }

    async clear() {
        const database = await this.open();
        return new Promise((resolve, reject) => {
            const transaction = database.transaction([ATTACHMENT_STORE_NAME, ATTACHMENT_META_STORE_NAME], "readwrite");
            const attachmentStore = transaction.objectStore(ATTACHMENT_STORE_NAME);
            const metaStore = transaction.objectStore(ATTACHMENT_META_STORE_NAME);
            const clearAttachments = attachmentStore.clear();
            const clearConfig = metaStore.delete(ATTACHMENT_VAULT_CONFIG_KEY);
            let completed = 0;
            const finish = () => {
                completed += 1;
                if (completed === 2) resolve(true);
            };
            clearAttachments.addEventListener("success", finish);
            clearConfig.addEventListener("success", finish);
            clearAttachments.addEventListener("error", () => reject(clearAttachments.error || new Error("Unable to clear stored files.")));
            clearConfig.addEventListener("error", () => reject(clearConfig.error || new Error("Unable to clear vault settings.")));
        });
    }
}

const attachmentVault = new AttachmentVault();

async function decryptStoredAttachment(item, key) {
    const metadataBuffer = await decryptBytesWithVaultKey(
        key,
        item.meta_iv,
        base64ToBytes(item.meta_ciphertext),
    );
    const metadata = JSON.parse(textDecoder.decode(metadataBuffer));
    const ciphertextBuffer = item.blob_ciphertext instanceof Blob
        ? await item.blob_ciphertext.arrayBuffer()
        : item.blob_ciphertext;
    const fileBuffer = await decryptBytesWithVaultKey(key, item.blob_iv, ciphertextBuffer);
    const file = new File([fileBuffer], metadata.name, {
        type: metadata.mime_type || "application/octet-stream",
        lastModified: metadata.last_modified || Date.now(),
    });
    return {
        id: item.id,
        name: metadata.name,
        mime_type: metadata.mime_type || "application/octet-stream",
        size_bytes: metadata.size_bytes || file.size,
        kind: metadata.kind,
        path: metadata.path,
        last_modified: metadata.last_modified || file.lastModified || Date.now(),
        saved_at: metadata.saved_at || new Date().toISOString(),
        persistence: "browser",
        file,
    };
}

class PyodideBridge {
    constructor({ onReset } = {}) {
        this.worker = null;
        this.pending = new Map();
        this.readyPromise = null;
        this.onReset = typeof onReset === "function" ? onReset : null;
    }

    ensureWorker() {
        if (this.worker) return;
        this.worker = new Worker("/static/js/pyodide-worker.js");
        this.worker.addEventListener("message", (event) => {
            const { id, ok, output, error, meta } = event.data || {};
            const pending = this.pending.get(id);
            if (!pending) return;
            window.clearTimeout(pending.timeoutId);
            this.pending.delete(id);
            if (ok) {
                pending.resolve({ output, meta });
            } else {
                pending.reject(new Error(error || "Worker request failed."));
            }
        });
        this.worker.addEventListener("error", () => {
            this.rejectAll(new Error("Local analysis runtime crashed."));
            this.worker = null;
            this.readyPromise = null;
            this.onReset?.();
        });
    }

    rejectAll(error) {
        for (const pending of this.pending.values()) {
            window.clearTimeout(pending.timeoutId);
            pending.reject(error);
        }
        this.pending.clear();
    }

    async initialize() {
        if (this.readyPromise) return this.readyPromise;
        this.ensureWorker();
        this.readyPromise = this.request("init", {}, { timeoutMs: 45000 });
        try {
            await this.readyPromise;
        } catch (error) {
            this.readyPromise = null;
            throw error;
        }
    }

    request(type, args = {}, { timeoutMs = 12000, transfer = [] } = {}) {
        this.ensureWorker();
        return new Promise((resolve, reject) => {
            const id = createRequestId("worker");
            const timeoutId = window.setTimeout(() => {
                this.pending.delete(id);
                this.destroy();
                reject(new Error("Local analysis timed out and was restarted."));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timeoutId });
            this.worker.postMessage({ id, type, args }, transfer);
        });
    }

    async addAttachment(fileRecord, file) {
        await this.initialize();
        const buffer = await file.arrayBuffer();
        await this.request(
            "add_file",
            {
                file: fileRecord,
                bytes: buffer,
            },
            { timeoutMs: 30000, transfer: [buffer] },
        );
    }

    async clearSession() {
        if (!this.worker) return;
        try {
            await this.request("reset_session", {}, { timeoutMs: 5000 });
        } catch (error) {
            this.destroy();
        }
    }

    async runTool(name, args) {
        await this.initialize();
        const timeoutMs = name === "python.execute" ? 45000 : 30000;
        const { output } = await this.request("tool", { tool: name, args }, { timeoutMs });
        return output;
    }

    destroy() {
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
        }
        this.rejectAll(new Error("Local analysis runtime was reset."));
        this.readyPromise = null;
        this.onReset?.();
    }
}

function markAttachmentSessionDirty() {
    state.attachmentSessionNeedsSync = state.attachments.length > 0;
    state.attachmentSupport.ready = false;
    if (!state.attachmentSupport.busy) {
        state.attachmentSupport.message = defaultAttachmentStatusMessage();
        requestRender();
    }
}

function ensurePyodideBridge() {
    if (!pyodideBridge) {
        pyodideBridge = new PyodideBridge({ onReset: markAttachmentSessionDirty });
    }
    return pyodideBridge;
}

function closeSidebar() {
    elements.appLayout.classList.remove("sidebar-open");
}

function closeSettingsDrawer() {
    elements.appLayout.classList.remove("settings-open");
}

function cloneSettings(settings) {
    return {
        provider: settings?.provider || "",
        model: settings?.model || "",
        system_prompt: settings?.system_prompt || "",
        temperature: typeof settings?.temperature === "number" ? settings.temperature : null,
        reasoning_effort: settings?.reasoning_effort || null,
    };
}

function getConfiguredProvider() {
    return state.providers.find((provider) => provider.configured) || state.providers[0] || null;
}

function getProvider(providerId) {
    return state.providers.find((provider) => provider.id === providerId) || null;
}

function normalizeSettings(input = {}) {
    const provider = getProvider(input.provider) || getConfiguredProvider();
    const base = state.defaultSettings || {
        provider: provider?.id || "openai",
        model: provider?.default_model || "",
        system_prompt: "Respond using GitHub-flavored Markdown.",
        temperature: null,
        reasoning_effort: null,
    };
    const activeProvider = provider || getProvider(base.provider) || getConfiguredProvider();
    const temperature = input.temperature;
    const reasoningEffort = input.reasoning_effort || null;
    const rawSystemPrompt = typeof input.system_prompt === "string"
        ? input.system_prompt
        : (typeof base.system_prompt === "string" ? base.system_prompt : "");

    return {
        provider: activeProvider?.id || base.provider,
        model: (input.model || activeProvider?.default_model || base.model || "").trim(),
        system_prompt: rawSystemPrompt.trim() ? rawSystemPrompt : "Respond using GitHub-flavored Markdown.",
        temperature: typeof temperature === "number" && !Number.isNaN(temperature)
            ? temperature
            : null,
        reasoning_effort: activeProvider?.reasoning_efforts?.includes(reasoningEffort)
            ? reasoningEffort
            : null,
    };
}

function syncInputValue(input, nextValue) {
    if (input.value === nextValue) return;
    input.value = nextValue;
}

function getActiveSettings() {
    if (state.currentChatId && state.currentChatId !== DRAFT_CHAT_ID) {
        return normalizeSettings(state.chatSettings || state.userPreferences || state.defaultSettings);
    }
    return normalizeSettings(state.draftSettings || state.userPreferences || state.defaultSettings);
}

function setActiveSettings(nextSettings) {
    const normalized = normalizeSettings(nextSettings);
    if (state.currentChatId && state.currentChatId !== DRAFT_CHAT_ID) {
        state.chatSettings = normalized;
        return;
    }
    state.draftSettings = normalized;
}

function ensureDraftSettings() {
    if (!state.draftSettings) {
        state.draftSettings = normalizeSettings(state.userPreferences || state.defaultSettings);
    }
}

function currentChat() {
    return state.chats.find((chat) => chat.id === state.currentChatId) || null;
}

function startNewChat() {
    if (!state.hasDraft) {
        state.draftInput = "";
        state.draftSettings = normalizeSettings(state.userPreferences || state.defaultSettings);
        state.settingsDirty = false;
        state.settingsFeedback = "";
    }

    state.hasDraft = true;
    state.currentChatId = DRAFT_CHAT_ID;
    state.messages = [];
    state.modelSelectionMode = "preset";
    clearToolStatuses();
    elements.input.value = state.draftInput;
    closeSidebar();
    requestRender();
    resizeInput();
    elements.input.focus();
}

function resizeInput() {
    elements.input.style.height = "0px";
    elements.input.style.height = `${Math.min(elements.input.scrollHeight, 180)}px`;
}

function activeProviderSupportsBrowserTools() {
    const provider = getProvider(getActiveSettings().provider);
    return Boolean(provider?.supports_browser_tools);
}

function setAttachmentStatus(message, { busy = false, ready = state.attachmentSupport.ready } = {}) {
    state.attachmentSupport = {
        ...state.attachmentSupport,
        busy,
        ready,
        message,
    };
    requestRender();
}

async function ensureAttachmentRuntime() {
    if (!state.attachmentSupport.supported) {
        throw new Error("This browser does not support local file analysis.");
    }
    try {
        setAttachmentStatus("Preparing local analysis runtime...", { busy: true, ready: false });
        await ensurePyodideBridge().initialize();
        setDefaultAttachmentStatus({ busy: false, ready: true });
    } catch (error) {
        setAttachmentStatus(
            error instanceof Error ? error.message : "Unable to start local analysis runtime.",
            { busy: false, ready: false },
        );
        throw error;
    }
}

function clearToolStatuses() {
    state.toolStatuses = [];
}

function setToolStatus(toolCallId, name, status) {
    const existing = state.toolStatuses.find((item) => item.toolCallId === toolCallId);
    if (existing) {
        existing.status = status;
        existing.name = name;
    } else {
        state.toolStatuses.push({ toolCallId, name, status });
    }
    requestRender();
}

function removeCompletedToolStatuses() {
    state.toolStatuses = state.toolStatuses.filter((item) => item.status !== "completed");
}

function attachmentPayload(attachment) {
    return {
        id: attachment.id,
        name: attachment.name,
        mime_type: attachment.mime_type,
        size_bytes: attachment.size_bytes,
        kind: attachment.kind,
        path: attachment.path,
    };
}

function attachmentRecordFromFile(file) {
    const kind = attachmentKind(file);
    return {
        id: createRequestId("file"),
        name: file.name,
        mime_type: file.type || "application/octet-stream",
        size_bytes: file.size,
        kind,
        path: `/session/${createRequestId("blob")}_${sanitizeFileName(file.name)}`,
        last_modified: file.lastModified || Date.now(),
        saved_at: new Date().toISOString(),
        persistence: "session",
        file,
    };
}

function loadedPersistentAttachmentCount() {
    return state.attachments.filter((attachment) => attachment.persistence === "browser").length;
}

async function refreshStoredAttachmentState() {
    if (!attachmentVault.supported) {
        state.attachmentSupport.persistenceSupported = false;
        attachmentVaultKey = null;
        attachmentVaultConfig = null;
        state.attachmentSecurity = {
            ...state.attachmentSecurity,
            persistentOptIn: false,
            unlocked: false,
            lockedRecordCount: 0,
            hasEncryptedVault: false,
            legacyRecordCount: 0,
        };
        return;
    }

    const records = await attachmentVault.list();
    attachmentVaultConfig = await attachmentVault.getConfig();
    const encryptedRecords = records.filter(isEncryptedStoredRecord);
    const legacyRecords = records.filter(isLegacyStoredRecord);
    state.attachmentSecurity = {
        ...state.attachmentSecurity,
        hasEncryptedVault: Boolean(attachmentVaultConfig) || encryptedRecords.length > 0,
        lockedRecordCount: state.attachmentSecurity.unlocked ? 0 : encryptedRecords.length,
        legacyRecordCount: legacyRecords.length,
    };
    if (!state.attachmentSecurity.hasEncryptedVault) {
        state.attachmentSecurity.persistentOptIn = false;
        state.attachmentSecurity.unlocked = false;
        attachmentVaultKey = null;
    }
}

function mergeUnlockedAttachments(unlockedAttachments) {
    const merged = new Map();
    for (const attachment of state.attachments) {
        if (attachment.persistence !== "browser") {
            merged.set(attachment.id, attachment);
        }
    }
    for (const attachment of unlockedAttachments) {
        merged.set(attachment.id, attachment);
    }
    state.attachments = [...merged.values()];
}

async function rememberLoadedAttachments() {
    if (!state.attachmentSecurity.persistentOptIn || !attachmentVault.supported || !attachmentVaultKey) {
        return;
    }
    for (const attachment of state.attachments) {
        if (attachment.persistence === "browser") continue;
        await attachmentVault.saveEncrypted(attachment, attachmentVaultKey);
        attachment.persistence = "browser";
    }
    await refreshStoredAttachmentState();
}

async function unlockPersistedAttachments({ create = false, enableRemember = false } = {}) {
    if (!attachmentVault.supported) {
        throw new Error("Encrypted device storage is unavailable in this browser.");
    }

    const encryptedRecords = (await attachmentVault.list()).filter(isEncryptedStoredRecord);
    let config = attachmentVaultConfig || await attachmentVault.getConfig();
    let passphrase;
    if (!config) {
        if (encryptedRecords.length > 0) {
            throw new Error("Remembered files on this device are missing their vault settings and need to be cleared.");
        }
        if (!create) {
            throw new Error("No remembered files are stored on this device.");
        }
        passphrase = await promptForPassphrase({ confirm: true, existing: false });
        if (!passphrase) return false;
        config = {
            scheme: "aes-gcm-v1",
            salt: randomBase64(16),
            iterations: ATTACHMENT_KEY_DERIVATION_ITERATIONS,
            created_at: new Date().toISOString(),
        };
        await attachmentVault.saveConfig(config);
    } else {
        passphrase = await promptForPassphrase({ existing: true });
        if (!passphrase) return false;
    }

    const key = await deriveAttachmentVaultKey(passphrase, config.salt);
    let unlockedAttachments = [];
    try {
        unlockedAttachments = await Promise.all(
            encryptedRecords.map((record) => decryptStoredAttachment(record, key)),
        );
    } catch (error) {
        throw new Error("Passphrase did not unlock remembered files.");
    }

    attachmentVaultConfig = config;
    attachmentVaultKey = key;
    state.attachmentSecurity.unlocked = true;
    state.attachmentSecurity.persistentOptIn = enableRemember || state.attachmentSecurity.persistentOptIn;
    mergeUnlockedAttachments(unlockedAttachments);
    state.attachmentSessionNeedsSync = state.attachments.length > 0;
    await refreshStoredAttachmentState();
    if (state.attachments.length) {
        await rebuildAttachmentSession({ force: true });
    } else {
        setDefaultAttachmentStatus({ busy: false, ready: Boolean(pyodideBridge?.readyPromise) });
    }
    requestRender();
    return true;
}

async function lockPersistedAttachments() {
    attachmentVaultKey = null;
    state.attachmentSecurity.unlocked = false;
    state.attachmentSecurity.persistentOptIn = false;
    state.attachments = state.attachments.filter((attachment) => attachment.persistence !== "browser");
    clearToolStatuses();
    if (state.attachments.length) {
        state.attachmentSessionNeedsSync = true;
        await rebuildAttachmentSession({ force: true });
    } else if (pyodideBridge) {
        await pyodideBridge.clearSession();
        state.attachmentSessionNeedsSync = false;
    }
    await refreshStoredAttachmentState();
    setDefaultAttachmentStatus({ busy: false, ready: Boolean(pyodideBridge?.readyPromise) });
    requestRender();
}

async function clearStoredAttachments() {
    state.attachments = state.attachments.filter((attachment) => attachment.persistence !== "browser");
    clearToolStatuses();
    if (attachmentVault.supported) {
        await attachmentVault.clear();
    }
    attachmentVaultKey = null;
    attachmentVaultConfig = null;
    state.attachmentSecurity.unlocked = false;
    state.attachmentSecurity.persistentOptIn = false;
    await refreshStoredAttachmentState();
    if (state.attachments.length) {
        state.attachmentSessionNeedsSync = true;
        await rebuildAttachmentSession({ force: true });
    } else if (pyodideBridge) {
        await pyodideBridge.clearSession();
        state.attachmentSessionNeedsSync = false;
    }
    setDefaultAttachmentStatus({ busy: false, ready: Boolean(pyodideBridge?.readyPromise) });
    requestRender();
}

async function togglePersistentAttachments(enabled) {
    if (!enabled) {
        state.attachmentSecurity.persistentOptIn = false;
        setDefaultAttachmentStatus({ busy: false, ready: state.attachmentSupport.ready });
        requestRender();
        return;
    }

    if (!attachmentVault.supported) {
        throw new Error("Encrypted device storage is unavailable in this browser.");
    }

    if (!state.attachmentSecurity.unlocked) {
        const unlocked = await unlockPersistedAttachments({
            create: !state.attachmentSecurity.hasEncryptedVault,
            enableRemember: true,
        });
        if (!unlocked) return;
    }

    state.attachmentSecurity.persistentOptIn = true;
    await rememberLoadedAttachments();
    setDefaultAttachmentStatus({ busy: false, ready: state.attachmentSupport.ready });
    requestRender();
}

async function restorePersistedAttachments() {
    state.attachments = [];
    state.attachmentSessionNeedsSync = false;
    state.attachmentSecurity.persistentOptIn = false;
    state.attachmentSecurity.unlocked = false;
    attachmentVaultKey = null;

    if (!attachmentVault.supported) {
        state.attachmentSupport.persistenceSupported = false;
        setDefaultAttachmentStatus({ busy: false, ready: false });
        requestRender();
        return;
    }

    try {
        await refreshStoredAttachmentState();
        if (state.attachmentSecurity.lockedRecordCount > 0 && !attachmentVaultConfig) {
            setAttachmentStatus(
                "Remembered files were found, but their vault settings are missing. Clear stored files, then re-add what you need.",
                { busy: false, ready: false },
            );
        } else if (state.attachmentSecurity.legacyRecordCount > 0) {
            setAttachmentStatus(
                "Older unencrypted browser files were found from a previous version. Clear them, then re-add any files you still need.",
                { busy: false, ready: false },
            );
        } else {
            setDefaultAttachmentStatus({ busy: false, ready: false });
        }
    } catch (error) {
        state.attachmentSupport.persistenceSupported = false;
        setAttachmentStatus(
            "Encrypted device storage is unavailable here, so files will stay session-only.",
            { busy: false, ready: false },
        );
    }
    requestRender();
}

async function persistAttachmentRecord(record) {
    if (!state.attachmentSecurity.persistentOptIn || !attachmentVault.supported) {
        return false;
    }
    if (!attachmentVaultKey) {
        throw new Error("Unlock remembered files before adding more.");
    }
    await attachmentVault.saveEncrypted(record, attachmentVaultKey);
    record.persistence = "browser";
    await refreshStoredAttachmentState();
    return true;
}

async function addAttachments(fileList) {
    const files = [...fileList];
    if (!files.length) return;
    if (!activeProviderSupportsBrowserTools()) {
        setAttachmentStatus("Switch to a tool-capable provider such as OpenRouter to analyze files.");
        return;
    }

    await ensureAttachmentRuntime();
    if (state.attachmentSessionNeedsSync) {
        await rebuildAttachmentSession({ force: true });
    }

    for (const file of files) {
        const kind = attachmentKind(file);
        if (!kind) {
            setAttachmentStatus(`Unsupported file type for ${file.name}.`, { ready: true });
            continue;
        }

        const record = attachmentRecordFromFile(file);
        record.kind = kind;
        try {
            setAttachmentStatus(`Adding ${file.name} to Workspace files...`, { busy: true, ready: true });
            await ensurePyodideBridge().addAttachment(attachmentPayload(record), file);
            await persistAttachmentRecord(record);
            state.attachments.push(record);
            state.attachmentSessionNeedsSync = false;
            setDefaultAttachmentStatus({ busy: false, ready: true });
        } catch (error) {
            setAttachmentStatus(
                error instanceof Error ? error.message : `Unable to add ${file.name}.`,
                { busy: false, ready: false },
            );
            throw error;
        }
    }

    requestRender();
}

async function removeAttachment(attachmentId) {
    const attachment = state.attachments.find((item) => item.id === attachmentId) || null;
    state.attachments = state.attachments.filter((item) => item.id !== attachmentId);
    clearToolStatuses();

    if (attachment?.persistence === "browser" && attachmentVault.supported) {
        try {
            await attachmentVault.delete(attachmentId);
            await refreshStoredAttachmentState();
        } catch (error) {
            // Session state still wins even if browser cleanup misses once.
        }
    }

    if (state.attachments.length) {
        state.attachmentSessionNeedsSync = true;
        await rebuildAttachmentSession({ force: true });
    } else if (pyodideBridge) {
        await pyodideBridge.clearSession();
        state.attachmentSessionNeedsSync = false;
        setDefaultAttachmentStatus({ busy: false, ready: Boolean(pyodideBridge.readyPromise) });
    } else {
        state.attachmentSessionNeedsSync = false;
        setDefaultAttachmentStatus({ busy: false, ready: false });
    }

    requestRender();
}

async function resetAttachments({ clearStorage = true } = {}) {
    state.attachments = [];
    state.attachmentSessionNeedsSync = false;
    clearToolStatuses();
    if (pyodideBridge) {
        await pyodideBridge.clearSession();
    }

    if (clearStorage && attachmentVault.supported) {
        try {
            await attachmentVault.clear();
        } catch (error) {
            // Clearing the active workspace matters more than background cache cleanup.
        }
    }

    attachmentVaultKey = null;
    state.attachmentSecurity.unlocked = false;
    state.attachmentSecurity.persistentOptIn = false;
    await refreshStoredAttachmentState();
    setDefaultAttachmentStatus({ busy: false, ready: Boolean(pyodideBridge?.readyPromise) });
    requestRender();
}

async function rebuildAttachmentSession({ force = false } = {}) {
    if (!state.attachments.length) {
        state.attachmentSessionNeedsSync = false;
        return;
    }
    if (!force && !state.attachmentSessionNeedsSync) {
        return;
    }

    await ensureAttachmentRuntime();
    setAttachmentStatus(`Syncing ${attachmentCountLabel(state.attachments.length)} to local analysis...`, {
        busy: true,
        ready: true,
    });
    await ensurePyodideBridge().clearSession();
    for (const attachment of state.attachments) {
        await ensurePyodideBridge().addAttachment(attachmentPayload(attachment), attachment.file);
    }
    state.attachmentSessionNeedsSync = false;
    setDefaultAttachmentStatus({ busy: false, ready: true });
}

function scheduleAttachmentWarmup() {
    if (!state.attachmentSupport.supported || !activeProviderSupportsBrowserTools()) return;
    if (state.attachmentSupport.busy) return;
    if (pyodideBridge?.readyPromise && !state.attachmentSessionNeedsSync) return;

    const warmRuntime = async () => {
        try {
            setAttachmentStatus(
                state.attachments.length
                    ? `Warming local analysis for ${attachmentCountLabel(state.attachments.length)}...`
                    : "Warming local analysis runtime...",
                { busy: true, ready: false },
            );
            await ensurePyodideBridge().initialize();
            if (state.attachmentSessionNeedsSync) {
                await rebuildAttachmentSession({ force: true });
                return;
            }
            setDefaultAttachmentStatus({ busy: false, ready: true });
        } catch (error) {
            setDefaultAttachmentStatus({ busy: false, ready: false });
        }
    };

    if ("requestIdleCallback" in window) {
        window.requestIdleCallback(() => {
            warmRuntime().catch(() => {});
        }, { timeout: 1800 });
        return;
    }

    window.setTimeout(() => {
        warmRuntime().catch(() => {});
    }, 240);
}

async function parseError(response) {
    const text = await response.text();
    if (!text.trim()) {
        return `Request failed with status ${response.status}`;
    }

    try {
        const payload = JSON.parse(text);
        return payload.detail || payload.message || text;
    } catch (error) {
        return text;
    }
}

async function api(path, options = {}) {
    const response = await fetch(path, options);
    if (response.status === 401) {
        window.location.href = "/login";
        throw new Error("Authentication required.");
    }

    if (!response.ok) {
        throw new Error(await parseError(response));
    }

    if (response.status === 204) {
        return null;
    }

    return response.json();
}

function formatDate(value) {
    return new Date(value).toLocaleString([], {
        month: "short",
        day: "numeric",
    });
}

function formatChatGroupLabel(value) {
    const date = new Date(value);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const diffDays = Math.round((today - target) / 86400000);

    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    return date.toLocaleString([], {
        month: "short",
        day: "numeric",
        year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
    });
}

function escapeHtml(value) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function formatUserText(value) {
    return escapeHtml(value).replaceAll("\n", "<br>");
}

function getLanguageLabel(codeElement) {
    const match = [...codeElement.classList]
        .map((className) => className.match(/^language-(.+)$/))
        .find(Boolean);
    if (!match) return "Plain text";
    return match[1].replaceAll("-", " ");
}

function renderChatList() {
    if (!state.chats.length && !state.hasDraft) {
        elements.chatList.innerHTML = '<p class="sidebar-empty">No chats yet.</p>';
        return;
    }

    const groups = [];
    for (const chat of state.chats) {
        const label = formatChatGroupLabel(chat.updated_at);
        const lastGroup = groups.at(-1);
        if (!lastGroup || lastGroup.label !== label) {
            groups.push({ label, chats: [chat] });
        } else {
            lastGroup.chats.push(chat);
        }
    }

    const draftMarkup = state.hasDraft ? `
        <section class="chat-group">
            <p class="chat-group-label">Draft</p>
            <div class="chat-group-items">
                <button
                    type="button"
                    class="chat-list-item ${state.currentChatId === DRAFT_CHAT_ID ? "active" : ""}"
                    data-chat-id="${DRAFT_CHAT_ID}"
                >
                    <strong>${escapeHtml(state.draftInput.trim() || "New chat")}</strong>
                    <small>Not saved yet</small>
                </button>
            </div>
        </section>
    ` : "";

    elements.chatList.innerHTML = draftMarkup + groups.map((group) => `
        <section class="chat-group">
            <p class="chat-group-label">${escapeHtml(group.label)}</p>
            <div class="chat-group-items">
                ${group.chats.map((chat) => `
                    <button
                        type="button"
                        class="chat-list-item ${chat.id === state.currentChatId ? "active" : ""}"
                        data-chat-id="${chat.id}"
                    >
                        <strong>${escapeHtml(chat.title)}</strong>
                        <small>${formatDate(chat.updated_at)}</small>
                    </button>
                `).join("")}
            </div>
        </section>
    `).join("");
}

function renderStatusLine(label, { inline = false, subtle = false } = {}) {
    return `
        <span class="status-line ${inline ? "status-line-inline" : ""} ${subtle ? "status-line-subtle" : ""}">
            <span class="ring-loader" aria-hidden="true"></span>
            <span>${escapeHtml(label)}</span>
        </span>
    `;
}

function activeAssistantStatus(message, index, messages) {
    if (!state.streaming || message.role !== "assistant" || index !== messages.length - 1) {
        return "";
    }
    const runningTool = state.toolStatuses.find((tool) => tool.status === "running");
    if (runningTool) {
        return `Working with local files via ${runningTool.name}`;
    }
    const queuedTool = state.toolStatuses.find((tool) => tool.status === "queued");
    if (queuedTool) {
        return `Preparing ${queuedTool.name}`;
    }
    return message.content.trim() ? "Streaming response" : "Thinking";
}

function renderMessage(message, index, messages) {
    const assistantStatus = activeAssistantStatus(message, index, messages);
    const statusMarkup = assistantStatus
        ? `<div class="message-status-row">${renderStatusLine(assistantStatus)}</div>`
        : "";
    const toolMarkup = message.role === "assistant" && Array.isArray(message.toolCalls) && message.toolCalls.length
        ? `
            <div class="tool-status-list">
                ${message.toolCalls.map((tool) => `
                    <span class="tool-status-chip">
                        ${escapeHtml(tool.name)}
                        <strong>${escapeHtml(tool.status)}</strong>
                    </span>
                `).join("")}
            </div>
        `
        : "";
    const body = message.role === "assistant"
        ? (
            message.content.trim()
                ? md.render(message.content)
                : (assistantStatus ? "" : '<div class="message-placeholder">Waiting for response</div>')
        )
        : `<p>${formatUserText(message.content)}</p>`;

    return `
        <article class="message message-${message.role}">
            <div class="message-body ${message.role}-body">${statusMarkup}${toolMarkup}${body}</div>
        </article>
    `;
}

function enhanceCodeBlocks() {
    const codeBlocks = elements.thread.querySelectorAll(".assistant-body pre");
    codeBlocks.forEach((pre) => {
        if (pre.querySelector(".code-toolbar")) return;
        const code = pre.querySelector("code");
        if (!code) return;

        const toolbar = document.createElement("div");
        toolbar.className = "code-toolbar";

        const label = document.createElement("span");
        label.className = "code-language";
        label.textContent = getLanguageLabel(code);

        const button = document.createElement("button");
        button.className = "copy-code";
        button.type = "button";
        button.dataset.copyText = code.innerText;
        button.textContent = "Copy";

        toolbar.append(label, button);
        pre.prepend(toolbar);
    });
}

function renderThread() {
    const visibleMessages = state.currentChatId === DRAFT_CHAT_ID ? [] : state.messages;
    const hasMessages = visibleMessages.length > 0;
    const hasSelection = Boolean(state.currentChatId);
    elements.emptyState.hidden = hasSelection && hasMessages;
    elements.thread.hidden = !(hasSelection && hasMessages);

    if (!(hasSelection && hasMessages)) {
        elements.thread.innerHTML = "";
        return;
    }

    elements.thread.innerHTML = visibleMessages.map(renderMessage).join("");
    enhanceCodeBlocks();
    elements.thread.scrollTop = elements.thread.scrollHeight;
}

function renderAttachmentSecurity(providerSupportsTools) {
    const showSecurity = state.attachmentSupport.supported || state.attachmentSecurity.hasEncryptedVault || state.attachmentSecurity.legacyRecordCount > 0;
    if (!showSecurity) {
        elements.attachmentSecurity.hidden = true;
        elements.attachmentSecurity.innerHTML = "";
        return;
    }

    const actions = [];
    if (attachmentPersistenceAvailable()) {
        actions.push(`
            <label class="attachment-persist-toggle">
                <input
                    type="checkbox"
                    data-attachment-action="toggle-persist"
                    ${state.attachmentSecurity.persistentOptIn ? "checked" : ""}
                >
                <span>Remember on this device</span>
            </label>
        `);
    }
    if (state.attachmentSecurity.lockedRecordCount > 0 && !state.attachmentSecurity.unlocked) {
        actions.push('<button type="button" class="ghost-button attachment-security-button" data-attachment-action="unlock-stored">Unlock files</button>');
    }
    if (state.attachmentSecurity.unlocked && loadedPersistentAttachmentCount() > 0) {
        actions.push('<button type="button" class="ghost-button attachment-security-button" data-attachment-action="lock-stored">Lock files</button>');
    }
    if (state.attachmentSecurity.hasEncryptedVault || state.attachmentSecurity.legacyRecordCount > 0) {
        actions.push('<button type="button" class="ghost-button attachment-security-button" data-attachment-action="clear-stored">Clear stored files</button>');
    }

    let summary = "Session-only mode keeps new files out of browser storage.";
    if (!attachmentPersistenceAvailable()) {
        summary = "Encrypted device storage is unavailable in this browser.";
    } else if (state.attachmentSecurity.legacyRecordCount > 0) {
        summary = `${attachmentCountLabel(state.attachmentSecurity.legacyRecordCount)} from an older unencrypted cache need to be cleared.`;
    } else if (state.attachmentSecurity.lockedRecordCount > 0) {
        summary = `${attachmentCountLabel(state.attachmentSecurity.lockedRecordCount)} remembered on this device and locked.`;
    } else if (state.attachmentSecurity.unlocked && loadedPersistentAttachmentCount() > 0) {
        summary = "Remembered files are unlocked for this session.";
    } else if (state.attachmentSecurity.persistentOptIn) {
        summary = "New files will be encrypted before they are remembered on this device.";
    }
    if (!providerSupportsTools) {
        summary += " Switch to a tool-capable provider to analyze local files.";
    }

    elements.attachmentSecurity.hidden = false;
    elements.attachmentSecurity.innerHTML = `
        <section class="attachment-security-panel">
            <div class="attachment-security-actions">
                ${actions.join("")}
            </div>
            <p class="attachment-security-copy">${escapeHtml(summary)}</p>
        </section>
    `;
}

function renderAttachments() {
    const providerSupportsTools = activeProviderSupportsBrowserTools();
    elements.attachmentInput.disabled = state.streaming || !providerSupportsTools;
    elements.attachmentPrivacy.hidden = !state.attachmentSupport.supported;
    elements.attachmentPrivacy.textContent = defaultAttachmentPrivacyMessage();
    renderAttachmentSecurity(providerSupportsTools);

    let attachmentStatusMessage = "";
    if (!state.attachmentSupport.supported) {
        attachmentStatusMessage = "This browser does not support local file analysis.";
    } else if (!providerSupportsTools) {
        attachmentStatusMessage = "Switch to a tool-capable provider such as OpenRouter to analyze files.";
    } else {
        attachmentStatusMessage = state.attachmentSupport.message;
    }
    elements.attachmentStatus.innerHTML = state.attachmentSupport.busy
        ? renderStatusLine(attachmentStatusMessage, { inline: true, subtle: true })
        : `<span>${escapeHtml(attachmentStatusMessage)}</span>`;

    if (!state.attachments.length) {
        elements.attachmentTray.hidden = true;
        elements.attachmentTray.innerHTML = "";
        return;
    }

    const totalBytes = formatFileSize(totalAttachmentBytes());
    const persistedCount = loadedPersistentAttachmentCount();
    const storageSummary = persistedCount === state.attachments.length
        ? "Encrypted copy remembered on this device"
        : (persistedCount > 0 ? `${persistedCount} remembered on this device` : "Session only");

    elements.attachmentTray.hidden = false;
    elements.attachmentTray.innerHTML = `
        <section class="attachment-manager">
            <div class="attachment-manager-header">
                <div>
                    <p class="attachment-manager-kicker">Workspace files</p>
                    <strong>${escapeHtml(attachmentCountLabel(state.attachments.length))} available to you and the model</strong>
                </div>
                <button type="button" class="ghost-button attachment-clear-button" data-attachment-action="clear-all">
                    Clear all
                </button>
            </div>
            <p class="attachment-manager-summary">${escapeHtml(`${totalBytes} · ${storageSummary}`)}</p>
            <div class="attachment-list">
                ${state.attachments.map((attachment) => `
                    <div class="attachment-item">
                        <div class="attachment-item-copy">
                            <strong>${escapeHtml(attachment.name)}</strong>
                            <span>${escapeHtml(
                                `${attachment.kind.toUpperCase()} · ${formatFileSize(attachment.size_bytes)} · ${
                                    attachment.persistence === "browser" ? "Remembered on device" : "Session only"
                                }`
                            )}</span>
                        </div>
                        <button
                            type="button"
                            class="attachment-remove"
                            data-attachment-id="${escapeHtml(attachment.id)}"
                            aria-label="Remove ${escapeHtml(attachment.name)}"
                        >
                            Remove
                        </button>
                    </div>
                `).join("")}
            </div>
        </section>
    `;
}

function renderUser() {
    if (!state.user) return;
    elements.userName.textContent = state.user.username;
    elements.userEmail.textContent = state.user.email;
    elements.userAvatar.textContent = state.user.username[0].toUpperCase();
    elements.adminButton.hidden = !state.user.is_admin;
}

function renderTitle() {
    if (state.currentChatId === DRAFT_CHAT_ID) {
        elements.title.textContent = "New chat";
        return;
    }
    const activeChat = currentChat();
    elements.title.textContent = activeChat ? activeChat.title : "New chat";
}

function renderProviderOptions(activeProviderId) {
    elements.providerSelect.innerHTML = state.providers.map((provider) => `
        <option value="${escapeHtml(provider.id)}" ${provider.configured ? "" : "disabled"}>
            ${escapeHtml(provider.label)}${provider.configured ? "" : " (unconfigured)"}
        </option>
    `).join("");

    if (activeProviderId) {
        elements.providerSelect.value = activeProviderId;
    }
}

function renderModelControl(provider, settings) {
    const models = provider?.models || [];
    const modelIds = new Set(models.map((model) => model.id));
    const currentModel = settings.model || provider?.default_model || "";
    const customModeRequested = state.modelSelectionMode === "custom" && Boolean(provider?.allow_custom_models);
    const usingCustomModel = Boolean(
        provider?.allow_custom_models && (customModeRequested || (currentModel && !modelIds.has(currentModel)))
    );
    const showInput = !models.length || (provider?.allow_custom_models && usingCustomModel);

    if (models.length) {
        const options = models.map((model) => `
            <option value="${escapeHtml(model.id)}">${escapeHtml(model.label)}</option>
        `);
        if (provider?.allow_custom_models) {
            options.push('<option value="__custom__">Custom model…</option>');
        }
        elements.modelSelect.innerHTML = options.join("");
        elements.modelSelect.hidden = false;
        elements.modelSelect.disabled = false;
        elements.modelSelect.value = usingCustomModel ? "__custom__" : (currentModel || provider.default_model || models[0].id);
    } else {
        elements.modelSelect.hidden = true;
        elements.modelSelect.innerHTML = "";
        elements.modelSelect.disabled = true;
    }

    syncInputValue(elements.modelInput, showInput ? currentModel : "");
    elements.modelInput.placeholder = provider?.allow_custom_models
        ? (provider?.default_model || "Model ID")
        : "Locked by server";
    elements.modelInput.hidden = !showInput;
    elements.modelInput.disabled = !provider?.allow_custom_models;
}

function syncSettingsControls() {
    ensureDraftSettings();
    const settings = getActiveSettings();
    const provider = getProvider(settings.provider) || getConfiguredProvider();

    if (!provider) {
        elements.settingsHint.textContent = "No providers are available yet.";
        elements.settingsNotice.textContent = "";
        elements.saveSettingsButton.disabled = true;
        elements.saveDefaultsButton.disabled = true;
        return;
    }

    renderProviderOptions(provider.id);
    renderModelControl(provider, settings);
    syncInputValue(elements.systemPromptInput, settings.system_prompt || "");
    elements.temperatureInput.disabled = !provider.supports_temperature;
    syncInputValue(
        elements.temperatureInput,
        typeof settings.temperature === "number" ? String(settings.temperature) : "",
    );

    const reasoningOptions = ['<option value="">Disabled</option>']
        .concat((provider.reasoning_efforts || []).map((level) => `
            <option value="${escapeHtml(level)}">${escapeHtml(level)}</option>
        `));
    elements.reasoningSelect.innerHTML = reasoningOptions.join("");
    elements.reasoningSelect.disabled = !(provider.reasoning_efforts || []).length;
    elements.reasoningSelect.value = settings.reasoning_effort || "";

    const targetIsSavedChat = Boolean(state.currentChatId && state.currentChatId !== DRAFT_CHAT_ID);
    const targetChat = currentChat();
    elements.settingsTargetTitle.textContent = targetIsSavedChat
        ? (targetChat?.title || "Chat settings")
        : "New chat";
    elements.settingsTargetDetail.textContent = targetIsSavedChat
        ? "Saved on this conversation"
        : "Applies to the next new conversation";

    const modelCount = provider.models?.length || 0;
    const modelCopy = !provider.allow_custom_models
        ? `Model is server-locked to ${provider.default_model}.`
        : (
            modelCount
                ? `${modelCount} suggested model${modelCount === 1 ? "" : "s"} available.`
                : "Use any valid model id for this provider."
        );
    const toolCopy = provider.supports_browser_tools
        ? " Browser-local file tools are available."
        : " Browser-local file analysis is unavailable on this provider.";
    elements.settingsHint.textContent = provider.configured
        ? `${provider.label} is ready. ${modelCopy}${toolCopy}`
        : `${provider.label} is not configured on this server yet.`;

    elements.saveSettingsButton.hidden = !targetIsSavedChat;
    elements.saveSettingsButton.disabled = (
        !targetIsSavedChat
        || state.streaming
        || state.settingsSaving
        || !state.settingsDirty
    );
    elements.saveDefaultsButton.disabled = state.streaming || state.settingsSaving;

    if (state.settingsFeedback) {
        elements.settingsNotice.textContent = state.settingsFeedback;
        elements.settingsNotice.dataset.tone = state.settingsFeedbackTone;
    } else if (targetIsSavedChat && state.settingsDirty) {
        elements.settingsNotice.textContent = "Unsaved chat settings. Sending will save them first.";
        elements.settingsNotice.dataset.tone = "muted";
    } else if (!targetIsSavedChat) {
        elements.settingsNotice.textContent = "These settings will ride along with the next new chat.";
        elements.settingsNotice.dataset.tone = "muted";
    } else {
        elements.settingsNotice.textContent = "This chat is using saved run settings.";
        elements.settingsNotice.dataset.tone = "muted";
    }
}

function syncControls() {
    elements.sendButton.disabled = (
        state.streaming
        || !elements.input.value.trim()
        || (state.attachments.length > 0 && !activeProviderSupportsBrowserTools())
        || (state.attachments.length > 0 && state.attachmentSupport.busy)
    );
    elements.renameChatButton.disabled = !state.currentChatId || state.currentChatId === DRAFT_CHAT_ID || state.streaming;
    elements.deleteChatButton.disabled = !state.currentChatId || state.currentChatId === DRAFT_CHAT_ID || state.streaming;
    elements.newChatButton.disabled = state.streaming;
    elements.settingsToggleButton.disabled = state.settingsSaving;
    if (state.currentChatId === DRAFT_CHAT_ID) {
        state.draftInput = elements.input.value;
    }
    resizeInput();
    syncSettingsControls();
}

function render() {
    renderQueued = false;
    renderUser();
    renderTitle();
    renderChatList();
    renderThread();
    renderAttachments();
    syncControls();
}

function setSettingsFeedback(message, tone = "muted") {
    state.settingsFeedback = message;
    state.settingsFeedbackTone = tone;
    syncSettingsControls();
}

function markSettingsDirty() {
    state.settingsDirty = true;
    state.settingsFeedback = "";
    syncSettingsControls();
    requestRender();
}

async function fetchCurrentUser() {
    const payload = await api("/api/auth/me");
    state.user = payload;
}

async function fetchProviders() {
    const payload = await api("/api/providers");
    state.providers = payload.providers || [];
    state.defaultSettings = normalizeSettings(payload.default_settings || {});
}

async function fetchPreferences() {
    const payload = await api("/api/me/preferences");
    state.userPreferences = normalizeSettings(payload);
    ensureDraftSettings();
}

async function fetchChats() {
    const payload = await api("/api/chats");
    state.chats = payload.chats;
}

async function loadChat(chatId) {
    if (state.currentChatId === DRAFT_CHAT_ID) {
        state.draftInput = elements.input.value;
    }
    if (chatId === DRAFT_CHAT_ID) {
        ensureDraftSettings();
        state.currentChatId = DRAFT_CHAT_ID;
        state.messages = [];
        state.chatSettings = null;
        state.modelSelectionMode = "preset";
        clearToolStatuses();
        state.settingsDirty = false;
        elements.input.value = state.draftInput;
        closeSidebar();
        requestRender();
        return;
    }

    const payload = await api(`/api/chats/${chatId}`);
    state.currentChatId = payload.id;
    state.messages = payload.messages;
    state.chatSettings = normalizeSettings(payload.settings || state.userPreferences);
    state.modelSelectionMode = "preset";
    clearToolStatuses();
    state.settingsDirty = false;
    state.settingsFeedback = "";
    elements.input.value = "";
    closeSidebar();
    requestRender();
}

async function createChat() {
    const settings = cloneSettings(getActiveSettings());
    const chat = await api("/api/chats", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ settings }),
    });
    state.chats.unshift(chat);
    state.currentChatId = chat.id;
    state.messages = [];
    state.chatSettings = normalizeSettings(settings);
    state.modelSelectionMode = "preset";
    state.hasDraft = false;
    state.draftInput = "";
    state.draftSettings = normalizeSettings(state.userPreferences || state.defaultSettings);
    state.settingsDirty = false;
    requestRender();
    return chat;
}

async function refreshSidebarAndChat() {
    const currentChatId = state.currentChatId;
    await fetchChats();
    if (currentChatId) {
        await loadChat(currentChatId);
    } else {
        requestRender();
    }
}

async function saveCurrentChatSettings({ silent = false } = {}) {
    if (!state.currentChatId || state.currentChatId === DRAFT_CHAT_ID) {
        state.settingsDirty = false;
        if (!silent) {
            setSettingsFeedback("Draft settings are ready for the next new chat.", "muted");
        }
        return getActiveSettings();
    }

    state.settingsSaving = true;
    syncSettingsControls();
    try {
        const payload = await api(`/api/chats/${state.currentChatId}/settings`, {
            method: "PATCH",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(getActiveSettings()),
        });
        state.chatSettings = normalizeSettings(payload);
        state.settingsDirty = false;
        if (!silent) {
            setSettingsFeedback("Chat settings saved.", "success");
        }
        return state.chatSettings;
    } finally {
        state.settingsSaving = false;
        syncSettingsControls();
    }
}

async function saveDefaults() {
    state.settingsSaving = true;
    syncSettingsControls();
    try {
        const payload = await api("/api/me/preferences", {
            method: "PATCH",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(getActiveSettings()),
        });
        state.userPreferences = normalizeSettings(payload);
        if (!state.currentChatId || state.currentChatId === DRAFT_CHAT_ID) {
            state.draftSettings = normalizeSettings(payload);
            state.settingsDirty = false;
        }
        setSettingsFeedback("Defaults saved for future chats.", "success");
    } finally {
        state.settingsSaving = false;
        syncSettingsControls();
    }
}

function currentAttachmentManifest() {
    return state.attachments.map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        mime_type: attachment.mime_type,
        size_bytes: attachment.size_bytes,
        kind: attachment.kind,
    }));
}

function syncAssistantToolState(assistantMessage) {
    assistantMessage.toolCalls = state.toolStatuses.map((tool) => ({
        name: tool.name,
        status: tool.status,
    }));
}

function summarizeToolOutput(output) {
    if (!output) return "";
    if (typeof output.summary_for_model === "string" && output.summary_for_model) {
        return output.summary_for_model;
    }
    const serialized = JSON.stringify(output);
    return serialized.length > 4000 ? `${serialized.slice(0, 3997)}...` : serialized;
}

function isRecoverableRuntimeError(error) {
    const message = String(error || "").toLowerCase();
    return (
        message.includes("timed out")
        || message.includes("restarted")
        || message.includes("reset")
        || message.includes("crashed")
    );
}

async function executeBrowserToolCall(toolCall, assistantMessage) {
    setToolStatus(toolCall.tool_call_id, toolCall.name, "running");
    syncAssistantToolState(assistantMessage);
    requestRender();

    try {
        const output = await ensurePyodideBridge().runTool(toolCall.name, toolCall.arguments || {});
        setToolStatus(toolCall.tool_call_id, toolCall.name, "completed");
        syncAssistantToolState(assistantMessage);
        requestRender();
        return {
            tool_call_id: toolCall.tool_call_id,
            name: toolCall.name,
            output,
            summary_for_model: summarizeToolOutput(output),
        };
    } catch (error) {
        if (state.attachments.length && isRecoverableRuntimeError(error)) {
            try {
                setAttachmentStatus("Recovering Workspace files after a local runtime reset...", {
                    busy: true,
                    ready: false,
                });
                state.attachmentSessionNeedsSync = true;
                await rebuildAttachmentSession({ force: true });
                const output = await ensurePyodideBridge().runTool(toolCall.name, toolCall.arguments || {});
                setToolStatus(toolCall.tool_call_id, toolCall.name, "completed");
                syncAssistantToolState(assistantMessage);
                requestRender();
                return {
                    tool_call_id: toolCall.tool_call_id,
                    name: toolCall.name,
                    output,
                    summary_for_model: summarizeToolOutput(output),
                };
            } catch (retryError) {
                error = retryError;
            }
        }

        setToolStatus(toolCall.tool_call_id, toolCall.name, "failed");
        syncAssistantToolState(assistantMessage);
        requestRender();
        const message = error instanceof Error ? error.message : "Unknown tool failure";
        return {
            tool_call_id: toolCall.tool_call_id,
            name: toolCall.name,
            output: { error: message },
            summary_for_model: `Tool failed: ${message}`,
        };
    }
}

async function submitToolResults(runId, results) {
    await api(`/api/runs/${runId}/tool-results`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ results }),
    });
}

async function consumeRunStream(response, assistantMessage) {
    if (!response.body) {
        throw new Error("The server returned an empty response body.");
    }

    const reader = response.body
        .pipeThrough(new TextDecoderStream())
        .getReader();
    const pendingToolCalls = [];
    let buffer = "";

    while (true) {
        const { value, done } = await reader.read();
        if (value) {
            buffer += value;
            while (buffer.includes("\n")) {
                const newlineIndex = buffer.indexOf("\n");
                const rawLine = buffer.slice(0, newlineIndex);
                buffer = buffer.slice(newlineIndex + 1);
                const line = rawLine.trim();
                if (!line) continue;
                const event = JSON.parse(line);

                if (event.type === "run.started") {
                    state.activeRunId = event.run_id;
                    continue;
                }

                if (event.type === "tool.call.requested") {
                    pendingToolCalls.push(event);
                    setToolStatus(event.tool_call_id, event.name, "queued");
                    syncAssistantToolState(assistantMessage);
                    requestRender();
                    continue;
                }

                if (event.type === "run.awaiting_tool_results") {
                    const requestedCalls = pendingToolCalls.splice(0, pendingToolCalls.length);
                    const results = await Promise.all(
                        requestedCalls.map((toolCall) => executeBrowserToolCall(toolCall, assistantMessage)),
                    );
                    await submitToolResults(event.run_id, results);
                    syncAssistantToolState(assistantMessage);
                    requestRender();
                    continue;
                }

                if (event.type === "tool.call.completed") {
                    setToolStatus(event.tool_call_id, event.name, "completed");
                    syncAssistantToolState(assistantMessage);
                    requestRender();
                    continue;
                }

                if (event.type === "message.delta") {
                    assistantMessage.content += event.delta || "";
                    requestRender();
                    continue;
                }

                if (event.type === "message.completed") {
                    assistantMessage.content = event.content || assistantMessage.content;
                    requestRender();
                    continue;
                }

                if (event.type === "run.failed") {
                    throw new Error(event.error || "Run failed.");
                }

                if (event.type === "run.completed") {
                    state.activeRunId = null;
                    return;
                }
            }
        }

        if (done) break;
    }

    if (buffer.trim()) {
        const event = JSON.parse(buffer.trim());
        if (event.type === "run.failed") {
            throw new Error(event.error || "Run failed.");
        }
    }
}

async function sendMessage() {
    const content = elements.input.value.trim();
    if (!content || state.streaming) return;
    if (state.attachments.length && !activeProviderSupportsBrowserTools()) {
        setAttachmentStatus("Switch to a tool-capable provider such as OpenRouter to analyze files.");
        return;
    }

    try {
        if (state.currentChatId && state.currentChatId !== DRAFT_CHAT_ID && state.settingsDirty) {
            await saveCurrentChatSettings({ silent: true });
        }

        if (!state.currentChatId || state.currentChatId === DRAFT_CHAT_ID) {
            await createChat();
        }
    } catch (error) {
        setSettingsFeedback(
            error instanceof Error ? error.message : "Unable to update run settings.",
            "danger",
        );
        return;
    }

    const chatId = state.currentChatId;
    const assistantMessage = { role: "assistant", content: "", toolCalls: [] };

    state.messages.push({ role: "user", content });
    state.messages.push(assistantMessage);
    state.streaming = true;
    elements.input.value = "";
    state.draftInput = "";
    requestRender();

    let requestSucceeded = false;

    try {
        if (state.attachments.length) {
            await rebuildAttachmentSession();
        }
        const response = await fetch(`/api/chats/${chatId}/runs`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                input: content,
                attachment_manifest: currentAttachmentManifest(),
            }),
        });

        if (response.status === 401) {
            window.location.href = "/login";
            return;
        }

        if (!response.ok) {
            throw new Error(await parseError(response));
        }
        await consumeRunStream(response, assistantMessage);
        requestSucceeded = true;
    } catch (error) {
        assistantMessage.content = `### Request failed\n\n${
            error instanceof Error ? error.message : "Unknown error"
        }`;
        clearToolStatuses();
    } finally {
        state.streaming = false;
        state.activeRunId = null;
        if (requestSucceeded) {
            clearToolStatuses();
            await refreshSidebarAndChat();
        } else {
            requestRender();
        }
    }
}

async function renameCurrentChat() {
    if (!state.currentChatId || state.streaming) return;

    const currentTitle = currentChat()?.title || "";
    const nextTitle = window.prompt("Rename chat", currentTitle);
    if (nextTitle === null) return;

    const title = nextTitle.trim();
    if (!title) return;

    await api(`/api/chats/${state.currentChatId}`, {
        method: "PATCH",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ title }),
    });
    await refreshSidebarAndChat();
}

async function logout() {
    await resetAttachments({ clearStorage: false });
    if (pyodideBridge) {
        pyodideBridge.destroy();
    }
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
}

async function deleteCurrentChat() {
    if (!state.currentChatId || state.streaming) return;

    const activeChat = currentChat();
    const confirmed = window.confirm(
        `Delete "${activeChat?.title || "this chat"}"? This cannot be undone.`
    );
    if (!confirmed) return;

    const deletedChatId = state.currentChatId;
    await api(`/api/chats/${deletedChatId}`, {
        method: "DELETE",
    });

    state.messages = [];
    state.currentChatId = null;
    state.chatSettings = null;
    state.settingsDirty = false;
    await fetchChats();

    const nextChat = state.chats.find((chat) => chat.id !== deletedChatId);
    if (nextChat) {
        await loadChat(nextChat.id);
    } else {
        ensureDraftSettings();
        requestRender();
    }
}

function handleSettingsProviderChange() {
    const provider = getProvider(elements.providerSelect.value) || getConfiguredProvider();
    if (!provider) return;

    state.modelSelectionMode = "preset";
    setActiveSettings({
        ...getActiveSettings(),
        provider: provider.id,
        model: provider.default_model || "",
        reasoning_effort: null,
    });
    markSettingsDirty();
    if (provider.supports_browser_tools) {
        scheduleAttachmentWarmup();
    }
}

function handleSettingsModelInput() {
    state.modelSelectionMode = "custom";
    setActiveSettings({
        ...getActiveSettings(),
        model: elements.modelInput.value.trim(),
    });
    markSettingsDirty();
}

function handleSettingsModelSelectChange() {
    const provider = getProvider(elements.providerSelect.value) || getConfiguredProvider();
    if (!provider) return;

    if (elements.modelSelect.value === "__custom__") {
        state.modelSelectionMode = "custom";
        const currentModel = getActiveSettings().model;
        const knownModelIds = new Set((provider.models || []).map((model) => model.id));
        setActiveSettings({
            ...getActiveSettings(),
            model: knownModelIds.has(currentModel) ? "" : currentModel,
        });
        markSettingsDirty();
        requestAnimationFrame(() => {
            if (!elements.modelInput.hidden) {
                elements.modelInput.focus();
            }
        });
        return;
    }

    state.modelSelectionMode = "preset";
    setActiveSettings({
        ...getActiveSettings(),
        model: elements.modelSelect.value,
    });
    markSettingsDirty();
}

function handleSettingsSystemPromptInput() {
    setActiveSettings({
        ...getActiveSettings(),
        system_prompt: elements.systemPromptInput.value,
    });
    markSettingsDirty();
}

function handleSettingsTemperatureInput() {
    const value = elements.temperatureInput.value.trim();
    setActiveSettings({
        ...getActiveSettings(),
        temperature: value === "" ? null : Number(value),
    });
    markSettingsDirty();
}

function handleSettingsReasoningInput() {
    setActiveSettings({
        ...getActiveSettings(),
        reasoning_effort: elements.reasoningSelect.value || null,
    });
    markSettingsDirty();
}

elements.input.addEventListener("input", syncControls);
elements.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
    }
});

elements.composer.addEventListener("submit", async (event) => {
    event.preventDefault();
    await sendMessage();
});

elements.newChatButton.addEventListener("click", () => {
    startNewChat();
});

elements.renameChatButton.addEventListener("click", async () => {
    await renameCurrentChat();
});

elements.deleteChatButton.addEventListener("click", async () => {
    await deleteCurrentChat();
});

elements.logoutButton.addEventListener("click", async () => {
    await logout();
});

elements.adminButton.addEventListener("click", () => {
    window.location.href = "/admin";
});

elements.chatList.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-chat-id]");
    if (!button) return;
    await loadChat(button.dataset.chatId);
});

elements.attachmentInput.addEventListener("change", async (event) => {
    const { files } = event.target;
    if (!files?.length) return;
    try {
        await addAttachments(files);
    } catch (error) {
        setAttachmentStatus(
            error instanceof Error ? error.message : "Unable to add those files.",
            { busy: false, ready: false },
        );
    } finally {
        elements.attachmentInput.value = "";
    }
});

elements.attachmentSecurity.addEventListener("change", async (event) => {
    const toggle = event.target.closest("[data-attachment-action='toggle-persist']");
    if (!toggle) return;
    try {
        await togglePersistentAttachments(toggle.checked);
    } catch (error) {
        toggle.checked = state.attachmentSecurity.persistentOptIn;
        setAttachmentStatus(
            error instanceof Error ? error.message : "Unable to update encrypted storage.",
            { busy: false, ready: false },
        );
    }
});

elements.attachmentSecurity.addEventListener("click", async (event) => {
    if (event.target.closest("[data-attachment-action='toggle-persist']")) {
        return;
    }

    const unlockButton = event.target.closest("[data-attachment-action='unlock-stored']");
    if (unlockButton) {
        try {
            await unlockPersistedAttachments({ create: false, enableRemember: false });
        } catch (error) {
            setAttachmentStatus(
                error instanceof Error ? error.message : "Unable to unlock remembered files.",
                { busy: false, ready: false },
            );
        }
        return;
    }

    const lockButton = event.target.closest("[data-attachment-action='lock-stored']");
    if (lockButton) {
        try {
            await lockPersistedAttachments();
        } catch (error) {
            setAttachmentStatus(
                error instanceof Error ? error.message : "Unable to lock remembered files.",
                { busy: false, ready: false },
            );
        }
        return;
    }

    const clearStoredButton = event.target.closest("[data-attachment-action='clear-stored']");
    if (clearStoredButton) {
        try {
            await clearStoredAttachments();
        } catch (error) {
            setAttachmentStatus(
                error instanceof Error ? error.message : "Unable to clear stored files.",
                { busy: false, ready: false },
            );
        }
    }
});

elements.attachmentTray.addEventListener("click", async (event) => {
    const clearButton = event.target.closest("[data-attachment-action='clear-all']");
    if (clearButton) {
        try {
            await resetAttachments({ clearStorage: true });
        } catch (error) {
            setAttachmentStatus(
                error instanceof Error ? error.message : "Unable to clear Workspace files.",
                { busy: false, ready: false },
            );
        }
        return;
    }

    const button = event.target.closest("[data-attachment-id]");
    if (!button) return;
    try {
        await removeAttachment(button.dataset.attachmentId);
    } catch (error) {
        setAttachmentStatus(
            error instanceof Error ? error.message : "Unable to update local files.",
            { busy: false, ready: false },
        );
    }
});

elements.sidebarToggleButton.addEventListener("click", () => {
    elements.appLayout.classList.toggle("sidebar-open");
});

elements.settingsToggleButton.addEventListener("click", () => {
    ensureDraftSettings();
    elements.appLayout.classList.add("settings-open");
    syncSettingsControls();
});

elements.settingsCloseButton.addEventListener("click", () => {
    closeSettingsDrawer();
});

elements.sidebarBackdrop.addEventListener("click", () => {
    closeSidebar();
});

elements.settingsBackdrop.addEventListener("click", () => {
    closeSettingsDrawer();
});

window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
        closeSidebar();
        closeSettingsDrawer();
    }
});

elements.thread.addEventListener("click", async (event) => {
    const button = event.target.closest(".copy-code");
    if (!button) return;

    try {
        await navigator.clipboard.writeText(button.dataset.copyText || "");
        const originalLabel = button.textContent;
        button.textContent = "Copied";
        window.setTimeout(() => {
            button.textContent = originalLabel;
        }, 1200);
    } catch (error) {
        button.textContent = "Failed";
        window.setTimeout(() => {
            button.textContent = "Copy";
        }, 1200);
    }
});

elements.providerSelect.addEventListener("change", handleSettingsProviderChange);
elements.modelSelect.addEventListener("change", handleSettingsModelSelectChange);
elements.modelInput.addEventListener("input", handleSettingsModelInput);
elements.systemPromptInput.addEventListener("input", handleSettingsSystemPromptInput);
elements.temperatureInput.addEventListener("input", handleSettingsTemperatureInput);
elements.reasoningSelect.addEventListener("change", handleSettingsReasoningInput);

elements.settingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
        await saveCurrentChatSettings();
    } catch (error) {
        setSettingsFeedback(
            error instanceof Error ? error.message : "Unable to save chat settings.",
            "danger",
        );
    }
});

elements.saveDefaultsButton.addEventListener("click", async () => {
    try {
        await saveDefaults();
    } catch (error) {
        setSettingsFeedback(
            error instanceof Error ? error.message : "Unable to save defaults.",
            "danger",
        );
    }
});

window.addEventListener("beforeunload", () => {
    if (pyodideBridge) {
        pyodideBridge.destroy();
    }
});

async function init() {
    await fetchCurrentUser();
    await fetchProviders();
    await fetchPreferences();
    await fetchChats();
    if (!state.attachmentSupport.supported) {
        setAttachmentStatus("This browser does not support local file analysis.", { ready: false });
    } else {
        await restorePersistedAttachments();
    }
    startNewChat();
    resizeInput();
    scheduleAttachmentWarmup();
}

init().catch(() => {
    window.location.href = "/login";
});
