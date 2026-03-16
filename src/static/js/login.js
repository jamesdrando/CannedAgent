const form = document.getElementById("login-form");
const identifierInput = document.getElementById("identifier");
const passwordInput = document.getElementById("password");
const errorBox = document.getElementById("login-error");
const button = document.getElementById("login-button");

function setBusy(isBusy) {
    button.disabled = isBusy;
    button.textContent = isBusy ? "Signing in..." : "Sign in";
}

function showError(message) {
    errorBox.hidden = false;
    errorBox.textContent = message;
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

form.addEventListener("submit", async (event) => {
    event.preventDefault();
    errorBox.hidden = true;

    const identifier = identifierInput.value.trim();
    const password = passwordInput.value;
    if (!identifier || !password) {
        showError("Enter both your username/email and password.");
        return;
    }

    setBusy(true);

    try {
        const response = await fetch("/api/auth/login", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ identifier, password }),
        });

        if (!response.ok) {
            throw new Error(await parseError(response));
        }

        window.location.href = "/app";
    } catch (error) {
        showError(error instanceof Error ? error.message : "Login failed.");
    } finally {
        setBusy(false);
    }
});
