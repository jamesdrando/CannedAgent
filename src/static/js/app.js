const md = window.markdownit({
    html: false,
    breaks: true,
    linkify: true,
    typographer: true,
});

const elements = {
    appLayout: document.querySelector(".app-layout"),
    sidebarBackdrop: document.getElementById("sidebar-backdrop"),
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
    sidebarToggleButton: document.getElementById("sidebar-toggle-button"),
    logoutButton: document.getElementById("logout-button"),
    composer: document.getElementById("composer"),
    input: document.getElementById("input-box"),
    sendButton: document.getElementById("send-button"),
};

const state = {
    user: null,
    chats: [],
    currentChatId: null,
    messages: [],
    streaming: false,
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
    if (!state.chats.length) {
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

    elements.chatList.innerHTML = groups.map((group) => `
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
    const hasMessages = state.messages.length > 0;
    elements.emptyState.hidden = Boolean(state.currentChatId && hasMessages);
    elements.thread.hidden = !state.currentChatId || !hasMessages;

    if (!state.currentChatId || !hasMessages) {
        elements.thread.innerHTML = "";
        return;
    }

    elements.thread.innerHTML = state.messages.map(renderMessage).join("");
    enhanceCodeBlocks();
    elements.thread.scrollTop = elements.thread.scrollHeight;
}

function syncControls() {
    elements.sendButton.disabled = state.streaming || !elements.input.value.trim();
    elements.renameChatButton.disabled = !state.currentChatId || state.streaming;
    elements.deleteChatButton.disabled = !state.currentChatId || state.streaming;
    elements.newChatButton.disabled = state.streaming;
    resizeInput();
}

function renderUser() {
    if (!state.user) return;
    elements.userName.textContent = state.user.username;
    elements.userEmail.textContent = state.user.email;
    elements.userAvatar.textContent = state.user.username[0].toUpperCase();
}

function renderTitle() {
    const activeChat = state.chats.find((chat) => chat.id === state.currentChatId);
    elements.title.textContent = activeChat ? activeChat.title : "New chat";
}

function render() {
    renderQueued = false;
    renderUser();
    renderTitle();
    renderChatList();
    renderThread();
    syncControls();
}

async function fetchCurrentUser() {
    const payload = await api("/api/auth/me");
    state.user = payload;
}

async function fetchChats() {
    const payload = await api("/api/chats");
    state.chats = payload.chats;
}

async function loadChat(chatId) {
    const payload = await api(`/api/chats/${chatId}`);
    state.currentChatId = payload.id;
    state.messages = payload.messages;
    closeSidebar();
    requestRender();
}

async function createChat() {
    const chat = await api("/api/chats", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
    });
    state.chats.unshift(chat);
    state.currentChatId = chat.id;
    state.messages = [];
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

async function sendMessage() {
    const content = elements.input.value.trim();
    if (!content || state.streaming) return;

    if (!state.currentChatId) {
        await createChat();
    }

    const chatId = state.currentChatId;
    const assistantMessage = { role: "assistant", content: "" };

    state.messages.push({ role: "user", content });
    state.messages.push(assistantMessage);
    state.streaming = true;
    elements.input.value = "";
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

    const currentTitle = state.chats.find((chat) => chat.id === state.currentChatId)?.title || "";
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

    const activeChat = state.chats.find((chat) => chat.id === state.currentChatId);
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
    await fetchChats();

    const nextChat = state.chats.find((chat) => chat.id !== deletedChatId);
    if (nextChat) {
        await loadChat(nextChat.id);
    } else {
        requestRender();
    }
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

elements.newChatButton.addEventListener("click", async () => {
    await createChat();
    closeSidebar();
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

elements.sidebarBackdrop.addEventListener("click", () => {
    closeSidebar();
});

window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
        closeSidebar();
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

async function init() {
    await fetchCurrentUser();
    await fetchChats();
    if (state.chats.length) {
        await loadChat(state.chats[0].id);
    } else {
        requestRender();
    }
    resizeInput();
}

init().catch(() => {
    window.location.href = "/login";
});
