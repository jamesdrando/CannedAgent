const md = window.markdownit({
    html: false,
    breaks: true,
    linkify: true,
    typographer: true,
});

const DRAFT_CHAT_ID = "__draft__";

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
    newChatButton: document.getElementById("new-chat-button"),
    renameChatButton: document.getElementById("rename-chat-button"),
    deleteChatButton: document.getElementById("delete-chat-button"),
    settingsToggleButton: document.getElementById("settings-toggle-button"),
    sidebarToggleButton: document.getElementById("sidebar-toggle-button"),
    logoutButton: document.getElementById("logout-button"),
    composer: document.getElementById("composer"),
    input: document.getElementById("input-box"),
    sendButton: document.getElementById("send-button"),
    settingsForm: document.getElementById("settings-form"),
    settingsCloseButton: document.getElementById("settings-close-button"),
    settingsTargetTitle: document.getElementById("settings-target-title"),
    settingsTargetDetail: document.getElementById("settings-target-detail"),
    providerSelect: document.getElementById("settings-provider"),
    modelInput: document.getElementById("settings-model"),
    modelSuggestions: document.getElementById("model-suggestions"),
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
    settingsDirty: false,
    settingsSaving: false,
    settingsFeedback: "",
    settingsFeedbackTone: "muted",
};

let renderQueued = false;

function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(render);
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
        provider: provider?.id || "gemini",
        model: provider?.default_model || "",
        system_prompt: "You are an AI agent. Respond using GitHub-flavored Markdown.",
        temperature: null,
        reasoning_effort: null,
    };
    const activeProvider = provider || getProvider(base.provider) || getConfiguredProvider();
    const temperature = input.temperature;
    const reasoningEffort = input.reasoning_effort || null;

    return {
        provider: activeProvider?.id || base.provider,
        model: (input.model || activeProvider?.default_model || base.model || "").trim(),
        system_prompt: (input.system_prompt || base.system_prompt || "").trim()
            || "You are an AI agent. Respond using GitHub-flavored Markdown.",
        temperature: typeof temperature === "number" && !Number.isNaN(temperature)
            ? temperature
            : null,
        reasoning_effort: activeProvider?.reasoning_efforts?.includes(reasoningEffort)
            ? reasoningEffort
            : null,
    };
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

function renderMessage(message) {
    const body = message.role === "assistant"
        ? (
            message.content.trim()
                ? md.render(message.content)
                : '<div class="message-placeholder">Streaming reply<span></span><span></span><span></span></div>'
        )
        : `<p>${formatUserText(message.content)}</p>`;

    return `
        <article class="message message-${message.role}">
            <div class="message-body ${message.role}-body">${body}</div>
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

function renderUser() {
    if (!state.user) return;
    elements.userName.textContent = state.user.username;
    elements.userEmail.textContent = state.user.email;
    elements.userAvatar.textContent = state.user.username[0].toUpperCase();
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

function renderModelSuggestions(provider) {
    elements.modelSuggestions.innerHTML = (provider?.models || []).map((model) => `
        <option value="${escapeHtml(model.id)}">${escapeHtml(model.label)}</option>
    `).join("");
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
    renderModelSuggestions(provider);

    elements.modelInput.value = settings.model || provider.default_model || "";
    elements.modelInput.placeholder = provider.default_model || "Model ID";
    elements.systemPromptInput.value = settings.system_prompt || "";
    elements.temperatureInput.disabled = !provider.supports_temperature;
    elements.temperatureInput.value = typeof settings.temperature === "number"
        ? String(settings.temperature)
        : "";

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
    const modelCopy = modelCount
        ? `${modelCount} suggested model${modelCount === 1 ? "" : "s"} available.`
        : "Use any valid model id for this provider.";
    elements.settingsHint.textContent = provider.configured
        ? `${provider.label} is ready. ${modelCopy}`
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
    elements.sendButton.disabled = state.streaming || !elements.input.value.trim();
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

async function sendMessage() {
    const content = elements.input.value.trim();
    if (!content || state.streaming) return;

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
    const assistantMessage = { role: "assistant", content: "" };

    state.messages.push({ role: "user", content });
    state.messages.push(assistantMessage);
    state.streaming = true;
    elements.input.value = "";
    state.draftInput = "";
    requestRender();

    let requestSucceeded = false;

    try {
        const response = await fetch(`/api/chats/${chatId}/messages`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ content }),
        });

        if (response.status === 401) {
            window.location.href = "/login";
            return;
        }

        if (!response.ok) {
            throw new Error(await parseError(response));
        }

        if (!response.body) {
            throw new Error("The server returned an empty response body.");
        }

        const reader = response.body
            .pipeThrough(new TextDecoderStream())
            .getReader();

        while (true) {
            const { value, done } = await reader.read();
            if (value) {
                assistantMessage.content += value;
                requestRender();
            }
            if (done) break;
        }

        requestSucceeded = true;
    } catch (error) {
        assistantMessage.content = `### Request failed\n\n${
            error instanceof Error ? error.message : "Unknown error"
        }`;
    } finally {
        state.streaming = false;
        if (requestSucceeded) {
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

    setActiveSettings({
        ...getActiveSettings(),
        provider: provider.id,
        model: provider.default_model || "",
        reasoning_effort: null,
    });
    markSettingsDirty();
}

function handleSettingsModelInput() {
    setActiveSettings({
        ...getActiveSettings(),
        model: elements.modelInput.value.trim(),
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

elements.chatList.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-chat-id]");
    if (!button) return;
    await loadChat(button.dataset.chatId);
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

async function init() {
    await fetchCurrentUser();
    await fetchProviders();
    await fetchPreferences();
    await fetchChats();
    if (state.chats.length) {
        await loadChat(state.chats[0].id);
    } else {
        ensureDraftSettings();
        requestRender();
    }
    resizeInput();
}

init().catch(() => {
    window.location.href = "/login";
});
