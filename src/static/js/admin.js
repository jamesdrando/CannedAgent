const elements = {
    subtitle: document.getElementById("admin-subtitle"),
    summaryUsers: document.getElementById("summary-users"),
    summaryRequests: document.getElementById("summary-requests"),
    summaryTokens: document.getElementById("summary-tokens"),
    summaryProvider: document.getElementById("summary-provider"),
    createForm: document.getElementById("create-user-form"),
    createUsername: document.getElementById("create-username"),
    createEmail: document.getElementById("create-email"),
    createPassword: document.getElementById("create-password"),
    createButton: document.getElementById("create-user-button"),
    createFeedback: document.getElementById("create-user-feedback"),
    usersTableBody: document.getElementById("users-table-body"),
    usageTableBody: document.getElementById("usage-table-body"),
};

let overview = null;

function escapeHtml(value) {
    return String(value || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function formatNumber(value) {
    return new Intl.NumberFormat().format(Number(value || 0));
}

function formatDate(value) {
    if (!value) return "Never";
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return "Unknown";
    return parsed.toLocaleString([], {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
    });
}

async function parseError(response) {
    const text = await response.text();
    if (!text.trim()) return `Request failed with status ${response.status}`;
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
    if (response.status === 403) {
        window.location.href = "/app";
        throw new Error("Admin access required.");
    }
    if (!response.ok) {
        throw new Error(await parseError(response));
    }
    return response.json();
}

function setFeedback(message, tone = "muted") {
    elements.createFeedback.textContent = message;
    elements.createFeedback.dataset.tone = tone;
}

function renderSummary() {
    const users = overview?.users || [];
    const usage = overview?.usage || {};
    const topProvider = (usage.providers || [])[0];
    elements.subtitle.textContent = `Primary admin: ${overview?.primary_admin_email || "unknown"}`;
    elements.summaryUsers.textContent = formatNumber(users.length);
    elements.summaryRequests.textContent = formatNumber(usage.request_count);
    elements.summaryTokens.textContent = formatNumber(usage.total_tokens);
    elements.summaryProvider.textContent = topProvider ? topProvider.provider : "None";
}

function renderUsers() {
    const users = overview?.users || [];
    elements.usersTableBody.innerHTML = users.map((user) => `
        <tr>
            <td>
                <strong>${escapeHtml(user.username)}</strong>
                <span>${escapeHtml(user.email)}</span>
            </td>
            <td>
                <span class="status-badge" data-tone="${user.is_admin ? "admin" : "muted"}">
                    ${user.is_admin ? "Primary admin" : (user.is_active ? "Active" : "Inactive")}
                </span>
            </td>
            <td>${formatNumber(user.chat_count)}</td>
            <td>${formatNumber(user.message_count)}</td>
            <td>${formatNumber(user.usage?.total_tokens)}</td>
            <td>${escapeHtml(formatDate(user.last_login_at))}</td>
            <td>
                ${user.is_admin ? "" : `
                    <button
                        type="button"
                        class="user-action"
                        data-user-id="${escapeHtml(user.id)}"
                        data-user-email="${escapeHtml(user.email)}"
                        data-tone="danger"
                    >
                        Remove
                    </button>
                `}
            </td>
        </tr>
    `).join("");
}

function renderUsage() {
    const recentEvents = overview?.usage?.recent_events || [];
    elements.usageTableBody.innerHTML = recentEvents.length
        ? recentEvents.map((event) => `
            <tr>
                <td>
                    <strong>${escapeHtml(event.username)}</strong>
                    <span>${escapeHtml(event.email)}</span>
                </td>
                <td>${escapeHtml(event.provider)}</td>
                <td>${escapeHtml(event.model)}</td>
                <td>${formatNumber(event.total_tokens)}</td>
                <td>${escapeHtml(formatDate(event.created_at))}</td>
            </tr>
        `).join("")
        : `
            <tr>
                <td colspan="5">
                    <span>No token usage has been recorded yet.</span>
                </td>
            </tr>
        `;
}

function render() {
    renderSummary();
    renderUsers();
    renderUsage();
}

async function refreshOverview() {
    overview = await api("/api/admin/overview");
    render();
}

async function createUser(event) {
    event.preventDefault();
    elements.createButton.disabled = true;
    setFeedback("Creating user...", "muted");
    try {
        await api("/api/admin/users", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                username: elements.createUsername.value,
                email: elements.createEmail.value,
                password: elements.createPassword.value,
            }),
        });
        elements.createForm.reset();
        setFeedback("User created.", "success");
        await refreshOverview();
    } catch (error) {
        setFeedback(error instanceof Error ? error.message : "Unable to create user.", "danger");
    } finally {
        elements.createButton.disabled = false;
    }
}

async function removeUser(event) {
    const button = event.target.closest("[data-user-id]");
    if (!button) return;
    const email = button.dataset.userEmail || "this user";
    const confirmed = window.confirm(`Remove ${email}? This deletes that user, their chats, and recorded usage.`);
    if (!confirmed) return;
    try {
        await api(`/api/admin/users/${button.dataset.userId}`, {
            method: "DELETE",
        });
        await refreshOverview();
    } catch (error) {
        window.alert(error instanceof Error ? error.message : "Unable to remove user.");
    }
}

elements.createForm.addEventListener("submit", createUser);
elements.usersTableBody.addEventListener("click", removeUser);

refreshOverview().catch((error) => {
    setFeedback(error instanceof Error ? error.message : "Unable to load admin data.", "danger");
});
